import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/response";
import { calculatePositionSize } from "@/lib/analysis";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  balance: z.number().positive().finite(),
  riskPercent: z.number().positive().max(100),
  entry: z.number().positive().finite(),
  stopLoss: z.number().positive().finite(),
});

/** POST /api/risk/position-size — stateless, public. */
export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = bodySchema.parse(json);

    const result = calculatePositionSize(body);
    if (!result) {
      return apiError(
        "INVALID_REQUEST",
        "The stop loss must be below the entry price for a spot long.",
        400,
      );
    }

    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err, "POST /api/risk/position-size");
  }
}
