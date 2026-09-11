import { defaultHigherTimeframe } from "@/lib/analysis";
import {
  DEFAULT_WARMUP_BARS,
  breakdownBy,
  checkIntegrity,
  computeMetrics,
  runBacktest,
  scoreBand,
  type BacktestAssumptions,
  type BacktestSetupResult,
  type DataCoverage,
  type IntegrityIssue,
} from "@/lib/backtesting";
import { prisma } from "@/lib/db/prisma";
import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";
import { mapWithConcurrency } from "@/lib/scanner";
import { loadCandleHistory, MAX_HISTORY_CANDLES } from "@/services/candle-history";
import { findMarketByPairId } from "@/services/markets";

/**
 * Backtest orchestration.
 *
 * Loads history, checks it, replays it through the same engine everything else
 * uses, and measures the result. No analysis happens here — `runBacktest` calls
 * `runAnalysis`, and this file only decides which data to hand it.
 */

/**
 * Candles of real history read before the requested range.
 *
 * The engine needs roughly 260 bars before it can say anything, and those bars
 * must come from before the period under test. This is charged separately from
 * the evaluation window, which is now paged rather than sharing one request.
 */
export const BACKTEST_PREROLL_BARS = DEFAULT_WARMUP_BARS;

/**
 * Ceiling on the evaluated range.
 *
 * Was 740 — one exchange page minus the warmup. Pagination removes that
 * constraint, so the limit is now about how much work one local machine should
 * do in a single request rather than about the provider's page size.
 */
export const MAX_EVALUATED_CANDLES = MAX_HISTORY_CANDLES - BACKTEST_PREROLL_BARS;

/** Markets in one run. Bounded so a single request cannot page forever. */
export const MAX_MARKETS_PER_RUN = 10;

/** Markets loaded at once, so a multi-market run is not a burst. */
const MARKET_CONCURRENCY = 3;

export interface RunBacktestInput {
  userId: string;
  tradingPairIds: string[];
  timeframes: Timeframe[];
  startDate: Date;
  endDate: Date;
  feeRate?: number;
  slippageRate?: number;
}

export interface MarketDataset {
  symbol: string;
  timeframe: Timeframe;
  coverage: DataCoverage;
  issues: IntegrityIssue[];
  /** Set when the dataset was unusable and the market was skipped entirely. */
  failure: string | null;
}

export async function executeBacktest(input: RunBacktestInput) {
  const run = await prisma.backtestRun.create({
    data: {
      userId: input.userId,
      tradingPairId: input.tradingPairIds[0],
      timeframe: input.timeframes[0],
      startDate: input.startDate,
      endDate: input.endDate,
      status: "RUNNING",
    },
    select: { id: true },
  });

  try {
    const jobs = input.tradingPairIds.flatMap((pairId) =>
      input.timeframes.map((timeframe) => ({ pairId, timeframe })),
    );

    const outcomes = await mapWithConcurrency(jobs, MARKET_CONCURRENCY, (job) =>
      replayOne(job.pairId, job.timeframe, input),
    );

    const setups = outcomes.flatMap((outcome) => outcome.setups);
    const datasets = outcomes.map((outcome) => outcome.dataset);
    const assumptions = outcomes.find((o) => o.assumptions)?.assumptions ?? null;

    const metrics = computeMetrics(setups);

    await persist(run.id, setups, metrics);

    return {
      runId: run.id,
      metrics,
      setups,
      datasets,
      assumptions,
      // Ordered deterministically inside `breakdownBy`, so two identical runs
      // produce identical tables.
      bySymbol: breakdownBy(setups, (s) => s.symbol),
      byTimeframe: breakdownBy(setups, (s) => s.timeframe),
      byScoreBand: breakdownBy(setups, (s) => scoreBand(s.setupScore)),
      byTargetKind: breakdownBy(setups, (s) =>
        s.entryRiskRewardIsSynthetic ? "unmeasured reward" : "structural target",
      ),
      // Research only. A regime that did well in one sample is a description
      // of that sample, and nothing here selects parameters from it.
      byRegime: breakdownBy(setups, (s) => s.regimeDirection),
      byVolatility: breakdownBy(setups, (s) => s.regimeVolatility),
    };
  } catch (err) {
    await prisma.backtestRun
      .update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          errorMessage: err instanceof Error ? err.message : "Unknown error",
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);

    throw err;
  }
}

interface ReplayOutcome {
  setups: BacktestSetupResult[];
  dataset: MarketDataset;
  assumptions: BacktestAssumptions | null;
}

/**
 * One market on one timeframe.
 *
 * A market whose data is corrupt is skipped and reported rather than replayed:
 * a duplicated or out-of-order candle breaks the assumption every loop in the
 * runner makes, and the resulting numbers would be indistinguishable from real
 * ones.
 */
