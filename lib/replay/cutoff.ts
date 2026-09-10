import type { Candle } from "@/lib/market-data/provider";

/**
 * Replay: reconstructing what was knowable at a moment, and nothing else.
 *
 * The whole value of a replay is that it shows the decision as it looked
 * *then*. A single candle from after the cutoff destroys that — not because
 * the chart looks wrong, but because hindsight is invisible: a reader cannot
 * tell which part of what they are seeing they could not have seen. So the
 * cutoff is enforced structurally rather than trusted.
 *
 * Every function here is pure and takes the cutoff explicitly. None reads a
 * clock: a replay of the same moment must produce the same reconstruction
 * today, tomorrow and in a year.
 */

/**
 * Candles that had closed by `at`.
 *
 * Closed, not opened. A candle that was still forming at the cutoff had not
 * finished being written, and its final shape is precisely the information the
 * person did not have — the same rule the scanner and the backtester follow.
 */
export function candlesUpTo<T extends { closeTime: number }>(candles: T[], at: number): T[] {
  return candles.filter((candle) => candle.closeTime <= at);
}

/** Records that existed by `at`. Used for lifecycle events and notifications. */
export function eventsUpTo<T extends { createdAt: number }>(records: T[], at: number): T[] {
  return records.filter((record) => record.createdAt <= at);
}

export interface ReplayCoverage {
  /** Candles actually available before the cutoff. */
  available: number;
  /** Candles the interval implies should exist across the window. */
  expected: number;
  /** Open time of the earliest and latest candle shown. */
  from: number | null;
  to: number | null;
  /** True when the stored history does not cover the window. */
  incomplete: boolean;
  note: string | null;
}

/**
 * How much of the requested window the stored candles actually cover.
 *
 * Replay reads only what has been persisted and never fetches: a reconstruction
 * that goes to the network is no longer a reconstruction, and it would stop
 * being reproducible the moment the exchange stopped serving that range.
 *
 * The consequence is that coverage can be partial, and that is reported rather
 * than papered over. A sparse chart labelled sparse is honest; a complete
 * looking one quietly backfilled with data fetched today is not.
 */
export function coverageFor(input: {
  candles: Candle[];
  intervalMs: number;
  windowStart: number;
  cutoff: number;
}): ReplayCoverage {
  const { candles, intervalMs, windowStart, cutoff } = input;

  const expected = Math.max(0, Math.floor((cutoff - windowStart) / intervalMs));
  const available = candles.length;

  if (available === 0) {
    return {
      available: 0,
      expected,
      from: null,
      to: null,
      incomplete: true,
      note: "No candles are stored for this market and timeframe before the replay point, so no price history can be shown. Nothing has been fetched to fill the gap.",
    };
  }

  // A little slack: the window is derived from a candle count, and the exact
  // boundary depends on where the setup fell inside its own candle.
  const incomplete = available < expected - 1;

  return {
    available,
    expected,
    from: candles[0].openTime,
    to: candles[candles.length - 1].openTime,
    incomplete,
    note: incomplete
      ? `Showing ${available} of about ${expected} candles for this window. The rest were never stored locally, and replay does not fetch — what is shown is what was on disk.`
      : null,
  };
}

/**
 * The moments in a setup's life worth jumping to.
 *
 * Derived from lifecycle events that had already happened by the cutoff, so a
 * confirmation that came after the decision does not appear as somewhere to
 * jump — which would leak the future through the navigation rather than
 * through the chart.
 */
export interface ReplayMarker {
  at: number;
  label: string;
  kind: "CREATED" | "CONFIRMATION" | "POTENTIAL" | "INVALIDATED" | "DECISION";
}

export function markersUpTo(
  events: { createdAt: number; toStatus: string; type: string }[],
  decidedAt: number | null,
  at: number,
): ReplayMarker[] {
  const markers: ReplayMarker[] = [];

  for (const event of eventsUpTo(events, at)) {
    if (event.type === "CREATED") {
      markers.push({ at: event.createdAt, label: "Setup first seen", kind: "CREATED" });
    } else if (event.toStatus === "CONFIRMATION_DETECTED") {
      markers.push({ at: event.createdAt, label: "Confirmation detected", kind: "CONFIRMATION" });
    } else if (event.toStatus === "POTENTIAL_SETUP") {
      markers.push({ at: event.createdAt, label: "Reached potential setup", kind: "POTENTIAL" });
    } else if (event.toStatus === "INVALIDATED") {
      markers.push({ at: event.createdAt, label: "Invalidated", kind: "INVALIDATED" });
    }
  }

  if (decidedAt !== null && decidedAt <= at) {
    markers.push({ at: decidedAt, label: "Your decision", kind: "DECISION" });
  }

  // Stable order: by time, then by label, so the same history always renders
  // the same list.
  return markers.sort((a, b) => a.at - b.at || a.label.localeCompare(b.label));
}
