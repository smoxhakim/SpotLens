import type { Timeframe } from "@/lib/market-data/provider";

/**
 * The assumptions a backtest ran under.
 *
 * Carried on the report rather than living as constants nobody sees, because a
 * result is uninterpretable without them: 1.4R average means one thing at zero
 * fees and something else at a taker fee both ways. Two reports are only
 * comparable if these match.
 */
export interface BacktestAssumptions {
  /** Round-trip taker fee as a fraction of notional, applied twice. */
  feeRate: number;
  /** Slippage as a fraction of price, applied against the trade both ways. */
  slippageRate: number;
  /** What happens when one candle contains both the stop and a target. */
  sameCandlePolicy: SameCandlePolicy;
  entryPolicy: EntryPolicy;
  warmupBars: number;
  maxHoldBars: number;
  confirmationEnabled: boolean;
  mtfEnabled: boolean;
}

/**
 * When a candle's range covers both the stop and a target, OHLC cannot say
 * which was touched first.
 *
 * `STOP_FIRST` assumes the worse of the two. It is the default and the only
 * safe default: guessing in the strategy's favour is how a backtest starts
 * flattering the thing it is supposed to be testing.
 */
export type SameCandlePolicy = "STOP_FIRST" | "TARGET_FIRST";

/**
 * Where a simulated fill happens.
 *
 * `SIGNAL_CLOSE` fills at the close of the candle that produced the signal.
 * That is what the engine's own rules imply — POTENTIAL_SETUP requires price
 * to be inside the entry zone, so the close is a price that actually traded —
 * and it means the signal candle can never also be the exit candle, because
 * management begins on the following bar.
 *
 * `NEXT_OPEN` fills at the open of the following candle, which is what someone
 * reacting to a closed candle would realistically get.
 */
export type EntryPolicy = "SIGNAL_CLOSE" | "NEXT_OPEN";

/**
 * Defaults.
 *
 * The fee is a generic spot taker rate, not a claim about anyone's tier — it is
 * configurable precisely because it varies. Slippage defaults to zero so the
 * base case stays honest about what is modelled: switching it on is a choice
 * the reader can see on the report.
 */
export const DEFAULT_FEE_RATE = 0.001; // 0.1% per side
export const DEFAULT_SLIPPAGE_RATE = 0;
export const DEFAULT_SAME_CANDLE_POLICY: SameCandlePolicy = "STOP_FIRST";
export const DEFAULT_ENTRY_POLICY: EntryPolicy = "SIGNAL_CLOSE";

/** How the evaluation window was actually covered by data. */
export interface DataCoverage {
  requestedFrom: number;
  requestedTo: number;
  /** Open time of the first candle actually obtained, warmup included. */
  actualFrom: number | null;
  actualTo: number | null;
  warmupBars: number;
  evaluatedBars: number;
  candlesUsed: number;
  /** Requests made to the provider, so the cost of a run is visible. */
  requests: number;
  /** True when the provider could not supply the whole requested window. */
  incomplete: boolean;
  /** Plain-language reasons the dataset falls short, if it does. */
  notes: string[];
}
