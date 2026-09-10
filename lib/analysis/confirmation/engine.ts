import { formatPrice } from "@/lib/format";
import type { Candle } from "@/lib/market-data/provider";

import type { MarketRead } from "../market-read";
import { DEFAULT_SWING_LOOKBACK, readStructure, type StructureRead } from "../structure";
import type { EntryZone } from "../setup/types";
import {
  MIN_POSITIVE_SIGNALS,
  PRIMARY_SIGNALS,
  RECENT_SWING_MAX_AGE_BARS,
  RECLAIM_LOOKBACK_BARS,
  REJECTION_MIN_CLOSE_POSITION,
  REJECTION_MIN_WICK_RATIO,
  THIN_VOLUME_RELATIVE,
  type ConfirmationResult,
  type ConfirmationSignal,
  type ConfirmationStatus,
} from "./types";

export interface ConfirmationInput {
  read: MarketRead;
  entry: EntryZone;
  candles: Candle[];
  /** True when the final candle is still open, so it must not be judged. */
  lastCandleIsForming?: boolean;
  swingLookback?: number;
}

/**
 * Evaluates deterministic confirmation for a setup that already exists.
 *
 * ## Only closed candles, always
 *
 * Every rule below reads the last *closed* candle. A forming candle's wick and
 * close are still being written, so a rejection detected on it is a rejection
 * that may not have happened — the single most convincing thing this engine
 * could get wrong. The structure read is recomputed on the closed series for
 * the same reason: `findSwingPoints` uses the candles after a swing to confirm
 * it, and a forming candle standing in as one of those would confirm a swing
 * that can still un-confirm itself. It is the same function and the same
 * definition as `lib/analysis/structure`, given a stricter input.
 *
 * ## No lookahead, structurally
 *
 * The function can only see the array it is handed. The backtester hands it
 * `candles.slice(0, i + 1)`, so there is no path by which a later candle
 * reaches a decision — the same guarantee, and the same reason, as Phase A.
 *
 * ## It can only ever say no
 *
 * Confirmation is applied as the final gate before POTENTIAL_SETUP, after
 * every existing disqualifier. It therefore cannot promote a setup the
 * counter-trend veto rejected, cannot rescue one with no structural target,
 * and cannot raise a score. The only thing it can do is hold a setup back.
 */
export function evaluateConfirmation(input: ConfirmationInput): ConfirmationResult {
  const { read, entry } = input;
  const lookback = input.swingLookback ?? DEFAULT_SWING_LOOKBACK;

  const closed =
    input.lastCandleIsForming && input.candles.length > 1
      ? input.candles.slice(0, -1)
      : input.candles;

  const candle = closed.at(-1);

  if (!candle) {
    return {
      status: "NOT_PRESENT",
      signals: [],
      explanation: "There is no closed candle to judge confirmation on yet.",
      evaluatedAt: 0,
      invalidationReason: null,
    };
  }

  const structure = readStructure(closed, lookback);

  const signals = [
    bullishRejection(candle, entry),
    higherLow(structure, closed.length),
    structureBreak(candle, structure, closed.length),
    volumeConfirmation(read),
    reclaim(candle, closed, entry),
  ].filter((signal): signal is ConfirmationSignal => signal !== null);

  const negatives = signals.filter((s) => s.signal === "negative");
  const positives = signals.filter((s) => s.signal === "positive");
  const hasPrimary = positives.some((s) => PRIMARY_SIGNALS.includes(s.type));

  const status: ConfirmationStatus =
    negatives.length > 0
      ? "CONTRADICTED"
      : hasPrimary && positives.length >= MIN_POSITIVE_SIGNALS
        ? "PRESENT"
        : "NOT_PRESENT";

  // Only a close through the zone the entry and stop are built on invalidates
  // the premise. A thin-volume candle argues against acting; it does not mean
  // the level has failed.
  const lostSupport = signals.find((s) => s.type === "RECLAIM" && s.signal === "negative");

  return {
    status,
    signals,
    explanation: explain(status, positives, negatives),
    evaluatedAt: candle.closeTime,
    invalidationReason: lostSupport ? lostSupport.detail : null,
  };
}

