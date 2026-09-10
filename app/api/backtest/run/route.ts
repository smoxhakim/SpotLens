import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { timeframeSchema } from "@/lib/market-data/schema";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { BACKTEST_DISCLAIMER } from "@/lib/constants/disclaimers";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import {
  MAX_EVALUATED_CANDLES,
  MAX_MARKETS_PER_RUN,
  estimateCandles,
  executeBacktest,
} from "@/services/backtests";

export const dynamic = "force-dynamic";

/**
 * Paged history over several markets takes longer than a single request used
 * to. Still synchronous, still local, still bounded by the candle ceiling.
 */
export const maxDuration = 300;

const bodySchema = z
  .object({
    // Accepts one pair or several, so symbol breakdowns are a real comparison
    // rather than a one-row table. Bounded, because each market pages its own
    // history.
    tradingPairIds: z.array(z.string().uuid()).min(1).max(MAX_MARKETS_PER_RUN),
    timeframes: z.array(timeframeSchema).min(1).max(4),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    /** Round-trip taker fee per side, as a fraction. Capped at a sane 1%. */
    feeRate: z.number().min(0).max(0.01).optional(),
    slippageRate: z.number().min(0).max(0.01).optional(),
  })
  .strict();

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

    // Charged per market and timeframe: three markets on two timeframes is six
    // datasets to page, not one.
    const perDataset = Math.max(
      ...body.timeframes.map((tf) => estimateCandles(body.startDate, body.endDate, tf)),
    );
    const datasets = body.tradingPairIds.length * body.timeframes.length;
    const estimated = perDataset * datasets;

    if (estimated > MAX_EVALUATED_CANDLES) {
      return apiError(
        "RANGE_TOO_LARGE",
        `That request needs about ${estimated} candles to evaluate across ${datasets} ${
          datasets === 1 ? "dataset" : "datasets"
        }; the limit is ${MAX_EVALUATED_CANDLES} per run. Shorten the range, use a higher timeframe, or pick fewer markets.`,
        400,
      );
    }

    const result = await executeBacktest({
      userId: guard.userId,
      tradingPairIds: body.tradingPairIds,
      timeframes: body.timeframes,
      startDate: body.startDate,
      endDate: body.endDate,
      feeRate: body.feeRate,
      slippageRate: body.slippageRate,
    });

    return NextResponse.json({
      runId: result.runId,
      // Everything needed to answer "what exactly did I test?" — the
      // assumptions and the data actually obtained, not just the numbers.
      assumptions: result.assumptions,
      datasets: result.datasets,
      metrics: result.metrics,
      setups: result.setups,
      bySymbol: result.bySymbol,
      byTimeframe: result.byTimeframe,
      byScoreBand: result.byScoreBand,
      byTargetKind: result.byTargetKind,
      byRegime: result.byRegime,
      byVolatility: result.byVolatility,
      disclaimer: BACKTEST_DISCLAIMER,
    });
  } catch (err) {
    return handleRouteError(err, "POST /api/backtest/run");
  }
}
