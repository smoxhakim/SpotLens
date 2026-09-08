"use client";

import { useQuery } from "@tanstack/react-query";

import type { TickerResponse } from "@/types/market";

import { fetchApi } from "./fetch-api";

/** 24h stats for the header. Live price arrives separately over WebSocket. */
export function useTicker(pairId?: string) {
  return useQuery<TickerResponse>({
    queryKey: ["ticker", pairId],
    enabled: Boolean(pairId),
    queryFn: () => fetchApi<TickerResponse>(`/api/pairs/${pairId}/ticker`),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