/**
 * A candle that traded into the support zone and was pushed back out of it.
 *
 * Positive requires all of:
 *   - the candle reached the zone            `low <= zone.high`
 *   - the lower wick is at least 40% of the candle's range
 *   - it closed in the top 40% of its range
 *   - it closed up on the period             `close > open`
 *   - it closed at or above the zone's floor `close >= zone.low`
 *
 * Negative is the mirror: it reached the zone from above, left a long upper
 * wick, closed in the bottom 40% of its range and closed down. That is the
 * zone rejecting price *downward*, which is the opposite of confirmation.
 */
function bullishRejection(candle: Candle, entry: EntryZone): ConfirmationSignal | null {
  const zone = entry.sourceZone;
  const range = candle.high - candle.low;
  if (range <= 0) return null;

  const bodyLow = Math.min(candle.open, candle.close);
  const bodyHigh = Math.max(candle.open, candle.close);
  const lowerWick = bodyLow - candle.low;
  const upperWick = candle.high - bodyHigh;
  const closePosition = (candle.close - candle.low) / range;

  const reachedFromAbove = candle.low <= zone.high;

  if (
    reachedFromAbove &&
    lowerWick / range >= REJECTION_MIN_WICK_RATIO &&
    closePosition >= REJECTION_MIN_CLOSE_POSITION &&
    candle.close > candle.open &&
    candle.close >= zone.low
  ) {
    return {
      type: "BULLISH_REJECTION",
      signal: "positive",
      title: "Bullish rejection at the zone",
      detail: `The last closed candle traded down into ${formatPrice(zone.low)} – ${formatPrice(
        zone.high,
      )} and closed at ${formatPrice(candle.close)}, in the top ${Math.round(
        (1 - closePosition) * 100,
      )}% of its range, leaving a lower wick ${Math.round(
        (lowerWick / range) * 100,
      )}% of the candle. Buyers took the level back within the period.`,
    };
  }

  if (
    candle.high >= zone.low &&
    upperWick / range >= REJECTION_MIN_WICK_RATIO &&
    closePosition <= 1 - REJECTION_MIN_CLOSE_POSITION &&
    candle.close < candle.open
  ) {
    return {
      type: "BULLISH_REJECTION",
      signal: "negative",
      title: "The zone rejected price downward",
      detail: `The last closed candle pushed into the zone and closed at ${formatPrice(
        candle.close,
      )}, in the bottom ${Math.round(
        closePosition * 100,
      )}% of its range, leaving an upper wick ${Math.round(
        (upperWick / range) * 100,
      )}% of the candle. Sellers, not buyers, controlled the level.`,
    };
  }

  return null;
}

/** A confirmed higher low inside the recency window; a lower low contradicts. */
function higherLow(structure: StructureRead, length: number): ConfirmationSignal | null {
  const last = structure.lastLow;
  if (!last) return null;

  const age = length - 1 - last.index;
  if (age > RECENT_SWING_MAX_AGE_BARS) return null;

  if (structure.labels.low === "HL") {
    return {
      type: "HIGHER_LOW",
      signal: "positive",
      title: "A higher low has formed",
      detail: `The most recent confirmed swing low is at ${formatPrice(
        last.price,
      )}, above the one before it, and printed ${age} ${age === 1 ? "candle" : "candles"} ago. Sellers failed to push price as low as last time.`,
    };
  }

  if (structure.labels.low === "LL") {
    return {
      type: "HIGHER_LOW",
      signal: "negative",
      title: "A lower low has formed",
      detail: `The most recent confirmed swing low is at ${formatPrice(
        last.price,
      )}, below the one before it. Structure is still stepping down, which argues against the level holding.`,
    };
  }

  return null;
}

/**
 * A close beyond the most recent confirmed swing.
 *
 * Deliberately measured against a *confirmed swing point*, not against the
 * previous candle — otherwise every green candle would read as a structure
 * break and the signal would mean nothing.
 */
function structureBreak(
  candle: Candle,
  structure: StructureRead,
  length: number,
): ConfirmationSignal | null {
  const high = structure.lastHigh;
  const low = structure.lastLow;

  if (high && length - 1 - high.index <= RECENT_SWING_MAX_AGE_BARS && candle.close > high.price) {
    return {
      type: "STRUCTURE_BREAK",
      signal: "positive",
      title: "Local structure broken upward",
      detail: `The last closed candle finished at ${formatPrice(
        candle.close,
      )}, above the most recent confirmed swing high of ${formatPrice(
        high.price,
      )}. The level that was capping price has given way.`,
    };
  }

  if (low && length - 1 - low.index <= RECENT_SWING_MAX_AGE_BARS && candle.close < low.price) {
    return {
      type: "STRUCTURE_BREAK",
      signal: "negative",
      title: "Local structure broken downward",
      detail: `The last closed candle finished at ${formatPrice(
        candle.close,
      )}, below the most recent confirmed swing low of ${formatPrice(
        low.price,
      )}. The structure supporting the setup has given way.`,
    };
  }

  return null;
}

