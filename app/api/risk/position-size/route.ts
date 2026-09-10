import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/response";
import { calculateRisk } from "@/lib/risk";

export const dynamic = "force-dynamic";

/**
 * Bounds are generous but finite. The calculation is pure and stateless, so
 * this endpoint stores nothing and needs no account — but it still refuses
 * absurd input rather than returning an absurd answer.
 */
const bodySchema = z
  .object({
    balance: z.number().positive().finite(),
    riskPercent: z.number().positive().max(100),
    entry: z.number().positive().finite(),
    stopLoss: z.number().positive().finite(),
    takeProfit: z.number().positive().finite().optional(),
    maxExposurePercent: z.number().positive().max(100).optional(),
    feeRate: z.number().min(0).max(0.1).optional(),
    slippageRate: z.number().min(0).max(0.1).optional(),
    takeProfitIsSynthetic: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/risk/position-size — stateless, public, and it computes nothing
 * about whether to trade.
 *
 * Returns the structured errors from the calculator rather than a bare 400, so
 * a caller can say which field is wrong. There is no order path here and no
 * exchange credential: this endpoint does arithmetic.
 */
export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = bodySchema.parse(json);
    const result = calculateRisk(body);

    if (!result.ok) {
      return NextResponse.json(
        {
          error: {
            code: "INVALID_RISK_INPUT",
            message: result.errors[0]?.message ?? "The inputs do not describe a valid spot long.",
          },
          errors: result.errors,
        },
        { status: 400 },
      );
    }

    return NextResponse.json(result.calculation);
  } catch (err) {
    return handleRouteError(err, "POST /api/risk/position-size");
  }
}
