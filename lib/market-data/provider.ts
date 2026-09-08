/**
 * MarketDataProvider abstraction — all chart/analysis code depends on this
 * interface only, never on a concrete exchange SDK directly. Swapping or adding
 * a provider must not require touching the engine or the UI.
 *
 * Spot markets only. There is deliberately no method here capable of placing an
 * order, and no provider implementation ever receives trading-scoped API keys.
 */

export type Timeframe = "M15" | "H1" | "H4" | "D1" | "W1";

export const TIMEFRAMES: Timeframe[] = ["M15", "H1", "H4", "D1", "W1"];

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  M15: "15m",
  H1: "1h",
  H4: "4h",
  D1: "1D",
  W1: "1W",
};

/** Duration of one candle, in milliseconds. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M15: 15 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
  W1: 7 * 24 * 60 * 60_000,
};

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && (TIMEFRAMES as string[]).includes(value);
}

export interface Market {
  /** Exchange-native symbol, e.g. "BTCUSDT". */
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

export interface Ticker {
  symbol: string;
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  /** Epoch milliseconds the quote was produced. */
  at: number;
}

export interface Candle {
  /** Epoch milliseconds of the candle's open. */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Epoch milliseconds of the candle's close. */
  closeTime: number;
}

export interface CandleRange {
  /** Epoch milliseconds, inclusive. */
  from?: number;
  /** Epoch milliseconds, inclusive. */
  to?: number;
}

export interface MarketDataProvider {
  /** All spot markets the provider currently lists as tradable. */
  getMarkets(): Promise<Market[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit?: number,
    range?: CandleRange,
  ): Promise<Candle[]>;
  /** Total traded volume over the last `lookback` candles of the timeframe. */
  getVolume(symbol: string, timeframe: Timeframe, lookback?: number): Promise<number>;
}

// --- Typed errors -----------------------------------------------------------

export type MarketDataErrorCode =
  | "RATE_LIMITED"
  | "UNKNOWN_SYMBOL"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "BAD_RESPONSE";

export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: MarketDataErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MarketDataError";
    this.code = code;
    this.status = options.status;
    this.retryable =
      options.retryable ??
      (code === "RATE_LIMITED" || code === "NETWORK_ERROR" || code === "TIMEOUT");
  }

  /** HTTP status to surface from an API route for this failure. */
  get httpStatus(): number {
    switch (this.code) {
      case "UNKNOWN_SYMBOL":
        return 404;
      case "RATE_LIMITED":
        return 429;
      case "TIMEOUT":
        return 504;
      default:
        return 502;
    }
  }
}
