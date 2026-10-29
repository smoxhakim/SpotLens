import { analysisFreshness, combinedFreshness } from "@/lib/scanner/freshness";

import type { ShortlistCandidate, ShortlistResponse } from "./types";

/**
 * Freshness of one candidate: the candle it was analysed on, against the clock.
 * Falls back to when the pass started only when the candle was not stored.
 */
export function candidateFreshness(
  candidate: ShortlistCandidate,
  run: ShortlistResponse["run"],
  now: number,
) {
  return analysisFreshness({
    timeframe: candidate.timeframe,
    analysedCandleOpen: candidate.analysedAtCandle,
    scannedAt: Date.parse(run.startedAt),
    now,
  });
}

/**
 * Freshness of a whole shortlist as shown: its candidates when it has any, the
 * pass's own timeframes when it has none — an empty list is a claim about the
 * market too.
 */
export function shortlistFreshness(data: ShortlistResponse, now: number) {
  const entries =
    data.candidates.length > 0
      ? data.candidates.map((candidate) => ({
          timeframe: candidate.timeframe,
          freshness: candidateFreshness(candidate, data.run, now),
        }))
      : data.run.timeframes.map((timeframe) => ({
          timeframe,
          freshness: analysisFreshness({
            timeframe,
            scannedAt: Date.parse(data.run.startedAt),
            now,
          }),
        }));
  return combinedFreshness(entries);
}

/** When the pass finished, for the notice — or when it started, if it never recorded a finish. */
export function scanTime(run: ShortlistResponse["run"]): number | null {
  const at = Date.parse(run.completedAt ?? run.startedAt);
  return Number.isFinite(at) ? at : null;
}
