import { analyzeMultiTimeframe, runAnalysis } from "@/lib/analysis";
import type { Candle, Timeframe } from "@/lib/market-data/provider";

import {
  DEFAULT_ENTRY_POLICY,
  DEFAULT_FEE_RATE,
  DEFAULT_SAME_CANDLE_POLICY,
  DEFAULT_SLIPPAGE_RATE,
  type BacktestAssumptions,
  type EntryPolicy,
  type SameCandlePolicy,
} from "./types";

export type SetupOutcome = "TP1_HIT" | "TP2_HIT" | "TP3_HIT" | "SL_HIT" | "NO_HIT" | "STILL_OPEN";

export interface BacktestSetupResult {
  /** Open time of the candle the setup triggered on. */
  triggeredAt: number;
  /** Open time of the candle the fill happened on. */
  entryTime: number;
  entry: number;
  stopLoss: number;
  takeProfits: { label: string; level: number; rr: number }[];
  outcome: SetupOutcome;
  /** Realised reward in multiples of the risk taken. Negative for a loss. */
  realizedRR: number | null;
  /** The same figure before fees and slippage, so their cost is visible. */
  grossRealizedRR: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  setupScore: number;

  // --- context, so a result can be explained without re-running anything ---
  symbol: string | null;
  timeframe: Timeframe | null;
  /** Candles held, from the fill to the exit. Null while unresolved. */
  barsHeld: number | null;
  holdingMs: number | null;
  /** Reward-to-risk the engine measured at entry. */
  entryRiskReward: number;
  /** Phase A's qualifier: a ratio measured to an R-multiple is not evidence. */
  entryRiskRewardIsSynthetic: boolean;
  trend: string;
  mtfAgreement: string | null;
  confirmationStatus: string | null;
  /**
   * Best and worst the trade ever went, in R, while it was open. Null when the
   * trade never opened or the data ran out before it could be measured.
   */
  maxFavourableR: number | null;
  maxAdverseR: number | null;
}

/**
 * Higher-timeframe context for the replay.
 *
 * Supplying it is what makes a backtest comparable to a multi-timeframe live
 * run: the same counter-trend veto, the same score adjustment, the same
 * PULLBACK_IN_UPTREND classification. Leaving it out reproduces the
 * single-timeframe endpoint instead. Either is a real configuration; what is
 * not acceptable is believing you tested one and having tested the other.
 */
export interface BacktestMtfInput {
  /** The higher timeframe's candles, covering the replay with history before it. */
  candles: Candle[];
  lowerTimeframe: Timeframe;
  higherTimeframe: Timeframe;
}

export interface BacktestOptions {
  /**
   * Candles the engine needs before it can say anything — the EMA 200 alone
   * needs 200, and the swing series needs room beyond that.
   */
  warmupBars?: number;
  /** Give up on a trade that has neither hit a target nor a stop by then. */
  maxHoldBars?: number;
  /**
   * Open time of the first candle the run was actually asked to evaluate.
   *
   * Everything before it is pre-roll: real history the engine reads so that its
   * indicators are warm, but bars no setup is reported from. Without this the
   * warmup was taken out of the requested range itself, so asking for a year
   * from January evaluated from roughly March and said nothing about it.
   */
  evaluateFrom?: number;
  /** Higher-timeframe context, folded in exactly as a live MTF run would. */
  mtf?: BacktestMtfInput;

  /** Labels carried onto every result, for breakdowns. Never used in a decision. */
  symbol?: string;
  timeframe?: Timeframe;

  /** Round-trip fee as a fraction of notional, charged on entry and on exit. */
  feeRate?: number;
  /** Slippage as a fraction of price, always applied against the trade. */
  slippageRate?: number;
  /** Which of the stop and the target is assumed to have traded first. */
  sameCandlePolicy?: SameCandlePolicy;
  /** Where the simulated fill happens. */
  entryPolicy?: EntryPolicy;
}

