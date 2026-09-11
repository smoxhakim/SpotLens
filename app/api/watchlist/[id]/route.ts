import { NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/** DELETE /api/watchlist/:id — owner only. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(await params);

    // One scoped statement: the ownership condition is part of the delete
    // rather than a separate check before an unscoped one. Same 404 whether
    // the row is missing or belongs to someone else, so this cannot be used to
    // probe for other users' rows.
    const { count } = await prisma.watchlist.deleteMany({
      where: { id, userId: guard.userId },
    });

    if (count === 0) {
      return apiError("NOT_FOUND", "That watchlist entry does not exist.", 404);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/watchlist/:id");
  }
}
