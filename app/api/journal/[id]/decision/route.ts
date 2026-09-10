import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { updateDecision } from "@/services/journal";

import { journalDecisionSchema, journalIdSchema } from "../../validation";

export const dynamic = "force-dynamic";

/** PATCH /api/journal/:id/decision — records a change of mind. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = journalIdSchema.parse(await params);

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = journalDecisionSchema.parse(json);
    const result = await updateDecision({ userId: guard.userId, id, ...body });

    if (!result.ok) {
      const missing = result.errors[0].field === "id";
      return NextResponse.json(
        {
          error: {
            code: missing ? "JOURNAL_NOT_FOUND" : "INVALID_TRANSITION",
            message: result.errors[0].message,
          },
          errors: result.errors,
        },
        { status: missing ? 404 : 400 },
      );
    }

    return NextResponse.json(result.value);
  } catch (err) {
    return handleRouteError(err, "PATCH /api/journal/[id]/decision");
  }
}