/**
 * Volume, read from the existing market read.
 *
 * Not recomputed here on purpose: `runMarketRead` already excludes a forming
 * candle from the volume window, and a second implementation of the same idea
 * is how two parts of a product start disagreeing about whether a bar was
 * heavy.
 */
function volumeConfirmation(read: MarketRead): ConfirmationSignal | null {
  const volume = read.volume.read;
  if (!volume) return null;

  if (volume.isAboveAverage && volume.trend !== "DECREASING") {
    return {
      type: "VOLUME_CONFIRMATION",
      signal: "positive",
      title: "Volume backs the move",
      detail: `The last closed candle traded ${volume.relative.toFixed(
        1,
      )}× its average volume, with volume ${volume.trend.toLowerCase()} over recent candles. Participation supports the reaction rather than contradicting it.`,
    };
  }

  if (volume.relative <= THIN_VOLUME_RELATIVE) {
    return {
      type: "VOLUME_CONFIRMATION",
      signal: "negative",
      title: "Volume is too thin to confirm",
      detail: `The last closed candle traded only ${volume.relative.toFixed(
        1,
      )}× its average volume. A reaction this quiet is not evidence that buyers showed up.`,
    };
  }

  return null;
}

/**
 * The zone lost and taken back.
 *
 * Positive requires both halves: a close *below the zone floor* within the last
 * `RECLAIM_LOOKBACK_BARS` candles, and the latest close *above the zone top*.
 * Price merely sitting above a level it never lost is not a reclaim.
 *
 * Negative is the setup's invalidation condition: the latest close is below the
 * zone the entry and the stop are both built on.
 */
function reclaim(candle: Candle, closed: Candle[], entry: EntryZone): ConfirmationSignal | null {
  const zone = entry.sourceZone;

  if (candle.close < zone.low) {
    return {
      type: "RECLAIM",
      signal: "negative",
      title: "Support has been lost",
      detail: `The last closed candle finished at ${formatPrice(
        candle.close,
      )}, below the support zone at ${formatPrice(zone.low)} – ${formatPrice(
        zone.high,
      )} that the entry and stop are built on. The premise of the setup no longer holds.`,
    };
  }

  if (candle.close > zone.high) {
    const window = closed.slice(-(RECLAIM_LOOKBACK_BARS + 1), -1);
    const lost = window.find((c) => c.close < zone.low);

    if (lost) {
      return {
        type: "RECLAIM",
        signal: "positive",
        title: "The zone has been reclaimed",
        detail: `Price closed below the zone at ${formatPrice(
          lost.close,
        )} within the last ${RECLAIM_LOOKBACK_BARS} candles and has closed back above it at ${formatPrice(
          candle.close,
        )}. A level lost and taken back is stronger evidence than one never given up.`,
      };
    }
  }

  return null;
}

function explain(
  status: ConfirmationStatus,
  positives: ConfirmationSignal[],
  negatives: ConfirmationSignal[],
): string {
  if (status === "CONTRADICTED") {
    return `Confirmation is contradicted: ${negatives
      .map((s) => s.title.toLowerCase())
      .join(
        ", ",
      )}. Whatever else the chart shows, the market has answered at this level in the wrong direction.`;
  }

  if (status === "PRESENT") {
    return `Confirmation is present: ${positives
      .map((s) => s.title.toLowerCase())
      .join(", ")}. The level has been tested and held, on more than one piece of evidence.`;
  }

  if (positives.length === 0) {
    return "No confirmation yet. Price is at the level, but nothing has happened there to show buyers are defending it. Waiting costs one candle.";
  }

  return `Not enough confirmation yet — ${positives
    .map((s) => s.title.toLowerCase())
    .join(
      ", ",
    )}, but a single piece of evidence is the one most easily erased by the next candle. At least ${MIN_POSITIVE_SIGNALS} are required, one of which must be structural rather than volume alone.`;
}
