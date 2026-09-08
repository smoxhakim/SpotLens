"use client";

import { useMutation } from "@tanstack/react-query";

import { fetchApi } from "@/features/market/hooks/fetch-api";
import type { Timeframe } from "@/lib/market-data/provider";
import type { AnalysisRunResponse } from "@/types/analysis";

/**
 * Runs the full analysis on the server.
 *
 * A mutation rather than a query on purpose: it is an explicit user action with
 * a result they read once, not ambient data to keep fresh — and re-running it
 * silently under them would change the numbers they are looking at.
 */
interface AnalysisInput {
  pairId: string;
  timeframe: Timeframe;
  /** When set, the run is checked against this higher timeframe. */
  higherTimeframe?: Timeframe | null;
}

export function useAnalysis() {
  return useMutation<AnalysisRunResponse, Error, AnalysisInput>({
    mutationFn: ({ pairId, timeframe, higherTimeframe }) =>
      higherTimeframe
        ? fetchApi<AnalysisRunResponse>("/api/analysis/mtf", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              tradingPairId: pairId,
              lowerTimeframe: timeframe,
              higherTimeframe,
            }),
          })
        : fetchApi<AnalysisRunResponse>("/api/analysis/run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tradingPairId: pairId, timeframe }),
          }),
  });
}
