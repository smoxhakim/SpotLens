import { closes, latestEma } from "@/lib/indicators";
import type { Candle } from "@/lib/market-data/provider";

import { DEFAULT_SWING_LOOKBACK, readStructure, type StructureRead } from "./structure";

export type Trend = "BULLISH" | "BEARISH" | "SIDEWAYS";

export type EmaAlignment = "BULLISH" | "BEARISH" | "MIXED" | "UNAVAILABLE";

/** Result of one moving-average comparison. */
export type EmaCheck = "ABOVE" | "BELOW" | "LEVEL" | null;

/**
 * Deadband for treating two moving averages as level rather than separated.
 * Strict comparison would read a perfectly flat market as bearish — every
 * "is X above Y" is false when X equals Y — and would flip a verdict on
 * differences far too small to mean anything.
 */
export const EMA_LEVEL_TOLERANCE = 0.001; // 0.1%

export interface EmaRead {
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  price: number;
  alignment: EmaAlignment;
  /** The individual conditions, so the UI can show what did and did not hold. */
  checks: {
    priceVsEma50: EmaCheck;
    ema20VsEma50: EmaCheck;
    ema50VsEma200: EmaCheck;
  };
}

export interface TrendRead {
  trend: Trend;
  /** How much of the evidence agrees: both signals, one, or neither. */
  confidence: "HIGH" | "MEDIUM" | "LOW";
  structure: StructureRead;
  ema: EmaRead;
  /** True when swing structure and EMA alignment point opposite ways. */
  conflict: boolean;
}

/** EMA periods used across the product. */
export const EMA_PERIODS = { fast: 20, medium: 50, slow: 200 } as const;

export function readEmas(candles: Candle[]): EmaRead {
  const series = closes(candles);
  const price = series.at(-1) ?? 0;

  const ema20 = latestEma(series, EMA_PERIODS.fast);
  const ema50 = latestEma(series, EMA_PERIODS.medium);
  const ema200 = latestEma(series, EMA_PERIODS.slow);

  const checks = {
    priceVsEma50: compare(price, ema50),
    ema20VsEma50: compare(ema20, ema50),
    ema50VsEma200: compare(ema50, ema200),
  };

  const known = Object.values(checks).filter((c): c is Exclude<EmaCheck, null> => c !== null);

  let alignment: EmaAlignment = "UNAVAILABLE";
  if (known.length > 0) {
    if (known.every((c) => c === "ABOVE")) alignment = "BULLISH";
    else if (known.every((c) => c === "BELOW")) alignment = "BEARISH";
    else alignment = "MIXED";
  }

  return { ema20, ema50, ema200, price, alignment, checks };
}

/** Compares two levels with a relative deadband, so equal reads as LEVEL. */
function compare(a: number | null, b: number | null): EmaCheck {
  if (a === null || b === null) return null;
  const scale = Math.abs(b);
  if (scale === 0) return a === 0 ? "LEVEL" : a > 0 ? "ABOVE" : "BELOW";
  const diff = (a - b) / scale;
  if (Math.abs(diff) <= EMA_LEVEL_TOLERANCE) return "LEVEL";
  return diff > 0 ? "ABOVE" : "BELOW";
}

/**
 * Trend classification from swing structure plus EMA alignment.
 *
 * Structure leads and the EMAs confirm. That ordering is deliberate: EMAs are
 * derived from price and lag it, so letting them override the actual sequence
 * of highs and lows would call a trend that the chart no longer shows.
 *
 * When the two disagree, the answer is SIDEWAYS. A tool whose whole point is
 * restraint should say "unclear" when its own evidence is split, rather than
 * picking the more exciting side.
 */
export function detectTrend(
  candles: Candle[],
  lookback: number = DEFAULT_SWING_LOOKBACK,
): TrendRead {
  const structure = readStructure(candles, lookback);
  const ema = readEmas(candles);

  const structureTrend: Trend | null =
    structure.structure === "UPTREND"
      ? "BULLISH"
      : structure.structure === "DOWNTREND"
        ? "BEARISH"
        : structure.structure === "RANGING"
          ? "SIDEWAYS"
          : null;

  const emaTrend: Trend | null =
    ema.alignment === "BULLISH"
      ? "BULLISH"
      : ema.alignment === "BEARISH"
        ? "BEARISH"
        : ema.alignment === "MIXED"
          ? "SIDEWAYS"
          : null;

  const directional = (t: Trend | null) => t === "BULLISH" || t === "BEARISH";
  const conflict =
    directional(structureTrend) && directional(emaTrend) && structureTrend !== emaTrend;

  let trend: Trend;
  let confidence: TrendRead["confidence"];

  if (conflict) {
    trend = "SIDEWAYS";
    confidence = "LOW";
  } else if (structureTrend && directional(structureTrend)) {
    trend = structureTrend;
    confidence = structureTrend === emaTrend ? "HIGH" : "MEDIUM";
  } else if (structureTrend === "SIDEWAYS") {
    // Structure is ranging; a clean EMA stack is not enough to override it.
    trend = "SIDEWAYS";
    confidence = emaTrend === "SIDEWAYS" ? "MEDIUM" : "LOW";
  } else if (emaTrend && directional(emaTrend)) {
    // Not enough swings yet — lean on EMAs, but say the evidence is thin.
    trend = emaTrend;
    confidence = "LOW";
  } else {
    trend = "SIDEWAYS";
    confidence = "LOW";
  }

  return { trend, confidence, structure, ema, conflict };
}
