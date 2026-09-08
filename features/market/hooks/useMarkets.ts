"use client";

import { useQuery } from "@tanstack/react-query";

import type { MarketSummary, MarketsResponse } from "@/types/market";

import { fetchApi } from "./fetch-api";

/** Curated spot markets available in the selector. */
export function useMarkets() {
  return useQuery<MarketSummary[]>({
    queryKey: ["markets"],
    queryFn: async () => {
      const data = await fetchApi<MarketsResponse>("/api/markets");
      return data.markets;
    },
    staleTime: 10 * 60_000,
  });
}
