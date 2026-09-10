import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { recordOutcome } from "@/services/journal";

import { journalIdSchema, journalOutcomeSchema } from "../../validation";

export const dynamic = "force-dynamic";

/** POST /api/journal/:id/outcome — records what a taken position actually did. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = journalIdSchema.parse(await params);

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const { close, ...outcome } = journalOutcomeSchema.parse(json);

    const result = await recordOutcome({ userId: guard.userId, id, outcome, close });

    if (!result.ok) {
      const missing = result.errors[0].field === "id";
      return NextResponse.json(
        {
          error: {
            code: missing ? "JOURNAL_NOT_FOUND" : "INVALID_OUTCOME",
            message: result.errors[0].message,
          },
          errors: result.errors,
        },
        { status: missing ? 404 : 400 },
      );
    }

    return NextResponse.json(result.value);
  } catch (err) {
    return handleRouteError(err, "POST /api/journal/[id]/outcome");
  }
}
