import type { ShortlistCandidate } from "@/lib/scanner";
import type { Timeframe } from "@/lib/market-data/provider";

/**
 * What `/api/scanner/shortlist` returns, as the page sees it.
 *
 * `ShortlistCandidate` is imported rather than restated: the shape the page
 * renders is the shape Phase L produced, and a second declaration of it here
 * would be free to drift from the one that matters.
 */
export interface ShortlistResponse {
  run: {
    id: string;
    startedAt: string;
    completedAt: string | null;
    status: string;
    timeframes: Timeframe[];
    triggeredBy: string;
    marketCount: number;
  };
  totalAnalysed: number;
  totalEligible: number;
  excluded: Record<string, number>;
  rankingVersion: number;
  candidates: ShortlistCandidate[];
}

export type { ShortlistCandidate };

/**
 * How many of the canonical list to show.
 *
 * A count, not a ranking: each view is a prefix of the one order Phase L
 * produced, so moving between them can add and remove entries from the bottom
 * and can never change what sits above.
 */
export const VIEW_SIZES = { top5: 5, top10: 10, top15: 15, all: Number.POSITIVE_INFINITY } as const;
export type ViewSize = keyof typeof VIEW_SIZES;

export const VIEW_LABELS: Record<ViewSize, string> = {
  top5: "Top 5",
  top10: "Top 10",
  top15: "Top 15",
  all: "All",
};

export const DEFAULT_VIEW: ViewSize = "top5";

export function isViewSize(value: string | null | undefined): value is ViewSize {
  return value !== null && value !== undefined && value in VIEW_SIZES;
}

/** Timeframe filter. "all" is not a timeframe, so it is spelled out separately. */
export type TimeframeFilter = "all" | Timeframe;

export function isTimeframeFilter(
  value: string | null | undefined,
  available: readonly Timeframe[],
): value is TimeframeFilter {
  if (value === "all") return true;
  return value !== null && value !== undefined && (available as readonly string[]).includes(value);
}

/**
 * The candidates to render, in the order Phase L put them in.
 *
 * Filter, then take from the front. Both operations preserve relative order —
 * `filter` and a prefix `slice` cannot move an entry above one that outranked
 * it — so the sequence on screen is always a subsequence of the canonical one.
 * There is no comparison function anywhere in this file, and that is the point:
 * the page has no opinion about which candidate is better.
 *
 * Filtering happens first so that asking for H1 and Top 5 gives five H1
 * candidates rather than however many of the overall top five happened to be
 * H1. Each card still shows its canonical rank, so a filtered list reading
 * #2 #3 #5 #7 #9 says plainly where those entries sit in the whole.
 */
export function visibleCandidates(
  candidates: readonly ShortlistCandidate[],
  view: ViewSize,
  timeframe: TimeframeFilter,
): ShortlistCandidate[] {
  const filtered =
    timeframe === "all" ? [...candidates] : candidates.filter((c) => c.timeframe === timeframe);

  const size = VIEW_SIZES[view];
  return Number.isFinite(size) ? filtered.slice(0, size) : filtered;
}
