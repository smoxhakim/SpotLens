import {
  analysisFreshness,
  newestReadFreshness,
  type FreshnessState,
} from "@/lib/scanner/freshness";

/**
 * What SpotLens was showing about a setup at one moment: its lifecycle state
 * and whether its analysis was still fresh.
 *
 * The trial trades only Potential setups that are still open and fresh, and the
 * moment that matters is the fill. The journal freezes a setup's state when an
 * entry is *created* — which, with Take recorded only after a fill, may be a
 * watch from hours earlier — so the state at the fill is rebuilt here from the
 * setup's own append-only event log and the scanner reads behind it. Pure:
 * the moment is passed in, and nothing reads a clock.
 */
export interface SetupHistory {
  /** When SpotLens first tracked the setup. */
  createdAt: number;
  /** Every lifecycle transition, the creation included. Any order. */
  events: readonly { toStatus: string; at: number }[];
  /**
   * Every read of the market that assessed the setup: the creating analysis,
   * and each successful pass whose analysis was reconciled against it.
   * `analysedAtCandle` is the open of the newest closed candle the read saw;
   * `availableAt` is when it could first be shown — a pass's rows exist only
   * once the pass completes. A read that does not name its candle is credited
   * with nothing: freshness is never inferred from when a row was written.
   */
  reads: readonly { analysedAtCandle: number | null; availableAt: number }[];
}

export interface StateAtEntry {
  /** False before SpotLens first tracked the setup. */
  tracked: boolean;
  /**
   * The lifecycle state. Null when the setup was not tracked yet — or, with
   * `tracked`, when its event log holds no state for the moment.
   */
  status: string | null;
  freshness: FreshnessState;
}

export function stateAt(history: SetupHistory, timeframe: string, at: number): StateAtEntry {
  const tracked = at >= history.createdAt;
  let status: string | null = null;
  let latest = -Infinity;
  if (tracked) {
    for (const event of history.events) {
      // Ties go to the later entry in the log, which is the later transition.
      if (event.at <= at && event.at >= latest) {
        latest = event.at;
        status = event.toStatus;
      }
    }
  }

  const { freshness } = newestReadFreshness({
    timeframe,
    reads: history.reads
      .filter((read) => read.availableAt <= at)
      .map((read) => ({ analysedAtCandle: read.analysedAtCandle, recordedAt: null })),
    now: at,
  });

  return { tracked, status, freshness: freshness.state };
}

/**
 * Every state the setup was in within `marginMs` either side of a moment.
 *
 * A typed-in time is only as exact as the typing: a fill recorded at 10:00 may
 * have happened at 10:00:50. If the setup changed inside that margin, the fill
 * met one of several states and no single answer is honest. A state changes
 * only at an event, at a read becoming available, or at a read going stale, so
 * the margin's edges and every such moment inside it cover each state there
 * was.
 */
export function statesAround(
  history: SetupHistory,
  timeframe: string,
  at: number,
  marginMs: number,
): StateAtEntry[] {
  const from = at - marginMs;
  const to = at + marginMs;
  const moments = new Set<number>([from, at, to]);
  const add = (moment: number | null) => {
    if (moment !== null && moment > from && moment <= to) moments.add(moment);
  };

  add(history.createdAt);
  for (const event of history.events) add(event.at);
  for (const read of history.reads) {
    add(read.availableAt);
    add(
      analysisFreshness({ timeframe, analysedCandleOpen: read.analysedAtCandle, now: to }).staleAt,
    );
  }

  return [...moments].sort((a, b) => a - b).map((moment) => stateAt(history, timeframe, moment));
}
