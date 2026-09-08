"use client";

import { useQuery } from "@tanstack/react-query";

import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";
import type { CandlesResponse } from "@/types/market";

import { fetchApi } from "./fetch-api";

interface UseCandlesOptions {
  pairId?: string;
  timeframe: Timeframe;
  limit?: number;
}

/**
 * Historical candles from the read-through cache. Polling is a safety net for
 * the WebSocket stream, so it runs at a fraction of the candle duration.
 */
export function useCandles({ pairId, timeframe, limit = 300 }: UseCandlesOptions) {
  return useQuery<CandlesResponse>({
    queryKey: ["candles", pairId, timeframe, limit],
    enabled: Boolean(pairId),
    queryFn: () =>
      fetchApi<CandlesResponse>(
        `/api/pairs/${pairId}/candles?timeframe=${timeframe}&limit=${limit}`,
      ),
    staleTime: Math.min(TIMEFRAME_MS[timeframe] / 4, 60_000),
    refetchInterval: Math.min(TIMEFRAME_MS[timeframe] / 2, 120_000),
  });
}
