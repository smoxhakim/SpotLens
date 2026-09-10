import {
  analyzeMultiTimeframe,
  defaultHigherTimeframe,
  runAnalysis,
  type AnalysisResult,
} from "@/lib/analysis";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import type { Candle, Timeframe } from "@/lib/market-data/provider";
import {
  DEFAULT_SCAN_TIMEFRAMES,
  closedCandlesOnly,
  eventsForOutcome,
  failureEvent,
  mapWithConcurrency,
  rankResults,
  withRetries,
  type ClassifiedFailure,
  type ScannerEvent,
} from "@/lib/scanner";
import type { MarketSummary } from "@/types/market";
import { getCandles } from "@/services/candles";
import { listMarkets } from "@/services/markets";
import { trackSetup } from "@/services/setups";

/**
 * The scan pipeline.
 *
 * The only part of the scanner that talks to the network or the database.
 * Everything it decides — when to run, what to retry, how to rank, which events
 * to emit — is imported from `lib/scanner`, and the analysis itself is the same
 * `runAnalysis` the manual page and the backtester call. There is no scanner
 * strategy, because there is only one strategy.
 */

/** Enough history for the EMA 200 with room for the swing series. */
const CANDLE_LIMIT = 500;

/** Markets analysed at once. Ninety analyses at once would be a burst. */
export const DEFAULT_MAX_CONCURRENCY = 4;

export interface ScanOptions {
  timeframes?: Timeframe[];
  maxConcurrency?: number;
  /** Whose setups this scan updates. Single-user app: the only account. */
  userId: string;
  triggeredBy?: "SCHEDULE" | "MANUAL";
  /** Injectable clock so a scan can be replayed against fixed candles. */
  now?: number;
  signal?: AbortSignal;
  /** Narrow the universe. Used by tests; production scans the whole list. */
  markets?: MarketSummary[];
}

export interface MarketScanOutcome {
  symbol: string;
  tradingPairId: string;
  timeframe: Timeframe;
  ok: boolean;
  analysisStatus: AnalysisResult["status"] | null;
  score: number | null;
  riskReward: number | null;
  riskRewardIsSynthetic: boolean | null;
  analysedAtCandle: number | null;
  setupId: string | null;
  lifecycleStatus: string | null;
  failure: ClassifiedFailure | null;
  attempts: number;
  durationMs: number;
}

export interface ScanSummary {
  runId: string | null;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  timeframes: Timeframe[];
  marketCount: number;
  analysed: number;
  succeeded: number;
  failed: number;
  potentialSetups: number;
  waiting: number;
  highRisk: number;
  avoided: number;
  setupsCreated: number;
  stateChanges: number;
  invalidations: number;
  durationMs: number;
  events: ScannerEvent[];
  /** Every market, ranked. Losers included — a scan is mostly no-trades. */
  results: MarketScanOutcome[];
}

/**
 * Runs one pass over the market universe.
 *
 * Failures are isolated per market and per timeframe: an exchange hiccup on one
 * symbol leaves the other forty-four analysed, and the run is reported PARTIAL
 * rather than thrown away. A run only fails outright when every market failed.
 */
export async function runScan(options: ScanOptions): Promise<ScanSummary> {
  const startedAt = Date.now();
  const timeframes = options.timeframes ?? DEFAULT_SCAN_TIMEFRAMES;
  const concurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const now = options.now ?? Date.now();

  const markets = options.markets ?? (await listMarkets());

  const runId = await createRun(timeframes, markets.length, options.triggeredBy ?? "SCHEDULE");

  // One flat list of (market × timeframe) so the concurrency ceiling applies to
  // the whole pass rather than to each timeframe separately.
  const jobs = timeframes.flatMap((timeframe) => markets.map((market) => ({ market, timeframe })));

  const outcomes = await mapWithConcurrency(jobs, concurrency, async ({ market, timeframe }) => {
    if (options.signal?.aborted) {
      return abortedOutcome(market, timeframe);
    }
    return scanOne(market, timeframe, now, options);
  });

  const events = outcomes.flatMap((outcome) => outcome.events);
  const results = outcomes.map((outcome) => outcome.result);
  const summary = summarise(results, events, timeframes, markets.length, Date.now() - startedAt);

  await finishRun(runId, summary, results);

  return { ...summary, runId, results: rankResults(results) };
}

interface OneOutcome {
  result: MarketScanOutcome;
  events: ScannerEvent[];
}

