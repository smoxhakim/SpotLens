import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { buildReplayFrame } from "@/services/replay";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ setupId: z.string().uuid() });
const querySchema = z.object({
  /** The moment to reconstruct. Defaults to the decision, then the setup. */
  at: z.coerce.number().int().positive().optional(),
});

/**
 * GET /api/replay/:setupId — reconstructs what was knowable at a moment.
 *
 * Reads persisted candles only and never fetches, so the same request returns
 * the same reconstruction whenever it is made. A setup belonging to someone
 * else returns 404.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ setupId: string }> }) {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Replay reads stored history, so it needs a database.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { setupId } = paramsSchema.parse(await params);
    const { at } = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    const frame = await buildReplayFrame({ userId: guard.userId, setupId, at });
    if (!frame) return apiError("SETUP_NOT_FOUND", "No such setup.", 404);

    return NextResponse.json({ frame });
  } catch (err) {
    return handleRouteError(err, "GET /api/replay/[setupId]");
  }
}
