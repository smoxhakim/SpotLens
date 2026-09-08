import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { timeframeSchema } from "@/lib/market-data/schema";

import { apiError, handleRouteError } from "@/lib/api/response";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { getCandles } from "@/services/candles";
import { findMarketByPairId } from "@/services/markets";
import type { CandlesResponse } from "@/types/market";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ pairId: z.string().uuid() });

const querySchema = z.object({
  timeframe: timeframeSchema,
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

/**
 * GET /api/pairs/:pairId/candles?timeframe=&from=&to=&limit=
 * Served through the read-through candle cache.
 */
export async function GET(req: NextRequest, { params }: { params: { pairId: string } }) {
  try {
    const limited = await enforceRateLimit(req, RATE_LIMITS.marketData);
    if (limited) return limited;

    const { pairId } = paramsSchema.parse(params);
    const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      return apiError("INVALID_REQUEST", "`from` must be earlier than `to`.", 400);
    }

    const market = await findMarketByPairId(pairId);
    if (!market) return apiError("PAIR_NOT_FOUND", "Unknown trading pair.", 404);

    const result = await getCandles({
      pairId,
      exchangeSymbol: market.exchangeSymbol,
      timeframe: query.timeframe,
      limit: query.limit,
      from: query.from,
      to: query.to,
    });

    return NextResponse.json<CandlesResponse>({
      pairId,
      symbol: market.exchangeSymbol,
      timeframe: query.timeframe,
      candles: result.candles,
      stale: result.stale,
      source: result.source,
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/pairs/:pairId/candles");
  }
}
