import { defaultHigherTimeframe } from "@/lib/analysis";
import {
  DEFAULT_WARMUP_BARS,
  computeMetrics,
  runBacktest,
  type BacktestSetupResult,
} from "@/lib/backtesting";
import { prisma } from "@/lib/db/prisma";
import { MAX_CANDLES_PER_REQUEST } from "@/lib/market-data/binance";
import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";
import { getCandles } from "@/services/candles";

/**
 * Hard ceiling on candles per run.
 *
 * Backtests execute synchronously rather than through a job queue — the
 * architecture's QStash path is deferred, so a run has to finish inside one
 * request. This cap is what makes that safe; raising it is the point at which
 * the async path becomes necessary rather than optional.
 */
export const MAX_BACKTEST_CANDLES = 1000;

/**
 * Candles of real history fetched *before* the requested range.
 *
 * The engine needs roughly 260 bars before it can say anything, and those bars
 * have to come from before the period under test. Taking them out of the
 * requested range instead — which is what happened until this was added — meant
 * a run asked to cover January to December quietly began evaluating in March
 * and reported nothing about the months it had eaten.
 */
export const BACKTEST_PREROLL_BARS = DEFAULT_WARMUP_BARS;

/**
 * Ceiling on the *evaluated* range, once pre-roll is accounted for.
 *
 * Pre-roll and evaluation window share one provider request, so the range a
 * user may ask for is the request ceiling minus the history the engine needs
 * in front of it. Paginating to lift this is Phase G's job.
 */
export const MAX_EVALUATED_CANDLES = Math.min(
  MAX_BACKTEST_CANDLES,
  MAX_CANDLES_PER_REQUEST - BACKTEST_PREROLL_BARS,
);

export interface RunBacktestInput {
  userId: string;
  tradingPairId: string;
  exchangeSymbol: string;
  timeframe: Timeframe;
  startDate: Date;
  endDate: Date;
}

export async function executeBacktest(input: RunBacktestInput) {
  const run = await prisma.backtestRun.create({
    data: {
      userId: input.userId,
      tradingPairId: input.tradingPairId,
      timeframe: input.timeframe,
      startDate: input.startDate,
      endDate: input.endDate,
      status: "RUNNING",
    },
    select: { id: true },
  });

  try {
    const step = TIMEFRAME_MS[input.timeframe];
    const rangeStart = input.startDate.getTime();
    const rangeEnd = input.endDate.getTime();

    // Fetch from before the requested range so the warmup is history rather
    // than a bite out of the period under test.
    const prerollStart = rangeStart - BACKTEST_PREROLL_BARS * step;
    const requestedBars = Math.ceil((rangeEnd - rangeStart) / step);

    const { candles } = await getCandles({
      pairId: input.tradingPairId,
      exchangeSymbol: input.exchangeSymbol,
      timeframe: input.timeframe,
      limit: Math.min(MAX_CANDLES_PER_REQUEST, BACKTEST_PREROLL_BARS + requestedBars + 1),
      from: prerollStart,
      to: rangeEnd,
    });

    // The higher timeframe is fetched independently and reaches much further
    // back for the same number of candles, so its own warmup costs nothing
    // against the lower timeframe's budget. The runner slices it per bar so no
    // candle that had not closed yet can reach the read.
    const higherTimeframe = defaultHigherTimeframe(input.timeframe);
    const higher = higherTimeframe
      ? await getCandles({
          pairId: input.tradingPairId,
          exchangeSymbol: input.exchangeSymbol,
          timeframe: higherTimeframe,
          limit: MAX_CANDLES_PER_REQUEST,
          from: rangeStart - BACKTEST_PREROLL_BARS * TIMEFRAME_MS[higherTimeframe],
          to: rangeEnd,
        }).catch(() => null)
      : null;

    const report = runBacktest(candles, {
      evaluateFrom: rangeStart,
      ...(higherTimeframe && higher && higher.candles.length > 0
        ? {
            mtf: {
              candles: higher.candles,
              lowerTimeframe: input.timeframe,
              higherTimeframe,
            },
          }
        : {}),
    });

    const setups = report.setups;
    const metrics = computeMetrics(setups);

    await prisma.$transaction(async (tx) => {
      if (setups.length > 0) {
        await tx.backtestSetup.createMany({
          data: setups.map((setup) => ({
            backtestRunId: run.id,
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
        where: { id: run.id },
        data: {
          status: "COMPLETED",
          numSetups: metrics.numSetups,
          winRate: metrics.winRate.toFixed(2),
          avgRealizedRR: metrics.avgRealizedRR.toFixed(2),
          maxDrawdownPct: metrics.maxDrawdownPct.toFixed(2),
          completedAt: new Date(),
        },
      });
    });

    return {
      runId: run.id,
      metrics,
      setups,
      candlesUsed: report.candlesUsed,
      warmupBars: report.warmupBars,
      evaluatedBars: report.evaluatedBars,
      evaluatedFrom: report.evaluatedFrom,
      evaluatedTo: report.evaluatedTo,
      higherTimeframe: report.higherTimeframe,
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

/**
 * Candles a date range implies, used to reject ranges that cannot be served.
 *
 * This counts the bars that will actually be *evaluated*. The pre-roll the
 * engine needs in front of them is charged separately, against
 * `MAX_EVALUATED_CANDLES`.
 */
export function estimateCandles(from: Date, to: Date, timeframe: Timeframe): number {
  return Math.ceil((to.getTime() - from.getTime()) / TIMEFRAME_MS[timeframe]);
}

export function loadSetups(setups: BacktestSetupResult[]) {
  return setups;
}
