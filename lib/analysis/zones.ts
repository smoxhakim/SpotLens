import { latestAtr } from "@/lib/indicators";
import type { Candle } from "@/lib/market-data/provider";

import { DEFAULT_SWING_LOOKBACK, findSwingPoints, type SwingPoint } from "./structure";

export type ZoneKind = "SUPPORT" | "RESISTANCE";

export interface PriceZone {
  low: number;
  high: number;
  /** Volume-free centre of the zone — the level most often reacted to. */
  mid: number;
  kind: ZoneKind;
  /** How many separate swing reactions formed this zone. */
  touches: number;
  /** 0-100. Combines touch count, recency, and whether the level has flipped. */
  strength: number;
  /** True when the zone contains both swing highs and swing lows — a level
   *  that has flipped between support and resistance, which makes it more
   *  significant than one only ever tested from a single side. */
  flipped: boolean;
  lastTouchIndex: number;
  lastTouchTime: number;
}

export interface ZoneRead {
  support: PriceZone[];
  resistance: PriceZone[];
  /** ATR the zone widths were derived from, for explanation text. */
  atr: number | null;
  price: number;
}

export interface ZoneOptions {
  swingLookback?: number;
  atrPeriod?: number;
  /** Swings within this many ATRs of each other merge into one zone. */
  clusterAtrMultiple?: number;
  /** Minimum zone width, in ATRs — a zone is never a single line. */
  minWidthAtrMultiple?: number;
  /** Maximum zones returned per side. */
  maxPerSide?: number;
}

const DEFAULTS: Required<ZoneOptions> = {
  swingLookback: DEFAULT_SWING_LOOKBACK,
  atrPeriod: 14,
  clusterAtrMultiple: 0.75,
  minWidthAtrMultiple: 0.35,
  maxPerSide: 3,
};

/**
 * Support and resistance as zones, not lines.
 *
 * Price never turns at exactly the same number twice, so a single line is
 * false precision that leads to stops placed a few ticks from where they
 * should be. Swing points that reacted at similar levels are clustered, and
 * the cluster's span becomes the zone.
 *
 * Distances are measured in ATR rather than percent, so the same settings work
 * for BTC on a daily chart and a small cap on 15m without retuning.
 */
export function detectZones(candles: Candle[], options: ZoneOptions = {}): ZoneRead {
  const opts = { ...DEFAULTS, ...options };
  const price = candles.at(-1)?.close ?? 0;
  const atrValue = latestAtr(candles, opts.atrPeriod);

  if (candles.length === 0 || atrValue === null || atrValue === 0) {
    return { support: [], resistance: [], atr: atrValue, price };
  }

  const swings = findSwingPoints(candles, opts.swingLookback);
  if (swings.length === 0) {
    return { support: [], resistance: [], atr: atrValue, price };
  }

  const clusters = cluster(swings, atrValue * opts.clusterAtrMultiple);
  const lastIndex = candles.length - 1;
  const minWidth = atrValue * opts.minWidthAtrMultiple;

  const zones = clusters.map((group) => toZone(group, { price, minWidth, lastIndex }));

  const support = zones
    .filter((z) => z.kind === "SUPPORT")
    .sort((a, b) => b.high - a.high) // nearest below price first
    .slice(0, opts.maxPerSide);

  const resistance = zones
    .filter((z) => z.kind === "RESISTANCE")
    .sort((a, b) => a.low - b.low) // nearest above price first
    .slice(0, opts.maxPerSide);

  return { support, resistance, atr: atrValue, price };
}

/** Groups swings whose prices sit within `tolerance` of the running cluster. */
function cluster(swings: SwingPoint[], tolerance: number): SwingPoint[][] {
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const groups: SwingPoint[][] = [];

  for (const swing of sorted) {
    const current = groups[groups.length - 1];
    // Compare against the group's lowest member so a long chain of small steps
    // cannot drift into one enormous zone.
    if (current && swing.price - current[0].price <= tolerance) {
      current.push(swing);
    } else {
      groups.push([swing]);
    }
  }

  return groups;
}

function toZone(
  group: SwingPoint[],
  context: { price: number; minWidth: number; lastIndex: number },
): PriceZone {
  const prices = group.map((s) => s.price);
  let low = Math.min(...prices);
  let high = Math.max(...prices);
  const mid = (low + high) / 2;

  // Never present a zone as a single line.
  if (high - low < context.minWidth) {
    low = mid - context.minWidth / 2;
    high = mid + context.minWidth / 2;
  }

  const lastTouch = group.reduce((a, b) => (a.index > b.index ? a : b));
  const flipped = group.some((s) => s.type === "HIGH") && group.some((s) => s.type === "LOW");

  // A zone straddling the current price is classified by which side holds more
  // of it, so the caller always gets a usable above/below split.
  const kind: ZoneKind = mid < context.price ? "SUPPORT" : "RESISTANCE";

  return {
    low,
    high,
    mid,
    kind,
    touches: group.length,
    strength: scoreZone(group, flipped, lastTouch.index, context.lastIndex),
    flipped,
    lastTouchIndex: lastTouch.index,
    lastTouchTime: lastTouch.time,
  };
}

/**
 * Zone strength, 0-100.
 *
 * Touches dominate but with diminishing returns — a fourth test of a level
 * says much less than the second did. Recency matters because an untested
 * level from 300 candles ago is closer to trivia than to a live zone. A
 * flipped level earns a bonus: price has respected it from both directions.
 */
function scoreZone(
  group: SwingPoint[],
  flipped: boolean,
  lastTouchIndex: number,
  lastIndex: number,
): number {
  const touchScore = Math.min(1, Math.log2(group.length + 1) / Math.log2(5)) * 55;

  const age = Math.max(0, lastIndex - lastTouchIndex);
  // Halves roughly every 60 candles.
  const recencyScore = Math.exp(-age / 87) * 30;

  const flipScore = flipped ? 15 : 0;

  return Math.round(Math.min(100, touchScore + recencyScore + flipScore));
}

/** Whether a price sits inside a zone. */
export function isInZone(price: number, zone: PriceZone): boolean {
  return price >= zone.low && price <= zone.high;
}

/** Distance from a price to the nearest edge of a zone, 0 when inside. */
export function distanceToZone(price: number, zone: PriceZone): number {
  if (isInZone(price, zone)) return 0;
  return price < zone.low ? zone.low - price : price - zone.high;
}
