import { NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { markRead } from "@/services/notifications";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/notifications/:id/read
 *
 * Ownership is enforced inside the update's `where`, so another account's
 * notification simply matches nothing and returns 404 — the endpoint cannot be
 * used to discover which ids exist.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(await params);

    const updated = await markRead(guard.userId, id);
    if (!updated) return apiError("NOTIFICATION_NOT_FOUND", "No such notification.", 404);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "POST /api/notifications/[id]/read");
  }
}
