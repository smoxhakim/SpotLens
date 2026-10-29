import {
  analyzeMultiTimeframe,
  assessHigherTimeframe,
  defaultHigherTimeframe,
  runAnalysisWithDiagnostics,
  unavailableHigherTimeframe,
  type AnalysisDiagnostics,
  type AnalysisResult,
} from "@/lib/analysis";
import type { ConfirmationObservation } from "@/lib/confirmation-watch";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import type { Candle, Timeframe } from "@/lib/market-data/provider";
import {
  DEFAULT_SCAN_TIMEFRAMES,
  breakdownOf,
  buildShortlist,
  closedCandlesOnly,
  eventsForOutcome,
  failureEvent,
  mapWithConcurrency,
  rankResults,
  successfulPassWhere,
  HigherTimeframeUnavailableError,
  StaleCandlesError,
  classifyFailure,
  withRetries,
  type ClassifiedFailure,
  type ScannerEvent,
  type Shortlist,
  type TimeframeGateCounts,
} from "@/lib/scanner";
import { classifyRegime } from "@/lib/regime";
import type { MarketSummary } from "@/types/market";
import { getCandles } from "@/services/candles";
import { listMarkets } from "@/services/markets";
import { lifecycleStatusFor, untrackedReasonOf, type UntrackedReason } from "@/lib/setups";
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
  /**
   * Why there is no tracked setup, for this pass's own shortlist and log. Not
   * persisted: `ScannerResult` has no column for it, and no existing one can
   * hold it without misstating another fact. Null on a failed market.
   */
  untrackedReason: UntrackedReason | null;
  /** Context for the shortlist's explanation, as this pass saw it. */
  trend: string | null;
  mtfAgreement: string | null;
  regimeDirection: string | null;
  /**
   * How the engine reached this verdict: the deciding gate and every gate's
   * outcome. Held for this pass's log only — no column stores it. Null on a
   * failed market.
   */
  diagnostics: AnalysisDiagnostics | null;
  failure: ClassifiedFailure | null;
  attempts: number;
  durationMs: number;
}

export interface ScanSummary {
  runId: string | null;
  /**
   * FAILED when every market failed, or when the pass was interrupted (see
   * `interrupted`); PARTIAL when some markets failed on their own; else COMPLETED.
   */
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  /**
   * The pass was stopped (Ctrl-C, SIGTERM, the engine going away) before every
   * market succeeded. Recorded as FAILED: an interrupted pass did not cover the
   * universe, and as PARTIAL it would count as a successful pass — cancelling
   * the next startup catch-up and vouching for setup freshness. Not stored; the
   * stored status says it.
   */
  interrupted: boolean;
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
  /**
   * Per timeframe, the gate that held each analysis back. Counted from the
   * diagnostics above, in memory; not stored.
   */
  breakdown: TimeframeGateCounts[];
  /** Every market, ranked. Losers included — a scan is mostly no-trades. */
  results: MarketScanOutcome[];
  /**
   * The few worth reviewing, from this pass and this pass only.
   *
   * A prioritisation of the results above, built by the same pure function the
   * API and any UI use. The full list stays in `results` and every row is still
   * written to the database — this decides what to put in front of a person,
   * never what to keep.
   */
  shortlist: Shortlist;
  /**
   * What the confirmation engine said about each tracked setup on this pass.
   *
   * Carried out of the scan rather than acted on inside it, for the same reason
   * the scanner emits events instead of sending them: this service knows
   * nothing about Telegram, and `scripts/scanner.ts` is the composition root
   * that knows both halves.
   *
   * One entry per market that has a tracked setup — including the ones where
   * nothing moved, because "nothing moved" is exactly what the watcher needs to
   * see in order to stay quiet about it. Every entry was judged on a closed
   * candle: `closedCandlesOnly` runs before the engine, and `evaluatedAt` is
   * the close time of the candle the engine actually read.
   */
  observations: ConfirmationObservation[];
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
  const observations = outcomes
    .map((outcome) => outcome.observation)
    .filter((observation): observation is ConfirmationObservation => observation !== null);
  // Stopped before every market succeeded: skipped markets, and requests cut off
  // in flight, both fail. A stop that arrived after the last market succeeded
  // interrupted nothing, and the pass keeps its status.
  const interrupted = options.signal?.aborted === true && results.some((r) => !r.ok);
  const summary = summarise(
    results,
    events,
    timeframes,
    markets.length,
    Date.now() - startedAt,
    interrupted,
  );