export interface BacktestReport {
  setups: BacktestSetupResult[];
  /** Candles read as history before the first evaluated bar. */
  warmupBars: number;
  /**
   * Candles inside the evaluation window — the bars this run was asked about.
   * The final candle is excluded, since a trade entered on it has nowhere to
   * go.
   */
  evaluatedBars: number;
  /** Every candle supplied, warmup and evaluation window together. */
  candlesUsed: number;
  /** Open time of the first and last evaluated bar; null when none were. */
  evaluatedFrom: number | null;
  evaluatedTo: number | null;
  /** The higher timeframe folded in, or null for a single-timeframe replay. */
  higherTimeframe: Timeframe | null;
  /** Everything that was assumed, so the numbers can be interpreted. */
  assumptions: BacktestAssumptions;
  /**
   * Setups the engine produced that never became a simulated trade, and why.
   * Reported rather than dropped: "the engine found 40 setups and 6 were not
   * tradeable under these assumptions" is a different statement from "the
   * engine found 34".
   */
  skipped: { at: number; reason: string }[];
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
 * ## Warmup is history, not the range you asked about
 *
 * The first `warmupBars` candles exist so the EMA 200 and the swing series are
 * defined; nothing is reported from them. They must therefore come from
 * *before* the requested range. `evaluateFrom` marks where the requested range
 * begins, and the report states `warmupBars`, `evaluatedBars` and
 * `candlesUsed` separately so a run can never again look like it covered a
 * period it merely used as pre-roll.
 *
 * ## The higher timeframe cannot be allowed to see ahead either
 *
 * A lower-timeframe bar closing at T may only be judged against higher
 * timeframe candles that had also closed by T. The higher timeframe's *current*
 * candle is still forming at that moment, and its eventual shape is exactly the
 * information a trader did not have. Every bar therefore takes a fresh slice of
 * the higher timeframe bounded by `closeTime <= T`.
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
export function runBacktest(candles: Candle[], options: BacktestOptions = {}): BacktestReport {
  const warmup = options.warmupBars ?? DEFAULT_WARMUP_BARS;
  const maxHold = options.maxHoldBars ?? DEFAULT_MAX_HOLD_BARS;
  const higherTimeframe = options.mtf?.higherTimeframe ?? null;

  const assumptions: BacktestAssumptions = {
    feeRate: options.feeRate ?? DEFAULT_FEE_RATE,
    slippageRate: options.slippageRate ?? DEFAULT_SLIPPAGE_RATE,
    sameCandlePolicy: options.sameCandlePolicy ?? DEFAULT_SAME_CANDLE_POLICY,
    entryPolicy: options.entryPolicy ?? DEFAULT_ENTRY_POLICY,
    warmupBars: warmup,
    maxHoldBars: maxHold,
    // Both are properties of the engine rather than switches: confirmation is
    // always part of the status gate, and MTF applies when candles are given.
    confirmationEnabled: true,
    mtfEnabled: higherTimeframe !== null,
  };

  // Evaluation starts at the requested range when there is enough pre-roll in
  // front of it, and otherwise as soon as the engine is warm. Taking the later
  // of the two is what stops a short pre-roll from quietly reporting setups
  // built on half-formed indicators.
  const requestedStart =
    options.evaluateFrom === undefined ? 0 : firstIndexAtOrAfter(candles, options.evaluateFrom);
  const start = Math.max(warmup, requestedStart);

  // The last candle can never trigger: a trade entered on it has no candle to
  // play out in.
  const lastEvaluable = candles.length - 1;

  const results: BacktestSetupResult[] = [];
  const skipped: { at: number; reason: string }[] = [];

  const report = (): BacktestReport => ({
    setups: results,
    warmupBars: Math.min(start, candles.length),
    evaluatedBars: Math.max(0, lastEvaluable - start),
    candlesUsed: candles.length,
    evaluatedFrom: start < lastEvaluable ? candles[start].openTime : null,
    evaluatedTo: start < lastEvaluable ? candles[lastEvaluable - 1].openTime : null,
    higherTimeframe,
    assumptions,
    skipped,
  });

  if (start >= lastEvaluable) return report();

  let i = start;

  while (i < lastEvaluable) {
    // The engine sees history up to and including bar i, and nothing after it.
    const visible = candles.slice(0, i + 1);
    const analysis = runAnalysis(visible, mtfOptionsFor(options.mtf, visible, candles[i]));

    if (analysis.status !== "POTENTIAL_SETUP" || !analysis.setup || !analysis.score) {
      i += 1;
      continue;
    }

    const { setup } = analysis;
    const trigger = candles[i];

    const fill = fillFor(candles, i, assumptions);
    if (!fill) {
      skipped.push({
        at: trigger.openTime,
        reason: "No candle follows the signal, so the fill could not be simulated.",
      });
      i += 1;
      continue;
    }

    const risk = fill.price - setup.stopLoss.price;
    if (risk <= 0) {
      // The fill landed at or below the stop — possible under NEXT_OPEN when
      // the market gapped down overnight. Not a tradeable setup, and counting
      // it either way would be an invention.
      skipped.push({
        at: trigger.openTime,
        reason:
          "The simulated fill was at or below the stop loss, so there was no risk to measure.",
      });
      i += 1;
      continue;
    }

    const trade = simulateTrade({
      candles,
      startIndex: fill.index + 1,
      entry: fill.price,
      stopLoss: setup.stopLoss.price,
      takeProfits: setup.takeProfits.map((t) => t.level),
      maxHold,
      sameCandlePolicy: assumptions.sameCandlePolicy,
    });

    const exitCandle = trade.exitIndex === null ? null : candles[trade.exitIndex];

    const gross = trade.exitPrice === null ? null : (trade.exitPrice - fill.price) / risk;
    const net =
      trade.exitPrice === null
        ? null
        : (applyCosts(trade.exitPrice, fill.price, assumptions) - fill.price) / risk;

    results.push({
      triggeredAt: trigger.openTime,
      entryTime: fill.candle.openTime,
      entry: fill.price,
      stopLoss: setup.stopLoss.price,
      takeProfits: setup.takeProfits.map((t) => ({
        label: t.label,
        level: t.level,
        rr: t.rr,
      })),
      outcome: trade.outcome,
      realizedRR: net,
      grossRealizedRR: gross,
      exitTime: trade.exitTime,
      exitPrice: trade.exitPrice,
      setupScore: analysis.score.total,

      symbol: options.symbol ?? null,
      timeframe: options.timeframe ?? null,
      barsHeld: trade.exitIndex === null ? null : trade.exitIndex - fill.index,
      holdingMs: exitCandle === null ? null : exitCandle.openTime - fill.candle.openTime,
      entryRiskReward: setup.riskReward.ratio,
      entryRiskRewardIsSynthetic: setup.riskReward.isSynthetic,
      trend: analysis.read.trend.trend,
      mtfAgreement: analysis.mtf?.agreement ?? null,
      confirmationStatus: analysis.confirmation?.status ?? null,
      maxFavourableR: trade.maxFavourable === null ? null : trade.maxFavourable / risk,
      maxAdverseR: trade.maxAdverse === null ? null : trade.maxAdverse / risk,
    });

    // One position at a time. Scanning resumes after the trade closed, so a
    // single move cannot be counted as several overlapping wins.
    i = trade.exitIndex !== null ? trade.exitIndex + 1 : candles.length;
  }

  return report();
}

/**
 * Index of the first candle opening at or after `openTime`, or the length of
 * the series when every candle predates it.
 */
function firstIndexAtOrAfter(candles: Candle[], openTime: number): number {
  let low = 0;
  let high = candles.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid].openTime < openTime) low = mid + 1;
    else high = mid;
  }

  return low;
}

