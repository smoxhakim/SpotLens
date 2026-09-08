import { NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/** GET /api/analysis/:id — owner only. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(params);
    const snapshot = await prisma.analysisSnapshot.findUnique({ where: { id } });

    if (!snapshot || snapshot.userId !== guard.userId) {
      return apiError("NOT_FOUND", "That analysis does not exist.", 404);
    }

    return NextResponse.json({ snapshot });
  } catch (err) {
    return handleRouteError(err, "GET /api/analysis/:id");
  }
}

/** DELETE /api/analysis/:id — owner only. */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(params);
    const snapshot = await prisma.analysisSnapshot.findUnique({
      where: { id },
      select: { userId: true },
    });

    if (!snapshot || snapshot.userId !== guard.userId) {
      return apiError("NOT_FOUND", "That analysis does not exist.", 404);
    }

    await prisma.analysisSnapshot.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/analysis/:id");
  }
}