  await finishRun(runId, summary, results);

  // Built from this pass's own results, in memory, by the same pure function
  // the stored-run path uses. One pass in, one shortlist out — nothing from a
  // previous run can reach it.
  return {
    ...summary,
    runId,
    results: rankResults(results),
    shortlist: buildShortlist(results.map(toShortlistInput)),
    observations,
  };
}

/** One scan outcome, projected onto what the shortlist reads. */
function toShortlistInput(result: MarketScanOutcome) {
  return {
    symbol: result.symbol,
    timeframe: result.timeframe as string,
    analysisStatus: result.analysisStatus,
    score: result.score,
    riskReward: result.riskReward,
    riskRewardIsSynthetic: result.riskRewardIsSynthetic,
    ok: result.ok,
    lifecycleStatus: result.lifecycleStatus,
    trackedSetupId: result.setupId,
    untrackedReason: result.untrackedReason,
    analysedAtCandle: result.analysedAtCandle,
    trend: result.trend,
    mtfAgreement: result.mtfAgreement,
    regimeDirection: result.regimeDirection,
  };
}

interface OneOutcome {
  result: MarketScanOutcome;
  events: ScannerEvent[];
  /** Null when this market has no tracked setup to watch. */
  observation: ConfirmationObservation | null;
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
      const { candles, stale } = await getCandles({
        pairId: market.pairId,
        exchangeSymbol: market.exchangeSymbol,
        timeframe,
        limit: CANDLE_LIMIT,
      });

      // Served from the cache because the exchange failed. Never analysed: a
      // stale read must not count as a fresh pass, create or move a setup, or
      // vouch for one's freshness. Thrown, so it is retried and then recorded
      // as this market's failure rather than mistaken for an empty result.
      if (stale) throw new StaleCandlesError(timeframe);

      const closed = closedCandlesOnly(candles, now);
      if (closed.length === 0) {
        throw new Error("No closed candles are available for this market and timeframe.");
      }

      // Fail closed: a market whose higher timeframe is missing, stale, short
      // or invalid is not analysed at all — never single-timeframe instead.
      const mtf = await higherTimeframeContext(market, timeframe, closed, now);

      // The same engine the manual page and the backtester call. Every candle
      // here has closed, so `lastCandleIsForming` is false by construction. The
      // result is the one `runAnalysis` returns; the diagnostics ride beside it.
      return {
        closed,
        ...runAnalysisWithDiagnostics(closed, {
          ...(mtf ? { mtf } : {}),
          lastCandleIsForming: false,
        }),
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
        untrackedReason: null,
        trend: null,
        mtfAgreement: null,
        regimeDirection: null,
        diagnostics: null,
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
      // A market that could not be analysed produced no confirmation reading.
      // Carrying an empty one would let the watcher record a baseline, or an
      // evidence set, from an analysis that never happened.
      observation: null,
    };
  }

  const { closed, result, diagnostics } = attempt.value;

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
    observation: observationFor(market, timeframe, result, outcome, options.userId),
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
      // Its own field, not a lifecycle state: an untracked candidate was never
      // invalidated. Held for this pass only — no column stores it yet.
      untrackedReason: untrackedReasonOf(
        { setupId: outcome.setupId, cause: outcome.cause ?? null },
        result,
      ),
      // Straight off the analysis this pass just ran. `classifyRegime` reads a
      // finished MarketRead and costs arithmetic, no data — and the engine
      // never receives what it returns, exactly as Phase H established.
      trend: result.read.trend.trend,
      mtfAgreement: result.mtf?.agreement ?? null,
      regimeDirection: classifyRegime(result.read).direction,
      diagnostics,
      failure: null,
      attempts: attempt.attempts,
      durationMs: Date.now() - started,
    },
    events,
  };
}

