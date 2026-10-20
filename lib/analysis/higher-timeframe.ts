import {
  TIMEFRAME_LABELS,
  TIMEFRAME_MS,
  type Candle,
  type Timeframe,
} from "@/lib/market-data/provider";

import type { AnalysisShortfall, DataGap } from "./incomplete";
import { MIN_CANDLES_FOR_READ } from "./market-read";

/**
 * Whether an analysis had the higher timeframe it needs.
 *
 * A timeframe with a higher one (`defaultHigherTimeframe`: H1 → H4, H4 → D1)
 * needs that higher read before it can say POTENTIAL_SETUP: the counter-trend
 * veto and the bearish-alignment AVOID both live there. An analysis without it
 * used to carry on single-timeframe — "less informed, not wrong" — which let a
 * rally inside a higher-timeframe downtrend reach POTENTIAL_SETUP whenever the
 * higher read failed, went stale, or was simply not asked for. Fail closed: a
 * missing higher timeframe is recorded as a shortfall, and a shortfall cannot
 * be a potential setup, be tracked, or vouch for an entry-zone alert.
 *
 * Pure: the clock is passed in.
 */
/** The higher-timeframe case of the general representation (`./incomplete`). */
export type HigherTimeframeGap = DataGap;
export type HigherTimeframeShortfall = AnalysisShortfall;

/**
 * How long after a close its candle may still be missing before the series is
 * stale. The scanner waits 90 seconds for the exchange to settle a bar; this is
 * that, plus a slow pass and its retries.
 */
export const HIGHER_TIMEFRAME_GRACE_MS = 15 * 60_000;

/**
 * Checks a higher-timeframe series of **closed** candles.
 *
 * Returns null when it is usable, or the shortfall. `servedStale` is the
 * candle reader's own flag (cache answered because the exchange failed); the
 * head check catches a series that is behind without being flagged.
 */
export function assessHigherTimeframe(input: {
  candles: readonly Candle[];
  timeframe: Timeframe;
  now: number;
  servedStale?: boolean;
}): HigherTimeframeShortfall | null {
  const { candles, timeframe, now } = input;
  const label = TIMEFRAME_LABELS[timeframe];
  const shortfall = (gap: DataGap, detail: string): AnalysisShortfall => ({
    scope: "HIGHER",
    timeframe,
    gap,
    detail,
  });

  if (input.servedStale) {
    return shortfall(
      "STALE",
      `The exchange could not be reached for ${label} candles, and only cached ones from before the latest close are available.`,
    );
  }
  if (candles.length === 0) {
    return shortfall("UNAVAILABLE", `No closed ${label} candles are available.`);
  }

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const prices = [c.open, c.high, c.low, c.close];
    if (!prices.every((p) => Number.isFinite(p) && p > 0) || c.high < c.low) {
      return shortfall("INVALID", `A ${label} candle does not describe a valid price range.`);
    }
    if (i > 0 && c.openTime <= candles[i - 1].openTime) {
      return shortfall("INVALID", `The ${label} candles are duplicated or out of order.`);
    }
  }

  if (candles.length < MIN_CANDLES_FOR_READ) {
    return shortfall(
      "INSUFFICIENT",
      `Only ${candles.length} closed ${label} candles are available; a trend read needs at least ${MIN_CANDLES_FOR_READ}.`,
    );
  }

  // The newest closed candle should have closed within one candle of now. If
  // it closed earlier than that (plus grace), the one after it is missing.
  const last = candles[candles.length - 1];
  const sinceClose = now - (last.closeTime + 1);
  if (sinceClose > TIMEFRAME_MS[timeframe] + HIGHER_TIMEFRAME_GRACE_MS) {
    return shortfall(
      "STALE",
      `The newest closed ${label} candle is missing: the series ends a full candle or more before now.`,
    );
  }

  return null;
}

/** A shortfall for a higher timeframe that could not be read at all. */
export function unavailableHigherTimeframe(
  timeframe: Timeframe,
  gap: "NOT_CHECKED" | "UNAVAILABLE",
): HigherTimeframeShortfall {
  const label = TIMEFRAME_LABELS[timeframe];
  return {
    scope: "HIGHER",
    timeframe,
    gap,
    detail:
      gap === "NOT_CHECKED"
        ? `The ${label} trend was not checked for this analysis.`
        : `${label} candles could not be loaded.`,
  };
}