/**
 * One market on one timeframe.
 *
 * The forming candle is dropped before the engine sees anything, so every
 * decision rests on candles that have finished. That is also what makes a
 * repeated scan idempotent: inside the same candle the input is identical, so
 * the verdict is identical and the lifecycle writes nothing the second time.
 */
async function scanOne(
  market: MarketSummary,
  timeframe: Timeframe,
  now: number,
  options: ScanOptions,
): Promise<OneOutcome> {
  const started = Date.now();

  const attempt = await withRetries(
    async () => {
      const { candles } = await getCandles({
        pairId: market.pairId,
        exchangeSymbol: market.exchangeSymbol,
        timeframe,
        limit: CANDLE_LIMIT,
      });

      const closed = closedCandlesOnly(candles, now);
      if (closed.length === 0) {
        throw new Error("No closed candles are available for this market and timeframe.");
      }

      const mtf = await higherTimeframeContext(market, timeframe, closed, now);

      // The same engine the manual page and the backtester call. Every candle
      // here has closed, so `lastCandleIsForming` is false by construction.
      return {
        closed,
        result: runAnalysis(closed, { ...(mtf ? { mtf } : {}), lastCandleIsForming: false }),
      };
    },
    { signal: options.signal },
  );

  if (!attempt.value) {
    const failure = attempt.failure ?? {
      category: "UNKNOWN" as const,
      message: "Unknown failure.",
      retryable: false,
    };

    return {
      result: {
        symbol: market.exchangeSymbol,
        tradingPairId: market.pairId,
        timeframe,
        ok: false,
        analysisStatus: null,
        score: null,
        riskReward: null,
        riskRewardIsSynthetic: null,
        analysedAtCandle: null,
        setupId: null,
        lifecycleStatus: null,
        failure,
        attempts: attempt.attempts,
        durationMs: Date.now() - started,
      },
      events: [
        failureEvent({
          symbol: market.exchangeSymbol,
          timeframe,
          category: failure.category,
          message: failure.message,
        }),
      ],
    };
  }

  const { closed, result } = attempt.value;

  // Phase D owns identity and deduplication. The scanner calls it and does not
  // second-guess it — that is the whole reason repeated scans stay quiet.
  const outcome = await trackSetup({
    userId: options.userId,
    tradingPairId: market.pairId,
    timeframe,
    result,
  });

  const events = eventsForOutcome({
    outcome,
    symbol: market.exchangeSymbol,
    timeframe,
    detail: result.statusReason,
  });

  return {
    result: {
      symbol: market.exchangeSymbol,
      tradingPairId: market.pairId,
      timeframe,
      ok: true,
      analysisStatus: result.status,
      score: result.score?.total ?? null,
      riskReward: result.setup?.riskReward.ratio ?? null,
      riskRewardIsSynthetic: result.setup?.riskReward.isSynthetic ?? null,
      analysedAtCandle: closed.at(-1)?.openTime ?? null,
      setupId: outcome.setupId,
      lifecycleStatus: outcome.status,
      failure: null,
      attempts: attempt.attempts,
      durationMs: Date.now() - started,
    },
    events,
  };
}

/**
 * The higher-timeframe read, on closed candles only.
 *
 * A failure here is not fatal: the analysis still runs single-timeframe, the
 * same as the `/api/analysis/run` endpoint does. Losing the higher timeframe
 * makes a run less informed, not wrong.
 */
async function higherTimeframeContext(
  market: MarketSummary,
  timeframe: Timeframe,
  lower: Candle[],
  now: number,
) {
  const higherTimeframe = defaultHigherTimeframe(timeframe);
  if (!higherTimeframe) return null;

  try {
    const { candles } = await getCandles({
      pairId: market.pairId,
      exchangeSymbol: market.exchangeSymbol,
      timeframe: higherTimeframe,
      limit: CANDLE_LIMIT,
    });

    const closed = closedCandlesOnly(candles, now);
    if (closed.length === 0) return null;

    return analyzeMultiTimeframe({
      lowerCandles: lower,
      higherCandles: closed,
      lowerTimeframe: timeframe,
      higherTimeframe,
    });
  } catch {
    return null;
  }
}

function abortedOutcome(market: MarketSummary, timeframe: Timeframe): OneOutcome {
  return {
    result: {
      symbol: market.exchangeSymbol,
      tradingPairId: market.pairId,
      timeframe,
      ok: false,
      analysisStatus: null,
      score: null,
      riskReward: null,
      riskRewardIsSynthetic: null,
      analysedAtCandle: null,
      setupId: null,
      lifecycleStatus: null,
      failure: { category: "UNKNOWN", message: "The scan was stopped.", retryable: false },
      attempts: 0,
      durationMs: 0,
    },
    events: [],
  };
}