/**
 * The higher-timeframe read as it stood when `current` closed.
 *
 * Returns nothing when no higher-timeframe candle had closed yet, which leaves
 * the run single-timeframe for those bars rather than handing the trend
 * detector a series too short to mean anything.
 */
function mtfOptionsFor(
  input: BacktestMtfInput | undefined,
  visible: Candle[],
  current: Candle,
): { mtf?: ReturnType<typeof analyzeMultiTimeframe> } {
  if (!input) return {};

  // Only candles that had already closed. A higher-timeframe candle still
  // forming at this moment closes later, and its final shape is precisely the
  // information the trader did not have.
  const closed = input.candles.slice(0, countClosedBy(input.candles, current.closeTime));
  if (closed.length === 0) return {};

  return {
    mtf: analyzeMultiTimeframe({
      lowerCandles: visible,
      higherCandles: closed,
      lowerTimeframe: input.lowerTimeframe,
      higherTimeframe: input.higherTimeframe,
    }),
  };
}

/** How many candles of a series had closed at or before `closeTime`. */
function countClosedBy(candles: Candle[], closeTime: number): number {
  let low = 0;
  let high = candles.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (candles[mid].closeTime <= closeTime) low = mid + 1;
    else high = mid;
  }

  return low;
}

/**
 * Where the simulated fill happens, and at what price.
 *
 * `SIGNAL_CLOSE` fills at the close of the signal candle. That is the engine's
 * own premise — POTENTIAL_SETUP requires price to be inside the entry zone, so
 * the close is a price that demonstrably traded — and management then starts on
 * the following bar, which is why the signal candle can never also be the exit
 * candle.
 *
 * `NEXT_OPEN` fills at the open of the following candle, which is what someone
 * reacting to a closed candle would actually get.
 */
