"use client";

import { useMemo } from "react";

import { runMarketRead, type MarketRead } from "@/lib/analysis";
import type { Candle } from "@/lib/market-data/provider";

/**
 * Runs the deterministic engine over the candles the chart already holds.
 *
 * The engine is pure, so there is no reason to round-trip to the server for a
 * read of data the client has in hand — it also means the panel updates the
 * instant a candle streams in. Phase 3 calls the very same functions on the
 * server for `POST /api/analysis/run`, where the result gets persisted.
 */
export function useMarketRead(candles: Candle[] | undefined): MarketRead | null {
  return useMemo(() => {
    if (!candles || candles.length === 0) return null;
    return runMarketRead(candles);
  }, [candles]);
}
