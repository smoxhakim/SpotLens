import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { timeframeSchema } from "@/lib/market-data/schema";
import { listSetups } from "@/services/setups";

export const dynamic = "force-dynamic";

const LIFECYCLE_STATUSES = [
  "SETUP_FORMING",
  "WAITING_CONFIRMATION",
  "CONFIRMATION_DETECTED",
  "POTENTIAL_SETUP",
  "INVALIDATED",
] as const;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(LIFECYCLE_STATUSES).optional(),
  tradingPairId: z.string().uuid().optional(),
  timeframe: timeframeSchema.optional(),
});

/**
 * GET /api/setups — the caller's tracked setups, newest first.
 *
 * Read-only by design. Setups are created by the analysis lifecycle, never by
 * a client: an endpoint that let anyone post a setup would let them write
 * history the engine never produced.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Tracking setups over time needs a database. Set DATABASE_URL and run the migrations.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    const setups = await listSetups({ userId: guard.userId, ...query });

    return NextResponse.json({ setups });
  } catch (err) {
    return handleRouteError(err, "GET /api/setups");
  }
}