/**
 * The higher-timeframe read, on closed candles only — or a typed failure.
 *
 * Fail closed. This used to return null on any failure and the market was then
 * analysed single-timeframe, "less informed, not wrong". It could be wrong: the
 * counter-trend veto and the bearish-alignment AVOID both live on the higher
 * timeframe, so a rally inside a higher-timeframe downtrend reached
 * POTENTIAL_SETUP — tracked, confirmed and re-verified for entry-zone alerts —
 * whenever the higher read failed. Now a missing, stale, short or invalid
 * higher timeframe throws `HigherTimeframeUnavailableError`, which `withRetries`
 * retries (when it can pass) and the pass records as this market's failure.
 *
 * Null only for a timeframe with no higher one, which needs none.
 */
async function higherTimeframeContext(
  market: MarketSummary,
  timeframe: Timeframe,
  lower: Candle[],
  now: number,
) {
  const higherTimeframe = defaultHigherTimeframe(timeframe);
  if (!higherTimeframe) return null;

  let read: { candles: Candle[]; stale: boolean };
  try {
    read = await getCandles({
      pairId: market.pairId,
      exchangeSymbol: market.exchangeSymbol,
      timeframe: higherTimeframe,
      limit: CANDLE_LIMIT,
    });
  } catch (err) {
    // Retryable exactly when the underlying fault is.
    throw new HigherTimeframeUnavailableError(
      unavailableHigherTimeframe(higherTimeframe, "UNAVAILABLE"),
      { retryable: classifyFailure(err).retryable },
    );
  }

  const closed = closedCandlesOnly(read.candles, now);
  const shortfall = assessHigherTimeframe({
    candles: closed,
    timeframe: higherTimeframe,
    now,
    servedStale: read.stale,
  });
  if (shortfall) throw new HigherTimeframeUnavailableError(shortfall);

  return analyzeMultiTimeframe({
    lowerCandles: lower,
    higherCandles: closed,
    lowerTimeframe: timeframe,
    higherTimeframe,
  });
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
      untrackedReason: null,
      trend: null,
      mtfAgreement: null,
      regimeDirection: null,
      diagnostics: null,
      failure: { category: "UNKNOWN", message: "The scan was stopped.", retryable: false },
      attempts: 0,
      durationMs: 0,
    },
    events: [],
    observation: null,
  };
}

/**
 * What the confirmation engine said about this setup, as an observation.
 *
 * A projection, not a computation: every field is read off the
 * `ConfirmationResult` the engine produced during `runAnalysis`, and the
 * lifecycle status is the one the lifecycle service just returned. Nothing here
 * decides whether evidence is sufficient — `lib/analysis/confirmation` already
 * did, and re-deciding it would be a second opinion that could drift from the
 * first.
 *
 * Null when there is no tracked setup: the watcher follows setups, never
 * markets, so a reading with no setup to attach to is not an observation of
 * anything.
 */
function observationFor(
  market: MarketSummary,
  timeframe: Timeframe,
  result: AnalysisResult,
  outcome: { setupId: string | null; status: string | null },
  userId: string,
): ConfirmationObservation | null {
  const confirmation = result.confirmation;
  if (!confirmation || !outcome.setupId) return null;

  return {
    trackedSetupId: outcome.setupId,
    userId,
    symbol: market.exchangeSymbol,
    timeframe,
    // `trackSetup` reports a status only when it wrote something. A setup that
    // did not move is the common case and the one the watcher most needs to
    // see — it is how "nothing new here" stays quiet — so the status falls back
    // to the lifecycle's own pure function. For an unchanged setup the two are
    // the same value by construction: NONE is returned precisely when the
    // target state equals the stored one.
    lifecycleStatus:
      (outcome.status as ConfirmationObservation["lifecycleStatus"]) ?? lifecycleStatusFor(result),
    status: confirmation.status,
    signals: confirmation.signals.map((signal) => ({
      type: signal.type,
      signal: signal.signal,
      title: signal.title,
      detail: signal.detail,
    })),
    // The close time of the candle the engine judged. Always a closed one: the
    // scanner drops the forming candle before `runAnalysis` sees it.
    evaluatedAt: confirmation.evaluatedAt,
    // The verdict on the same analysis, so a confirmation message can name it.
    analysisStatus: result.status,
  };
}

