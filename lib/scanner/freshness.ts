import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";

import { DEFAULT_CLOSE_DELAY_MS, currentCandleOpen } from "./schedule";

/**
 * Whether a displayed analysis still describes the latest closed candle.
 *
 * An analysis read every candle up to and including the last one that had
 * closed. It stops describing the market when the next candle of its timeframe
 * closes and settles — the moment the scanner itself treats a new pass as due
 * (`latestScanWindow`, `isCatchUpDue`). So STALE here means exactly "a newer
 * candle exists that no pass has read", and no other threshold is invented.
 *
 * Judged against the clock the caller passes, never the moment a page loaded: a
 * page left open turns stale by itself as candles close, and a page loaded long
 * after a scan is stale from the start.
 *
 * UNKNOWN, never FRESH, whenever it cannot be judged: no timestamp, one that is
 * not a time, one in the future, or a timeframe this does not know.
 */
export type FreshnessState = "FRESH" | "STALE" | "UNKNOWN";

export interface AnalysisFreshness {
  state: FreshnessState;
  /** Open time of the last closed candle the analysis read. Null when unknown. */
  analysedCandleOpen: number | null;
  /** When a newer closed candle makes it stale: the next close plus the settle delay. */
  staleAt: number | null;
}

/** A timestamp this far in the future is a fault, not a time. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const UNKNOWN: AnalysisFreshness = { state: "UNKNOWN", analysedCandleOpen: null, staleAt: null };

export function analysisFreshness(input: {
  timeframe: string;
  /** Open time of the last closed candle the analysis read. Preferred when known. */
  analysedCandleOpen?: number | null;
  /** When the pass that produced it started. Used only without the candle. */
  scannedAt?: number | null;
  now: number;
  /** The scanner's settle delay after a close. */
  delayMs?: number;
}): AnalysisFreshness {
  const size = TIMEFRAME_MS[input.timeframe as Timeframe];
  if (!size || !Number.isFinite(input.now)) return UNKNOWN;

  const open = lastClosedCandleOpen(input, size);
  if (open === null || open > input.now + CLOCK_SKEW_TOLERANCE_MS) return UNKNOWN;

  // That candle closed at open + size; the next one closes a candle later.
  const staleAt = open + 2 * size + (input.delayMs ?? DEFAULT_CLOSE_DELAY_MS);
  return { state: input.now < staleAt ? "FRESH" : "STALE", analysedCandleOpen: open, staleAt };
}

function lastClosedCandleOpen(
  input: { timeframe: string; analysedCandleOpen?: number | null; scannedAt?: number | null },
  size: number,
): number | null {
  if (isTime(input.analysedCandleOpen)) return input.analysedCandleOpen;
  // A pass reads closed candles only, so the newest it saw is the one that
  // closed as the candle forming at its start opened.
  if (isTime(input.scannedAt)) {
    return currentCandleOpen(input.timeframe as Timeframe, input.scannedAt) - size;
  }
  return null;
}

function isTime(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The page-level answer for several analyses shown together: STALE if any is,
 * else UNKNOWN if any is, else FRESH — and which timeframes are behind it, so
 * the notice can name them.
 */
export function combinedFreshness(
  entries: readonly { timeframe: string; freshness: AnalysisFreshness }[],
): { state: FreshnessState; staleTimeframes: string[]; unknownTimeframes: string[] } {
  // Shortest timeframe first, so the notice reads "1h and 4h" whatever the order shown.
  const by = (state: FreshnessState) =>
    [...new Set(entries.filter((e) => e.freshness.state === state).map((e) => e.timeframe))].sort(
      (a, b) => (TIMEFRAME_MS[a as Timeframe] ?? 0) - (TIMEFRAME_MS[b as Timeframe] ?? 0),
    );
  const staleTimeframes = by("STALE");
  const unknownTimeframes = by("UNKNOWN");
  const state: FreshnessState =
    entries.length === 0
      ? "UNKNOWN"
      : staleTimeframes.length > 0
        ? "STALE"
        : unknownTimeframes.length > 0
          ? "UNKNOWN"
          : "FRESH";
  return { state, staleTimeframes, unknownTimeframes };
}
