import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/response";
import { runAnalysis } from "@/lib/analysis";
import { currentUserId } from "@/lib/auth";
import { getCandles } from "@/services/candles";
import { findMarketByPairId } from "@/services/markets";
import { saveAnalysisSnapshot } from "@/services/snapshots";
import type { AnalysisRunResponse } from "@/types/analysis";

export const dynamic = "force-dynamic";

/**
 * Enough history for the EMA 200 to be defined with room to spare, and for the
 * swing series to have something to say.
 */
const CANDLE_LIMIT = 500;

const bodySchema = z.object({
  tradingPairId: z.string().uuid(),
  timeframe: z.enum(["M15", "H1", "H4", "D1", "W1"]),
});

/**
 * POST /api/analysis/run — runs the deterministic engine for one pair and
 * timeframe.
 *
 * Auth is optional: anonymous runs work and are simply not recorded. Saving
 * history must never be a precondition for getting an answer.
 */
export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = bodySchema.parse(json);

    const market = await findMarketByPairId(body.tradingPairId);
    if (!market) return apiError("PAIR_NOT_FOUND", "Unknown trading pair.", 404);

    const { candles } = await getCandles({
      pairId: market.pairId,
      exchangeSymbol: market.exchangeSymbol,
      timeframe: body.timeframe,
      limit: CANDLE_LIMIT,
    });

    const result = runAnalysis(candles);

    const userId = await currentUserId();
    const snapshotId = userId
      ? await saveAnalysisSnapshot({
          userId,
          tradingPairId: market.pairId,
          timeframe: body.timeframe,
          result,
        })
      : null;

    return NextResponse.json<AnalysisRunResponse>({
      snapshotId,
      pairId: market.pairId,
      symbol: market.exchangeSymbol,
      label: market.label,
      timeframe: body.timeframe,
      asOf: candles.at(-1)?.openTime ?? 0,
      result,
    });
  } catch (err) {
    return handleRouteError(err, "POST /api/analysis/run");
  }
}
