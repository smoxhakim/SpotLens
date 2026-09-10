import { NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { findEntry } from "@/services/journal";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * GET /api/journal/:id — one entry, with the engine's record and the user's
 * decision history side by side.
 *
 * Another account's entry returns 404 rather than 403: a 403 would confirm the
 * id exists.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(await params);

    const entry = await findEntry(guard.userId, id);
    if (!entry) return apiError("JOURNAL_NOT_FOUND", "No such journal entry.", 404);

    return NextResponse.json({ entry });
  } catch (err) {
    return handleRouteError(err, "GET /api/journal/[id]");
  }
}
