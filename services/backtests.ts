import { computeMetrics, runBacktest, type BacktestSetupResult } from "@/lib/backtesting";
import { prisma } from "@/lib/db/prisma";
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
    const { candles } = await getCandles({
      pairId: input.tradingPairId,
      exchangeSymbol: input.exchangeSymbol,
      timeframe: input.timeframe,
      limit: MAX_BACKTEST_CANDLES,
      from: input.startDate.getTime(),
      to: input.endDate.getTime(),
    });

    const setups = runBacktest(candles);
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

    return { runId: run.id, metrics, setups, candlesUsed: candles.length };
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

/** Candles a date range implies, used to reject ranges that cannot be served. */
export function estimateCandles(from: Date, to: Date, timeframe: Timeframe): number {
  return Math.ceil((to.getTime() - from.getTime()) / TIMEFRAME_MS[timeframe]);
}

export function loadSetups(setups: BacktestSetupResult[]) {
  return setups;
}