function summarise(
  results: MarketScanOutcome[],
  events: ScannerEvent[],
  timeframes: Timeframe[],
  marketCount: number,
  durationMs: number,
): Omit<ScanSummary, "runId" | "results"> {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  const count = (status: AnalysisResult["status"]) =>
    results.filter((r) => r.analysisStatus === status).length;

  return {
    status: failed === 0 ? "COMPLETED" : succeeded === 0 ? "FAILED" : "PARTIAL",
    timeframes,
    marketCount,
    analysed: results.length,
    succeeded,
    failed,
    potentialSetups: count("POTENTIAL_SETUP"),
    waiting: count("WAIT_FOR_CONFIRMATION"),
    highRisk: count("HIGH_RISK"),
    avoided: count("AVOID"),
    setupsCreated: events.filter((e) => e.type === "SETUP_CREATED").length,
    stateChanges: events.filter((e) => e.type === "SETUP_STATE_CHANGED").length,
    invalidations: events.filter((e) => e.type === "SETUP_INVALIDATED").length,
    durationMs,
    events,
  };
}

async function createRun(
  timeframes: Timeframe[],
  marketCount: number,
  triggeredBy: string,
): Promise<string | null> {
  if (!isDatabaseConfigured) return null;

  try {
    const run = await prisma.scannerRun.create({
      data: { timeframes, marketCount, triggeredBy, status: "RUNNING" },
      select: { id: true },
    });
    return run.id;
  } catch {
    // A scan that cannot record itself is still worth running.
    return null;
  }
}

async function finishRun(
  runId: string | null,
  summary: Omit<ScanSummary, "runId" | "results">,
  results: MarketScanOutcome[],
): Promise<void> {
  if (!runId || !isDatabaseConfigured) return;

  try {
    await prisma.$transaction([
      prisma.scannerResult.createMany({
        data: results.map((r) => ({
          scannerRunId: runId,
          tradingPairId: r.tradingPairId,
          timeframe: r.timeframe,
          status: r.ok ? ("OK" as const) : ("FAILED" as const),
          analysisStatus: r.analysisStatus,
          score: r.score,
          riskReward: r.riskReward,
          riskRewardIsSynthetic: r.riskRewardIsSynthetic,
          analysedAtCandle: r.analysedAtCandle,
          trackedSetupId: r.setupId,
          lifecycleStatus: r.lifecycleStatus as never,
          failureCategory: r.failure?.category,
          failureMessage: r.failure?.message,
          attempts: r.attempts,
          durationMs: r.durationMs,
        })),
      }),
      prisma.scannerRun.update({
        where: { id: runId },
        data: {
          completedAt: new Date(),
          status: summary.status,
          analysed: summary.analysed,
          succeeded: summary.succeeded,
          failed: summary.failed,
          potentialSetups: summary.potentialSetups,
          waiting: summary.waiting,
          highRisk: summary.highRisk,
          avoided: summary.avoided,
          setupsCreated: summary.setupsCreated,
          stateChanges: summary.stateChanges,
          invalidations: summary.invalidations,
          durationMs: summary.durationMs,
        },
      }),
    ]);
  } catch {
    // Recording the outcome is best-effort; the analysis already happened.
  }
}

/**
 * The account a headless scan writes setups against.
 *
 * SpotLens is a single-user local application, so "the only account" is the
 * right answer. `SCANNER_USER_EMAIL` overrides it if more than one exists.
 */
export async function resolveScannerUserId(email?: string): Promise<string | null> {
  if (!isDatabaseConfigured) return null;

  const user = email
    ? await prisma.user.findUnique({ where: { email }, select: { id: true } })
    : await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });

  return user?.id ?? null;
}

export async function listScannerRuns(limit: number) {
  const runs = await prisma.scannerRun.findMany({
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  return runs.map((run) => ({
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    status: run.status,
    timeframes: run.timeframes,
    triggeredBy: run.triggeredBy,
    marketCount: run.marketCount,
    analysed: run.analysed,
    succeeded: run.succeeded,
    failed: run.failed,
    potentialSetups: run.potentialSetups,
    waiting: run.waiting,
    highRisk: run.highRisk,
    avoided: run.avoided,
    setupsCreated: run.setupsCreated,
    stateChanges: run.stateChanges,
    invalidations: run.invalidations,
    durationMs: run.durationMs,
  }));
}