async function replayOne(
  pairId: string,
  timeframe: Timeframe,
  input: RunBacktestInput,
): Promise<ReplayOutcome> {
  const market = await findMarketByPairId(pairId);

  const emptyCoverage = (): DataCoverage => ({
    requestedFrom: input.startDate.getTime(),
    requestedTo: input.endDate.getTime(),
    actualFrom: null,
    actualTo: null,
    warmupBars: 0,
    evaluatedBars: 0,
    candlesUsed: 0,
    requests: 0,
    incomplete: true,
    notes: [],
  });

  if (!market) {
    return {
      setups: [],
      assumptions: null,
      dataset: {
        symbol: pairId,
        timeframe,
        coverage: emptyCoverage(),
        issues: [],
        failure: "Unknown trading pair.",
      },
    };
  }

  const step = TIMEFRAME_MS[timeframe];
  const rangeStart = input.startDate.getTime();
  const rangeEnd = input.endDate.getTime();

  const history = await loadCandleHistory({
    exchangeSymbol: market.exchangeSymbol,
    timeframe,
    from: rangeStart - BACKTEST_PREROLL_BARS * step,
    to: rangeEnd,
  });

  const integrity = checkIntegrity(history.candles, timeframe);

  const coverage: DataCoverage = {
    requestedFrom: rangeStart,
    requestedTo: rangeEnd,
    actualFrom: history.candles[0]?.openTime ?? null,
    actualTo: history.candles.at(-1)?.openTime ?? null,
    warmupBars: 0,
    evaluatedBars: 0,
    candlesUsed: history.candles.length,
    requests: history.requests,
    incomplete: history.incomplete || integrity.missingCandles > 0,
    notes: [
      ...history.notes,
      ...(integrity.missingCandles > 0
        ? [`${integrity.missingCandles} candles are missing from the exchange's own history.`]
        : []),
    ],
  };

  if (integrity.fatal) {
    return {
      setups: [],
      assumptions: null,
      dataset: {
        symbol: market.exchangeSymbol,
        timeframe,
        coverage,
        issues: integrity.issues,
        failure:
          "The historical data failed an integrity check, so this market was not replayed. Replaying it would have produced numbers indistinguishable from correct ones.",
      },
    };
  }

  // The higher timeframe is loaded independently and reaches much further back
  // for the same number of candles, so its warmup costs nothing against the
  // entry timeframe's budget. The runner slices it per bar, so no candle that
  // had not closed yet can reach a decision.
  const higherTimeframe = defaultHigherTimeframe(timeframe);
  const higher = higherTimeframe
    ? await loadCandleHistory({
        exchangeSymbol: market.exchangeSymbol,
        timeframe: higherTimeframe,
        from: rangeStart - BACKTEST_PREROLL_BARS * TIMEFRAME_MS[higherTimeframe],
        to: rangeEnd,
      }).catch(() => null)
    : null;

  const report = runBacktest(history.candles, {
    evaluateFrom: rangeStart,
    symbol: market.exchangeSymbol,
    timeframe,
    feeRate: input.feeRate,
    slippageRate: input.slippageRate,
    ...(higherTimeframe && higher && higher.candles.length > 0
      ? {
          mtf: {
            candles: higher.candles,
            lowerTimeframe: timeframe,
            higherTimeframe,
          },
        }
      : {}),
  });

  return {
    setups: report.setups,
    assumptions: report.assumptions,
    dataset: {
      symbol: market.exchangeSymbol,
      timeframe,
      coverage: {
        ...coverage,
        warmupBars: report.warmupBars,
        evaluatedBars: report.evaluatedBars,
      },
      issues: integrity.issues,
      failure: null,
    },
  };
}

async function persist(
  runId: string,
  setups: BacktestSetupResult[],
  metrics: ReturnType<typeof computeMetrics>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (setups.length > 0) {
      await tx.backtestSetup.createMany({
        data: setups.map((setup) => ({
          backtestRunId: runId,
          triggeredAt: new Date(setup.triggeredAt),
          entry: setup.entry.toString(),
          stopLoss: setup.stopLoss.toString(),
          takeProfits: setup.takeProfits,
          outcome: setup.outcome,
          realizedRR: setup.realizedRR?.toString() ?? null,
          exitTime: setup.exitTime ? new Date(setup.exitTime) : null,
          exitPrice: setup.exitPrice?.toString() ?? null,
        })),
      });
    }

    await tx.backtestRun.update({
      where: { id: runId },
      data: {
        status: "COMPLETED",
        numSetups: metrics.totalSetups,
        winRate: metrics.winRate.toFixed(2),
        avgRealizedRR: metrics.averageR.toFixed(2),
        // Stored in R, which is the unit the strategy is actually measured in.
        maxDrawdownPct: metrics.maxDrawdownR.toFixed(2),
        completedAt: new Date(),
      },
    });
  });
}

/**
 * Candles a date range implies.
 *
 * Counts the bars that will be *evaluated*. The pre-roll the engine needs in
 * front of them is charged separately.
 */
export function estimateCandles(from: Date, to: Date, timeframe: Timeframe): number {
  return Math.ceil((to.getTime() - from.getTime()) / TIMEFRAME_MS[timeframe]);
}
