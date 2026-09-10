import { NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { findSetup } from "@/services/setups";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * GET /api/setups/:id — one tracked setup with its full event history.
 *
 * A setup belonging to someone else returns 404 rather than 403, so the
 * endpoint cannot be used to discover which ids exist on other accounts. Same
 * rule as every other user-scoped handler.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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

    const { id } = paramsSchema.parse(await params);

    const setup = await findSetup(guard.userId, id);
    if (!setup) return apiError("SETUP_NOT_FOUND", "No such setup.", 404);

    return NextResponse.json({ setup });
  } catch (err) {
    return handleRouteError(err, "GET /api/setups/[id]");
  }
}
