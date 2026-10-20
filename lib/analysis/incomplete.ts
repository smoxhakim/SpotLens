import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";

/**
 * An analysis run on data that was not fit to decide on.
 *
 * Two ways that happens, kept in one representation so every surface treats
 * them alike: the **entry** timeframe's candles were stale (the exchange
 * failed and the cache answered with candles from before the latest close),
 * or the **higher** timeframe the analysis needs was missing, stale, short or
 * invalid — and with it the counter-trend veto.
 *
 * Either way the result is informational only: `runAnalysis` holds a would-be
 * POTENTIAL_SETUP at WAIT, callers never track it, and every surface says so —
 * in the words below, which are the only copy of them. Components place these
 * sentences; they never write their own.
 *
 * Pure.
 */
export type DataScope = "ENTRY" | "HIGHER";

export type DataGap =
  /** Not requested — the single-timeframe analysis route. */
  | "NOT_CHECKED"
  /** The fetch failed, or returned nothing closed. */
  | "UNAVAILABLE"
  /** Served from cache after the exchange failed, or the newest closed candle is missing. */
  | "STALE"
  /** Fewer closed candles than a trend read needs. */
  | "INSUFFICIENT"
  /** Out of order, duplicated, or not a price. */
  | "INVALID";

export interface AnalysisShortfall {
  /** Which timeframe's data fell short: the one analysed, or the one above it. */
  scope: DataScope;
  timeframe: Timeframe;
  gap: DataGap;
  /** One plain sentence on what was wrong. */
  detail: string;
}

/** The entry timeframe's candles came from the cache because the exchange failed. */
export function staleEntryTimeframe(timeframe: Timeframe): AnalysisShortfall {
  return {
    scope: "ENTRY",
    timeframe,
    gap: "STALE",
    detail: `The ${TIMEFRAME_LABELS[timeframe]} candles being analysed are stale: the exchange could not be reached, and only cached candles from before the latest close are available.`,
  };
}

/** What could not be relied on, in a few words. */
function missing(shortfall: AnalysisShortfall): string {
  const label = TIMEFRAME_LABELS[shortfall.timeframe];
  return shortfall.scope === "ENTRY" ? `current ${label} data` : `the ${label} trend`;
}

/**
 * The status reason when a would-be potential setup is held at wait.
 *
 * Kept with the representation so the reason and the shortfall cannot drift.
 */
export function heldForIncompleteData(shortfall: AnalysisShortfall): string {
  const label = TIMEFRAME_LABELS[shortfall.timeframe];
  const why =
    shortfall.scope === "ENTRY"
      ? "A potential setup needs current data"
      : `A potential setup needs the ${label} trend's agreement — the counter-trend veto lives there —`;
  return `${shortfall.detail} ${why} so this analysis is held at wait and shown for information only. It is not tracked and cannot trigger an entry-zone alert. Run it again once valid ${label} data is available.`;
}

/** The full notice an incomplete result carries beside its levels. */
export function incompleteAnalysisNotice(shortfall: AnalysisShortfall): string {
  return `Incomplete analysis — ${shortfall.detail} Shown for information only: without ${missing(shortfall)} it cannot be a potential setup, and it was not tracked or made eligible for alerts. These levels are not a trade plan.`;
}

const GAP_WORDS: Record<DataGap, string> = {
  NOT_CHECKED: "not checked",
  UNAVAILABLE: "unavailable",
  STALE: "stale",
  INSUFFICIENT: "too short",
  INVALID: "invalid",
};

/** The short form, for a status bar or a chart caption. */
export function incompleteAnalysisLabel(shortfall: AnalysisShortfall): string {
  return `Incomplete — ${TIMEFRAME_LABELS[shortfall.timeframe]} data ${GAP_WORDS[shortfall.gap]}`;
}
