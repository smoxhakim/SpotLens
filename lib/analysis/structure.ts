import type { Candle } from "@/lib/market-data/provider";

export type SwingType = "HIGH" | "LOW";

export interface SwingPoint {
  /** Index into the candle array the swing was found in. */
  index: number;
  /** Candle open time, epoch ms. */
  time: number;
  price: number;
  type: SwingType;
}

/**
 * Swing comparison labels. "EH"/"EL" mean the two swings are level within
 * tolerance — without them, a market ranging between the same two prices reads
 * as lower highs and lower lows, i.e. a downtrend, which is exactly wrong.
 */
export type StructureLabel = "HH" | "HL" | "LH" | "LL" | "EH" | "EL";

/** Relative band within which two swing prices count as the same level. */
export const STRUCTURE_LEVEL_TOLERANCE = 0.002; // 0.2%

export type MarketStructure = "UPTREND" | "DOWNTREND" | "RANGING" | "UNDETERMINED";

export interface StructureRead {
  structure: MarketStructure;
  swings: SwingPoint[];
  /** Most recent label for each side, e.g. `{ high: "HH", low: "HL" }`. */
  labels: { high: StructureLabel | null; low: StructureLabel | null };
  lastHigh: SwingPoint | null;
  lastLow: SwingPoint | null;
  previousHigh: SwingPoint | null;
  previousLow: SwingPoint | null;
}

export const DEFAULT_SWING_LOOKBACK = 2;

/**
 * Fractal swing-point detection.
 *
 * A swing high is a candle whose high is at least as high as the `lookback`
 * candles to its left and strictly higher than the `lookback` candles to its
 * right (mirrored for lows). The asymmetry matters: requiring strict
 * inequality on both sides would find nothing at all on a plateau of equal
 * highs, so double tops would vanish. With this rule the plateau resolves to
 * its **last** candle — the most recent touch of the level, and the one the
 * subsequent move away actually confirms.
 *
 * The final `lookback` candles are never evaluated, because a swing cannot be
 * confirmed until enough candles have printed after it. That is also what keeps
 * the backtester honest: a swing is only visible once it would really have been
 * visible, never in hindsight.
 */
export function findSwingPoints(
  candles: Candle[],
  lookback: number = DEFAULT_SWING_LOOKBACK,
): SwingPoint[] {
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new Error(`findSwingPoints: lookback must be a positive integer, received ${lookback}`);
  }

  const swings: SwingPoint[] = [];

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const candle = candles[i];

    let isHigh = true;
    let isLow = true;

    for (let offset = 1; offset <= lookback; offset += 1) {
      const left = candles[i - offset];
      const right = candles[i + offset];

      if (candle.high < left.high || candle.high <= right.high) isHigh = false;
      if (candle.low > left.low || candle.low >= right.low) isLow = false;

      if (!isHigh && !isLow) break;
    }

    // An inside-bar edge case can satisfy both; the larger range wins.
    if (isHigh && isLow) {
      const upper = candle.high - Math.max(candles[i - 1].high, candles[i + 1].high);
      const lower = Math.min(candles[i - 1].low, candles[i + 1].low) - candle.low;
      if (upper >= lower) isLow = false;
      else isHigh = false;
    }

    if (isHigh) {
      swings.push({ index: i, time: candle.openTime, price: candle.high, type: "HIGH" });
    } else if (isLow) {
      swings.push({ index: i, time: candle.openTime, price: candle.low, type: "LOW" });
    }
  }

  return alternate(swings);
}

/** Higher / lower / level, with a relative deadband. */
function label(
  current: number,
  previous: number,
  [higher, lower, equal]: [StructureLabel, StructureLabel, StructureLabel],
): StructureLabel {
  const scale = Math.abs(previous);
  if (scale === 0) return current === 0 ? equal : current > 0 ? higher : lower;
  const diff = (current - previous) / scale;
  if (Math.abs(diff) <= STRUCTURE_LEVEL_TOLERANCE) return equal;
  return diff > 0 ? higher : lower;
}

/**
 * Collapses consecutive same-type swings into their extreme, so the series
 * alternates high/low/high/low. Without this, a cluster of three swing highs
 * with no low between them would be read as "lower highs" when it is really one
 * region of noise.
 */
function alternate(swings: SwingPoint[]): SwingPoint[] {
  const out: SwingPoint[] = [];

  for (const swing of swings) {
    const prev = out[out.length - 1];
    if (!prev || prev.type !== swing.type) {
      out.push(swing);
      continue;
    }

    const keepNew = swing.type === "HIGH" ? swing.price > prev.price : swing.price < prev.price;
    if (keepNew) out[out.length - 1] = swing;
  }

  return out;
}

/**
 * Reads market structure from the swing series: higher highs and higher lows
 * are an uptrend, lower highs and lower lows a downtrend, and any disagreement
 * between the two is a range rather than a forced directional call.
 */
export function readStructure(
  candles: Candle[],
  lookback: number = DEFAULT_SWING_LOOKBACK,
): StructureRead {
  const swings = findSwingPoints(candles, lookback);

  const highs = swings.filter((s) => s.type === "HIGH");
  const lows = swings.filter((s) => s.type === "LOW");

  const lastHigh = highs.at(-1) ?? null;
  const previousHigh = highs.at(-2) ?? null;
  const lastLow = lows.at(-1) ?? null;
  const previousLow = lows.at(-2) ?? null;

  const highLabel: StructureLabel | null =
    lastHigh && previousHigh ? label(lastHigh.price, previousHigh.price, ["HH", "LH", "EH"]) : null;
  const lowLabel: StructureLabel | null =
    lastLow && previousLow ? label(lastLow.price, previousLow.price, ["HL", "LL", "EL"]) : null;

  let structure: MarketStructure = "UNDETERMINED";
  if (highLabel && lowLabel) {
    // Only an unambiguous pair counts as a trend; anything level or mixed is
    // a range. Equality is not a direction.
    if (highLabel === "HH" && lowLabel === "HL") structure = "UPTREND";
    else if (highLabel === "LH" && lowLabel === "LL") structure = "DOWNTREND";
    else structure = "RANGING";
  }

  return {
    structure,
    swings,
    labels: { high: highLabel, low: lowLabel },
    lastHigh,
    lastLow,
    previousHigh,
    previousLow,
  };
}
