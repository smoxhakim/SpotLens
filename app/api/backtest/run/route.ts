import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { BACKTEST_DISCLAIMER } from "@/lib/constants/disclaimers";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { MAX_BACKTEST_CANDLES, estimateCandles, executeBacktest } from "@/services/backtests";
import { findMarketByPairId } from "@/services/markets";

export const dynamic = "force-dynamic";
/** A synchronous replay of up to 1000 bars needs more than the default budget. */
export const maxDuration = 60;

const bodySchema = z.object({
  tradingPairId: z.string().uuid(),
  timeframe: z.enum(["M15", "H1", "H4", "D1", "W1"]),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
});

/** POST /api/backtest/run — runs synchronously and returns the finished report. */
export async function POST(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Backtesting stores its results, so it needs a database. Set DATABASE_URL and run the migrations.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const limited = await enforceRateLimit(req, RATE_LIMITS.backtest, guard.userId);
    if (limited) return limited;

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = bodySchema.parse(json);

    if (body.startDate >= body.endDate) {
      return apiError("INVALID_REQUEST", "The start date must be before the end date.", 400);
    }

    const estimated = estimateCandles(body.startDate, body.endDate, body.timeframe);
    if (estimated > MAX_BACKTEST_CANDLES) {
      return apiError(
        "RANGE_TOO_LARGE",
        `That range needs about ${estimated} candles; the limit is ${MAX_BACKTEST_CANDLES} per run. Shorten the range or use a higher timeframe.`,
        400,
      );
    }

    const market = await findMarketByPairId(body.tradingPairId);
    if (!market) return apiError("PAIR_NOT_FOUND", "Unknown trading pair.", 404);

    const result = await executeBacktest({
      userId: guard.userId,
      tradingPairId: market.pairId,
      exchangeSymbol: market.exchangeSymbol,
      timeframe: body.timeframe,
      startDate: body.startDate,
      endDate: body.endDate,
    });

    return NextResponse.json({
      runId: result.runId,
      label: market.label,
      timeframe: body.timeframe,
      candlesUsed: result.candlesUsed,
      metrics: result.metrics,
      setups: result.setups,
      disclaimer: BACKTEST_DISCLAIMER,
    });
  } catch (err) {
    return handleRouteError(err, "POST /api/backtest/run");
  }
}
