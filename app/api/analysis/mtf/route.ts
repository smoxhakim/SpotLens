import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { timeframeSchema } from "@/lib/market-data/schema";

import { analyzeMultiTimeframe, isValidTimeframePair, runAnalysis } from "@/lib/analysis";
import { apiError, handleRouteError } from "@/lib/api/response";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { currentUserId } from "@/lib/auth";
import { isLastCandleForming } from "@/lib/market-data/provider";
import { getCandles } from "@/services/candles";
import { findMarketByPairId } from "@/services/markets";
import { trackSetup } from "@/services/setups";
import { saveAnalysisSnapshot } from "@/services/snapshots";
import type { AnalysisRunResponse } from "@/types/analysis";

export const dynamic = "force-dynamic";

const CANDLE_LIMIT = 500;

const timeframe = timeframeSchema;

const bodySchema = z.object({
  tradingPairId: z.string().uuid(),
  lowerTimeframe: timeframe,
  higherTimeframe: timeframe,
});

/**
 * POST /api/analysis/mtf — runs the engine on the entry timeframe with the
 * higher timeframe's trend folded into the score and the status.
 */
export async function POST(req: NextRequest) {
  try {
    const userId = await currentUserId();

    const limited = await enforceRateLimit(req, RATE_LIMITS.analysis, userId);
    if (limited) return limited;

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = bodySchema.parse(json);

    if (!isValidTimeframePair(body.lowerTimeframe, body.higherTimeframe)) {
      return apiError(
        "INVALID_REQUEST",
        "The higher timeframe must be longer than the entry timeframe.",
        400,
      );
    }

    const market = await findMarketByPairId(body.tradingPairId);
    if (!market) return apiError("PAIR_NOT_FOUND", "Unknown trading pair.", 404);

    // Both timeframes come from the same cache, so a repeated run costs one
    // provider call at most.
    const [lower, higher] = await Promise.all([
      getCandles({
        pairId: market.pairId,
        exchangeSymbol: market.exchangeSymbol,
        timeframe: body.lowerTimeframe,
        limit: CANDLE_LIMIT,
      }),
      getCandles({
        pairId: market.pairId,
        exchangeSymbol: market.exchangeSymbol,
        timeframe: body.higherTimeframe,
        limit: CANDLE_LIMIT,
      }),
    ]);

    const mtf = analyzeMultiTimeframe({
      lowerCandles: lower.candles,
      higherCandles: higher.candles,
      lowerTimeframe: body.lowerTimeframe,
      higherTimeframe: body.higherTimeframe,
    });

    const result = runAnalysis(lower.candles, {
      mtf,
      lastCandleIsForming: isLastCandleForming(lower.candles),
    });

    const snapshotId = userId
      ? await saveAnalysisSnapshot({
          userId,
          tradingPairId: market.pairId,
          timeframe: body.lowerTimeframe,
          result,
        })
      : null;

    // Same lifecycle path as the single-timeframe route — one setup per pair
    // and entry timeframe, however the analysis was run.
    if (userId) {
      await trackSetup({
        userId,
        tradingPairId: market.pairId,
        timeframe: body.lowerTimeframe,
        result,
        analysisSnapshotId: snapshotId,
      });
    }

    return NextResponse.json<AnalysisRunResponse>({
      pairId: market.pairId,
      symbol: market.exchangeSymbol,
      label: market.label,
      timeframe: body.lowerTimeframe,
      asOf: lower.candles.at(-1)?.openTime ?? 0,
      snapshotId,
      result,
    });
  } catch (err) {
    return handleRouteError(err, "POST /api/analysis/mtf");
  }
}
