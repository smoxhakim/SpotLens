import type { AnalysisResult } from "@/lib/analysis";
import { defaultHigherTimeframe } from "@/lib/analysis/mtf";
import type { Timeframe } from "@/lib/market-data/provider";

/**
 * Whether an analysis was read in the context a tracked setup is defined in.
 *
 * A setup is identified by user, pair and *entry* timeframe — the higher
 * timeframe is not part of its identity, and no column records it. That is
 * correct only while every writer reads the same higher timeframe for a given
 * entry timeframe: the canonical one, `defaultHigherTimeframe`. The scanner
 * always does, and fails closed otherwise; the UI always sends it. The MTF
 * route, though, accepts any longer timeframe, so an H1 analysis read against
 * D1 would reconcile against the scanner's H1-against-H4 setup — and could
 * invalidate it (D1 bearish is AVOID, no setup) or freeze a verdict into its
 * immutable snapshot that the scanner's own context never reached.
 *
 * So the context is a precondition of writing rather than a field of identity.
 * Adding the higher timeframe to identity would need a migration, could not be
 * backfilled honestly for the events (none records one), and would let two
 * open setups sit on one level — one per context — that nothing ever closes.
 *
 * A timeframe with no higher one (W1) is canonical with none. A result with no
 * higher-timeframe read on a timeframe that has one is not: that is the
 * single-timeframe analysis the routes already decline to track.
 */
export function readsCanonicalContext(timeframe: Timeframe, result: AnalysisResult): boolean {
  return (result.mtf?.higherTimeframe ?? null) === defaultHigherTimeframe(timeframe);
}
