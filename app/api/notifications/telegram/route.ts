import { NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { disconnectTelegram, getTelegramStatus } from "@/services/notifications";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/telegram — connection status.
 *
 * Reports whether a bot token is configured on the server, never the token. No
 * response from this route, or any other, contains it.
 */
export async function GET() {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "Telegram connections are stored in the database.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    return NextResponse.json({ telegram: await getTelegramStatus(guard.userId) });
  } catch (err) {
    return handleRouteError(err, "GET /api/notifications/telegram");
  }
}

/** DELETE — unbinds the chat and turns the channel off. */
export async function DELETE() {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    await disconnectTelegram(guard.userId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/notifications/telegram");
  }
}
