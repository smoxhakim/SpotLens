import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/response";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { getMarketDataProvider } from "@/lib/market-data";
import { findMarketByPairId } from "@/services/markets";
import type { TickerResponse } from "@/types/market";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ pairId: z.string().uuid() });

/** GET /api/pairs/:pairId/ticker — last price and 24h change. */
export async function GET(req: Request, { params }: { params: { pairId: string } }) {
  try {
    const limited = await enforceRateLimit(req, RATE_LIMITS.marketData);
    if (limited) return limited;

    const { pairId } = paramsSchema.parse(params);

    const market = await findMarketByPairId(pairId);
    if (!market) return apiError("PAIR_NOT_FOUND", "Unknown trading pair.", 404);

    const ticker = await getMarketDataProvider().getTicker(market.exchangeSymbol);

    return NextResponse.json<TickerResponse>({
      pairId,
      symbol: market.exchangeSymbol,
      ticker,
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/pairs/:pairId/ticker");
  }
}