function fillFor(
  candles: Candle[],
  signalIndex: number,
  assumptions: BacktestAssumptions,
): { index: number; candle: Candle; price: number } | null {
  if (assumptions.entryPolicy === "NEXT_OPEN") {
    const next = candles[signalIndex + 1];
    if (!next) return null;
    return {
      index: signalIndex + 1,
      candle: next,
      price: withEntrySlippage(next.open, assumptions),
    };
  }

  const candle = candles[signalIndex];
  return {
    index: signalIndex,
    candle,
    price: withEntrySlippage(candle.close, assumptions),
  };
}

/** Slippage always works against the trade: a long fills a little higher. */
function withEntrySlippage(price: number, assumptions: BacktestAssumptions): number {
  return price * (1 + assumptions.slippageRate);
}

/**
 * The exit price after costs, expressed as an equivalent price so the caller
 * can keep dividing by the same risk.
 *
 * Fees are charged on both legs and slippage is applied against the exit, so a
 * round trip costs `2 × fee + slippage` of notional whatever the outcome. That
 * is why a "breakeven" stop is not actually breakeven once costs exist — a
 * detail a backtest without fees hides entirely.
 */
function applyCosts(
  exitPrice: number,
  entryPrice: number,
  assumptions: BacktestAssumptions,
): number {
  const exitWithSlippage = exitPrice * (1 - assumptions.slippageRate);
  const fees = (entryPrice + exitWithSlippage) * assumptions.feeRate;
  return exitWithSlippage - fees;
}

interface SimulateInput {
  candles: Candle[];
  startIndex: number;
  entry: number;
  stopLoss: number;
  takeProfits: number[];
  maxHold: number;
  sameCandlePolicy: SameCandlePolicy;
}

interface SimulateResult {
  outcome: SetupOutcome;
  exitPrice: number | null;
  exitTime: number | null;
  exitIndex: number | null;
  /** Best and worst the position ever went, in price, while it was open. */
  maxFavourable: number | null;
  maxAdverse: number | null;
}

function simulateTrade(input: SimulateInput): SimulateResult {
  const { candles, startIndex, entry, stopLoss, takeProfits, maxHold } = input;
  const [tp1, tp2, tp3] = takeProfits;

  let stopLevel = stopLoss;
  let reached = 0;

  // Excursions are tracked as the trade runs, because they cannot be
  // reconstructed afterwards from an exit price alone.
  let maxFavourable: number | null = null;
  let maxAdverse: number | null = null;

  const end = Math.min(candles.length, startIndex + maxHold);

  const finish = (
    result: Omit<SimulateResult, "maxFavourable" | "maxAdverse">,
  ): SimulateResult => ({
    ...result,
    maxFavourable,
    maxAdverse,
  });

  for (let i = startIndex; i < end; i += 1) {
    const candle = candles[i];

    maxFavourable = Math.max(maxFavourable ?? 0, candle.high - entry);
    maxAdverse = Math.min(maxAdverse ?? 0, candle.low - entry);

    const hitsStop = candle.low <= stopLevel;
    const target = tp3 !== undefined && candle.high >= tp3 ? tp3 : null;

    // When one candle covers both, OHLC cannot say which traded first. The
    // policy decides, and the default assumes the worse of the two — guessing
    // in the strategy's favour is how backtests start lying.
    if (hitsStop && (input.sameCandlePolicy === "STOP_FIRST" || target === null)) {
      const outcome: SetupOutcome =
        reached === 0 ? "SL_HIT" : reached === 1 ? "TP1_HIT" : "TP2_HIT";
      return finish({ outcome, exitPrice: stopLevel, exitTime: candle.openTime, exitIndex: i });
    }

    if (target !== null) {
      return finish({
        outcome: "TP3_HIT",
        exitPrice: target,
        exitTime: candle.openTime,
        exitIndex: i,
      });
    }

    if (hitsStop) {
      const outcome: SetupOutcome =
        reached === 0 ? "SL_HIT" : reached === 1 ? "TP1_HIT" : "TP2_HIT";
      return finish({ outcome, exitPrice: stopLevel, exitTime: candle.openTime, exitIndex: i });
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
    return finish({ outcome: "STILL_OPEN", exitPrice: null, exitTime: null, exitIndex: null });
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
    return finish({ outcome: "STILL_OPEN", exitPrice: null, exitTime: null, exitIndex: end - 1 });
  }

  return finish({
    outcome: "NO_HIT",
    exitPrice: last.close,
    exitTime: last.openTime,
    exitIndex: end - 1,
  });
}
