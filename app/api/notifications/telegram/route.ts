import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { parseBotParam } from "@/lib/api/telegram-bot-param";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { disconnectTelegram, getTelegramStatus } from "@/services/notifications";

export const dynamic = "force-dynamic";

/**
 * GET /api/notifications/telegram — connection status for one bot.
 *
 * Reports whether that bot's token is configured on the server, and which
 * variable to set when it is not — never the token itself. No response from
 * this route, or any other, contains one.
 *
 * `?bot=CONFIRMATION` asks about the confirmation bot; absent means the main
 * one, so every existing caller keeps working unchanged.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "Telegram connections are stored in the database.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const bot = parseBotParam(req.nextUrl.searchParams.get("bot"));
    if (!bot) return apiError("INVALID_REQUEST", "Unknown Telegram bot.", 400);

    return NextResponse.json({ telegram: await getTelegramStatus(guard.userId, bot) });
  } catch (err) {
    return handleRouteError(err, "GET /api/notifications/telegram");
  }
}

/**
 * DELETE — unbinds one bot's chat and turns that bot's own switch off.
 *
 * Scoped to the bot named, so disconnecting confirmation alerts leaves the main
 * bot connected and delivering.
 */
export async function DELETE(req: NextRequest) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const bot = parseBotParam(req.nextUrl.searchParams.get("bot"));
    if (!bot) return apiError("INVALID_REQUEST", "Unknown Telegram bot.", 400);

    await disconnectTelegram(guard.userId, bot);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "DELETE /api/notifications/telegram");
  }
}
