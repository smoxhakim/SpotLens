import { NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/** GET /api/analysis/:id — owner only. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(await params);

    // Scoped in the `where`, not filtered afterwards: another account's row
    // never enters this process, so no later change to what is returned can
    // leak one. Missing and not-yours are the same 404, so the endpoint cannot
    // be used to discover which ids exist.
    const snapshot = await prisma.analysisSnapshot.findFirst({
      where: { id, userId: guard.userId },
    });

    if (!snapshot) {
      return apiError("NOT_FOUND", "That analysis does not exist.", 404);
    }

    return NextResponse.json({ snapshot });
  } catch (err) {
    return handleRouteError(err, "GET /api/analysis/:id");
  }
}

/** DELETE /api/analysis/:id — owner only. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(await params);

    // One scoped statement rather than a check and then an unscoped delete:
    // the ownership condition is part of the write, so it cannot be separated
    // from it by a later edit.
    const { count } = await prisma.analysisSnapshot.deleteMany({
      where: { id, userId: guard.userId },
    });

    if (count === 0) {
      return apiError("NOT_FOUND", "That analysis does not exist.", 404);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/analysis/:id");
  }
}