function summarise(
  results: MarketScanOutcome[],
  events: ScannerEvent[],
  timeframes: Timeframe[],
  marketCount: number,
  durationMs: number,
  interrupted: boolean,
): Omit<ScanSummary, "runId" | "results" | "shortlist" | "observations"> {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  const count = (status: AnalysisResult["status"]) =>
    results.filter((r) => r.analysisStatus === status).length;

  return {
    status: interrupted
      ? "FAILED"
      : failed === 0
        ? "COMPLETED"
        : succeeded === 0
          ? "FAILED"
          : "PARTIAL",
    interrupted,
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
    breakdown: breakdownOf(results),
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
  summary: Omit<ScanSummary, "runId" | "results" | "shortlist" | "observations">,
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
          trend: r.trend,
          mtfAgreement: r.mtfAgreement,
          regimeDirection: r.regimeDirection,
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
  } catch (err) {
    // Recording the outcome is best-effort; the analysis already happened. It
    // is still said: a pass whose rows were lost otherwise looks exactly like
    // one still running. The run's status handling is unchanged — it stays
    // RUNNING until `closeAbandonedRuns` closes it. Category and sanitised
    // message only, never the raw error.
    const failure = classifyFailure(err);
    console.error(
      `[scanner] results not recorded for run ${runId}: ${failure.category} — ${failure.message}`,
    );
  }
}

/**
 * Why a scan could not choose an owner.
 *
 * The reason travels with the failure because each one needs a different thing
 * from the operator, and "no account found" told them none of it.
 */
export type ScannerUserFailure =
  | { reason: "NO_DATABASE" }
  | { reason: "NO_USERS" }
  | { reason: "CONFIGURED_USER_MISSING"; email: string }
  | { reason: "AMBIGUOUS"; count: number };

export type ScannerUserResult =
  { ok: true; userId: string } | { ok: false; failure: ScannerUserFailure };

/**
 * The account a headless scan writes setups against.
 *
 * This decides who owns every `TrackedSetup`, every `SetupEvent` and every
 * `Notification` a pass produces, which is why it now refuses to guess.
 *
 * It used to fall back to `findFirst({ orderBy: { createdAt: "asc" } })` — the
 * oldest account — whenever `SCANNER_USER_EMAIL` was unset. That is a fine
 * answer for the single-user application this is, and a silent wrong one the
 * moment a second account exists: the scanner tracked setups for one account
 * while Telegram was connected to another, so every notification went to a
 * chat nobody was watching and nothing anywhere said so. It took two
 * investigations to find, because the behaviour was indistinguishable from a
 * broken Telegram integration.
 *
 * So the single-user case still resolves without configuration — requiring a
 * variable to name the only possible answer would be a setup step that
 * prevents nothing — and ambiguity fails closed instead. The rule is that the
 * scanner picks an owner only when there is nothing to pick between.
 */
