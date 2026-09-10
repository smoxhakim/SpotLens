import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { timeframeSchema } from "@/lib/market-data/schema";
import { runResearch } from "@/services/research";

import { decisionSchema } from "../journal/validation";

export const dynamic = "force-dynamic";

/**
 * Every filter is deterministic and explicit. Nothing here ranks markets to
 * trade or infers anything — the report describes a sample of history.
 */
const querySchema = z.object({
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  symbol: z.string().min(1).max(20).optional(),
  timeframe: timeframeSchema.optional(),
  decision: decisionSchema.optional(),
  lifecycleStatus: z
    .enum([
      "SETUP_FORMING",
      "WAITING_CONFIRMATION",
      "CONFIRMATION_DETECTED",
      "POTENTIAL_SETUP",
      "INVALIDATED",
    ])
    .optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  confirmation: z.enum(["PRESENT", "NOT_PRESENT"]).optional(),
  regimeDirection: z.enum(["TRENDING_UP", "TRENDING_DOWN", "RANGE", "UNCLEAR"]).optional(),
  volatility: z.enum(["HIGH", "NORMAL", "LOW"]).optional(),
  measuredRewardOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
});

/** GET /api/research — descriptive statistics over the caller's own history. */
export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Research reads stored history, so it needs a database.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const filters = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    return NextResponse.json({
      report: await runResearch({ userId: guard.userId, filters }),
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/research");
  }
}
