import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { getPreferences, updatePreferences } from "@/services/notifications";

export const dynamic = "force-dynamic";

/**
 * Every field optional so the UI can send one toggle at a time, and `strict()`
 * so an unknown key is rejected rather than silently ignored.
 */
const patchSchema = z
  .object({
    inAppEnabled: z.boolean(),
    telegramEnabled: z.boolean(),
    setupDetected: z.boolean(),
    confirmationDetected: z.boolean(),
    setupInvalidated: z.boolean(),
    structureChanged: z.boolean(),
    dailySummary: z.boolean(),
    systemError: z.boolean(),
  })
  .strict()
  .partial();

export async function GET() {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Notification settings are stored in the database.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    return NextResponse.json({ preferences: await getPreferences(guard.userId) });
  } catch (err) {
    return handleRouteError(err, "GET /api/notifications/preferences");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Notification settings are stored in the database.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const patch = patchSchema.parse(json);

    return NextResponse.json({ preferences: await updatePreferences(guard.userId, patch) });
  } catch (err) {
    return handleRouteError(err, "PATCH /api/notifications/preferences");
  }
}