export async function resolveScannerUser(email?: string): Promise<ScannerUserResult> {
  if (!isDatabaseConfigured) return { ok: false, failure: { reason: "NO_DATABASE" } };

  const configured = email?.trim();

  if (configured) {
    const user = await prisma.user.findUnique({
      where: { email: configured },
      select: { id: true },
    });

    return user
      ? { ok: true, userId: user.id }
      : { ok: false, failure: { reason: "CONFIGURED_USER_MISSING", email: configured } };
  }

  // Two is enough to know the answer is ambiguous; counting the rest would
  // tell us nothing more.
  const users = await prisma.user.findMany({ select: { id: true }, take: 2 });

  if (users.length === 0) return { ok: false, failure: { reason: "NO_USERS" } };
  if (users.length > 1) {
    return { ok: false, failure: { reason: "AMBIGUOUS", count: await prisma.user.count() } };
  }

  return { ok: true, userId: users[0].id };
}

/**
 * What to tell the operator, and what to do about it.
 *
 * Kept beside the resolution so the wording cannot drift from the reason, and
 * deliberately free of anything sensitive: an account's email is what the
 * operator typed into their own configuration, and no connection string,
 * token or password is ever named.
 */
export function describeScannerUserFailure(failure: ScannerUserFailure): string {
  switch (failure.reason) {
    case "NO_DATABASE":
      return "No database is configured. The scanner stores setups, so it needs DATABASE_URL.";
    case "NO_USERS":
      return (
        "No account found. The scanner tracks setups against an owner — create one at " +
        "/register, then run it again."
      );
    case "CONFIGURED_USER_MISSING":
      return (
        `SCANNER_USER_EMAIL is set to ${failure.email}, but no account with that address ` +
        "exists. Check the address, or register it."
      );
    case "AMBIGUOUS":
      return (
        `${failure.count} accounts exist and SCANNER_USER_EMAIL is not set, so there is no ` +
        "way to tell which one this scan belongs to. Every setup, lifecycle event and " +
        "notification it produces is written against one account — including Telegram, which " +
        "is why guessing here once sent a week of notifications to a chat nobody was " +
        "watching. Set SCANNER_USER_EMAIL to the account you want, then run it again."
      );
  }
}

/**
 * How long a RUNNING run is reported as a pass in progress. A pass takes a
 * minute or two; a RUNNING row older than this was almost certainly left by a
 * scanner that was killed. Display only — such a row is closed as FAILED by
 * `closeAbandonedRuns`, on its own, more conservative bound.
 */
export const PASS_IN_PROGRESS_MAX_AGE_MS = 30 * 60_000;

/**
 * The shortlist for one stored pass.
 *
 * Run-scoped by construction: every row comes from a single `scannerRunId`, so
 * a candidate from yesterday cannot appear beside one from this morning. The
 * ranking itself is the same pure function the live scan used — the API, the
 * scanner process and any UI all read one list rather than three that agree
 * today.
 *
 * `runId` omitted means the most recent *successful* pass (COMPLETED or
 * PARTIAL, `successfulPassWhere`). It used to mean the most recent run of any
 * status, so for the minute or two of every pass — its results are written
 * only when it finishes — and after any FAILED or killed one, the page showed
 * an empty list as if nothing were worth reading. A newer pass still running is
 * reported as `passInProgress` instead, so the page can say so. An explicit
 * `runId` is returned as it is, whatever its status.
 */
