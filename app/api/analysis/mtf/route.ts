import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { timeframeSchema } from "@/lib/market-data/schema";

import {
  analyzeMultiTimeframe,
  assessHigherTimeframe,
  isValidTimeframePair,
  runAnalysis,
  staleEntryTimeframe,
  unavailableHigherTimeframe,
  type AnalysisShortfall,
} from "@/lib/analysis";
import { apiError, handleRouteError } from "@/lib/api/response";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { currentUserId } from "@/lib/auth";
import { isLastCandleForming, type Candle } from "@/lib/market-data/provider";
import { closedCandlesOnly } from "@/lib/scanner";
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
    // provider call at most. The entry timeframe is required; the higher one is
    // assessed, and a failure there is a shortfall rather than an error.
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
      }).catch(() => null),
    ]);

    // Fail closed: without a usable higher timeframe the analysis is shown for
    // information only — never POTENTIAL_SETUP, never tracked. Its candles are
    // not folded in when they are stale, short or invalid.
    //
    // Closed higher-timeframe candles only, for the trend read as well as the
    // check: a higher candle still forming can turn its trend before it closes,
    // and the scanner never reads one. One clock reading for every decision.
    const now = Date.now();
    const higherClosed = higher ? closedCandlesOnly<Candle>(higher.candles, now) : [];
    const higherShortfall: AnalysisShortfall | null = higher
      ? assessHigherTimeframe({
          candles: higherClosed,
          timeframe: body.higherTimeframe,
          now,
          servedStale: higher.stale,
        })
      : unavailableHigherTimeframe(body.higherTimeframe, "UNAVAILABLE");

    const mtf =
      higher && !higherShortfall
        ? analyzeMultiTimeframe({
            lowerCandles: lower.candles,
            higherCandles: higherClosed,
            lowerTimeframe: body.lowerTimeframe,
            higherTimeframe: body.higherTimeframe,
          })
        : undefined;

    // Stale entry candles first: an analysis of old candles is the more basic
    // problem, whatever the higher timeframe says.
    const incomplete = lower.stale ? staleEntryTimeframe(body.lowerTimeframe) : higherShortfall;

    const lastCandleIsForming = isLastCandleForming(lower.candles, now);

    // Named properties, not spreads: a spread is not checked for unknown keys,
    // and a misspelt option here would silently drop the gate.
    const result = runAnalysis(lower.candles, {
      mtf,
      incomplete: incomplete ?? undefined,
      lastCandleIsForming,
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
    // and entry timeframe, however the analysis was run. Never from an
    // incomplete analysis (stale entry candles, or no usable higher timeframe):
    // a setup must not be created or moved from data unfit to decide on. Nor
    // while the entry candle is still forming: a tracked setup's snapshot is
    // written once, and its state would come from a price the candle may not
    // close at — which the scanner, reading closed candles only, would then
    // move back. The result is still shown and recorded; the scanner tracks it
    // once the candle has closed.
    if (userId && !result.incomplete && !lastCandleIsForming) {
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
