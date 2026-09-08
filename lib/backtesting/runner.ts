import { runAnalysis } from "@/lib/analysis";
import type { Candle } from "@/lib/market-data/provider";

export type SetupOutcome = "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "SL_HIT" | "NO_HIT" | "STILL_OPEN";

export interface BacktestSetupResult {
  /** Open time of the candle the setup triggered on. */
  triggeredAt: number;
  entry: number;
  stopLoss: number;
  takeProfits: { label: string; level: number; rr: number }[];
  outcome: SetupOutcome;
  /** Realised reward in multiples of the risk taken. Negative for a loss. */
  realizedRR: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  setupScore: number;
}

export interface BacktestOptions {
  /**
   * Candles the engine needs before it can say anything — the EMA 200 alone
   * needs 200, and the swing series needs room beyond that.
   */
  warmupBars?: number;
  /** Give up on a trade that has neither hit a target nor a stop by then. */
  maxHoldBars?: number;
}

export const DEFAULT_WARMUP_BARS = 260;
export const DEFAULT_MAX_HOLD_BARS = 120;

/**
 * Bar-by-bar replay of the live analysis engine.
 *
 * The integrity guarantee is structural: on every bar the engine is handed
 * `candles.slice(0, i + 1)` and nothing else, so it cannot see a single candle
 * the trader would not have had. Trade simulation then reads only candles
 * *after* the trigger bar. There is no code path where a future price reaches
 * the signal.
 *
 * ## How a trade is managed
 *
 * A backtest has to commit to an exit rule, and the choice changes the results
 * more than any indicator setting does:
 *
 *  - Exiting at TP1 always would make every winner a small one and understate
 *    the method.
 *  - Holding for TP3 always would overstate it just as badly.
 *
 * So this uses a standard, stated rule: the stop moves to breakeven once TP1
 * trades, and to TP1 once TP2 trades. The trade ends at whichever comes first —
 * the (possibly moved) stop, TP3, or `maxHoldBars`.
 *
 * ## Where ties are resolved against the strategy
 *
 * When a single candle's range covers both the stop and a target, the order
 * they were touched in is unknowable from OHLC data. This always assumes the
 * stop came first. That makes results pessimistic rather than flattering,
 * which is the only safe direction for a tool people use to decide with money.
 */
export function runBacktest(
  candles: Candle[],
  options: BacktestOptions = {},
): BacktestSetupResult[] {
  const warmup = options.warmupBars ?? DEFAULT_WARMUP_BARS;
  const maxHold = options.maxHoldBars ?? DEFAULT_MAX_HOLD_BARS;

  const results: BacktestSetupResult[] = [];
  if (candles.length <= warmup + 1) return results;

  let i = warmup;

  while (i < candles.length - 1) {
    // The engine sees history up to and including bar i, and nothing after it.
    const visible = candles.slice(0, i + 1);
    const analysis = runAnalysis(visible);

    if (analysis.status !== "POTENTIAL_SETUP" || !analysis.setup || !analysis.score) {
      i += 1;
      continue;
    }

    const { setup } = analysis;
    const trigger = candles[i];

    // Enter at the close of the triggering bar. A POTENTIAL_SETUP requires
    // price to be inside the entry zone, so the close is a price that was
    // actually available — unlike the middle of the zone, which may not have
    // traded.
    const entry = trigger.close;
    const risk = entry - setup.stopLoss.price;
    if (risk <= 0) {
      i += 1;
      continue;
    }

    const trade = simulateTrade({
      candles,
      startIndex: i + 1,
      entry,
      stopLoss: setup.stopLoss.price,
      takeProfits: setup.takeProfits.map((t) => t.level),
      maxHold,
    });

    results.push({
      triggeredAt: trigger.openTime,
      entry,
      stopLoss: setup.stopLoss.price,
      takeProfits: setup.takeProfits.map((t) => ({
        label: t.label,
        level: t.level,
        rr: t.rr,
      })),
      outcome: trade.outcome,
      realizedRR: trade.exitPrice === null ? null : (trade.exitPrice - entry) / risk,
      exitTime: trade.exitTime,
      exitPrice: trade.exitPrice,
      setupScore: analysis.score.total,
    });

    // One position at a time. Scanning resumes after the trade closed, so a
    // single move cannot be counted as several overlapping wins.
    i = trade.exitIndex !== null ? trade.exitIndex + 1 : candles.length;
  }

  return results;
}

interface SimulateInput {
  candles: Candle[];
  startIndex: number;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  maxHold: number;
}

interface SimulateResult {
  outcome: SetupOutcome;
  exitPrice: number | null;
  exitTime: number | null;
  exitIndex: number | null;
}

function simulateTrade(input: SimulateInput): SimulateResult {
  const { candles, startIndex, entry, stopLoss, takeProfits, maxHold } = input;
  const [tp1, tp2, tp3] = takeProfits;

  let stopLevel = stopLoss;
  let reached = 0;

  const end = Math.min(candles.length, startIndex + maxHold);

  for (let i = startIndex; i < end; i += 1) {
    const candle = candles[i];

    // Stop first, always. Within one candle the sequence is unknowable, and
    // guessing in the strategy's favour is how backtests start lying.
    if (candle.low <= stopLevel) {
      const outcome: SetupOutcome =
        reached === 0 ? "SL_HIT" : reached === 1 ? "TP1_HIT" : "TP2_HIT";
      return { outcome, exitPrice: stopLevel, exitTime: candle.openTime, exitIndex: i };
    }

    if (tp3 !== undefined && candle.high >= tp3) {
      return { outcome: "TP3_HIT", exitPrice: tp3, exitTime: candle.openTime, exitIndex: i };
    }

    if (tp2 !== undefined && reached < 2 && candle.high >= tp2) {
      reached = 2;
      stopLevel = tp1 ?? entry;
      continue;
    }

    if (tp1 !== undefined && reached < 1 && candle.high >= tp1) {
      reached = 1;
      stopLevel = entry;
    }
  }

  const last = candles[end - 1];
  if (!last || end <= startIndex) {
    return { outcome: "STILL_OPEN", exitPrice: null, exitTime: null, exitIndex: null };
  }

  // Two different endings, and conflating them makes the numbers lie.
  //
  //  - The holding limit was reached: a decision to close, so the trade has a
  //    real exit price and a real result.
  //  - The data ran out: the trade never finished. Marking it to the last
  //    candle would book an unrealised position as a loss, which is exactly
  //    how a backtest quietly understates (or flatters) a method.
  const ranOutOfData = end === candles.length && end < startIndex + maxHold;

  if (ranOutOfData) {
    return { outcome: "STILL_OPEN", exitPrice: null, exitTime: null, exitIndex: end - 1 };
  }

  return {
    outcome: "NO_HIT",
    exitPrice: last.close,
    exitTime: last.openTime,
    exitIndex: end - 1,
  };
}