export async function getShortlist(input: { runId?: string; limit?: number; now?: number } = {}) {
  const run = input.runId
    ? await prisma.scannerRun.findUnique({ where: { id: input.runId } })
    : await prisma.scannerRun.findFirst({
        where: successfulPassWhere(),
        orderBy: { startedAt: "desc" },
      });

  if (!run) return null;

  const now = input.now ?? Date.now();
  const inProgress = input.runId
    ? null
    : await prisma.scannerRun.findFirst({
        where: {
          status: "RUNNING",
          startedAt: {
            gt: new Date(Math.max(run.startedAt.getTime(), now - PASS_IN_PROGRESS_MAX_AGE_MS)),
          },
        },
        orderBy: { startedAt: "desc" },
        select: { startedAt: true },
      });

  const rows = await prisma.scannerResult.findMany({
    where: { scannerRunId: run.id },
    include: { tradingPair: { select: { exchangeSymbol: true } } },
  });

  // Where each referenced setup stands now. A pass ranks what it saw; a setup
  // invalidated or replaced since must not be offered on the strength of it.
  const setupIds = rows.flatMap((row) => (row.trackedSetupId ? [row.trackedSetupId] : []));
  const statusNow = new Map<string, string>(
    setupIds.length === 0
      ? []
      : (
          await prisma.trackedSetup.findMany({
            where: { id: { in: setupIds } },
            select: { id: true, status: true },
          })
        ).map((setup) => [setup.id, setup.status]),
  );

  const shortlist = buildShortlist(
    rows.map((row) => ({
      symbol: row.tradingPair.exchangeSymbol,
      timeframe: row.timeframe as string,
      analysisStatus: row.analysisStatus,
      score: row.score,
      riskReward: row.riskReward === null ? null : Number(row.riskReward),
      riskRewardIsSynthetic: row.riskRewardIsSynthetic,
      ok: row.status === "OK",
      lifecycleStatus: row.lifecycleStatus,
      trackedSetupId: row.trackedSetupId,
      setupStatusNow: row.trackedSetupId ? (statusNow.get(row.trackedSetupId) ?? null) : null,
      analysedAtCandle: row.analysedAtCandle === null ? null : Number(row.analysedAtCandle),
      trend: row.trend,
      mtfAgreement: row.mtfAgreement,
      regimeDirection: row.regimeDirection,
    })),
  );

  return {
    run: {
      id: run.id,
      startedAt: run.startedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      status: run.status,
      timeframes: run.timeframes,
      triggeredBy: run.triggeredBy,
      /// How many markets the pass covered, so a reader can see the breadth the
      /// shortlist was drawn from rather than only the few it kept.
      marketCount: run.marketCount,
    },
    /** A newer pass that has started and not finished, or null. */
    passInProgress: inProgress ? { startedAt: inProgress.startedAt.toISOString() } : null,
    shortlist,
  };
}

/**
 * How old a RUNNING run must be before it is presumed abandoned.
 *
 * Longer than any pass can take: in the worst case every request times out —
 * 15 s, three HTTP attempts, three scanner attempts, two candle fetches per
 * analysis, 90 analyses four at a time — which is about 100 minutes. A live
 * scanner on another machine pointed at the same database (the PID lock is
 * local) is the only owner this process cannot rule out, and no pass of its can
 * be this old.
 */
export const ABANDONED_RUN_AFTER_MS = 3 * 60 * 60_000;

/**
 * Closes runs that a scanner started and never finished — killed mid-pass by a
 * second Ctrl-C, the engine's stop timeout or its crash hook, or `kill -9`.
 * Left alone they stay RUNNING for ever.
 *
 * Called only by the process holding the scanner lock, and only between its own
 * passes, so none of this process's runs is live; the age bound covers anyone
 * else's. Such a run has no results — they are written only when a pass
 * finishes — so FAILED is what it was. `completedAt` is when it was closed:
 * when the process died is not recorded anywhere.
 */
export async function closeAbandonedRuns(now: number = Date.now()): Promise<number> {
  if (!isDatabaseConfigured) return 0;
  const result = await prisma.scannerRun.updateMany({
    where: {
      status: "RUNNING",
      completedAt: null,
      startedAt: { lt: new Date(now - ABANDONED_RUN_AFTER_MS) },
    },
    data: { status: "FAILED", completedAt: new Date(now) },
  });
  return result.count;
}

/**
 * When the most recent successful pass started — what the startup catch-up
 * compares against the latest scan window. COMPLETED or PARTIAL only: a pass in
 * which every market failed is finished but produced nothing, and treating it
 * as "a pass happened" skipped exactly the catch-up it should have caused.
 */
export async function lastSuccessfulPassStartedAt(): Promise<Date | null> {
  const run = await prisma.scannerRun.findFirst({
    where: successfulPassWhere(),
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });
  return run?.startedAt ?? null;
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
