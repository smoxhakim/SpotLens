import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { parseBotParam } from "@/lib/api/telegram-bot-param";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { isTelegramConfigured, tokenVariableFor } from "@/lib/notifications";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { CONNECTION_CODE_TTL_MS, beginTelegramConnection } from "@/services/notifications";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/telegram/connect — issues a one-time code.
 *
 * The code is returned exactly once, to the authenticated caller, and only its
 * hash is stored. Because it is bound to the session that requested it, one
 * account cannot use it to attach a chat to another.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "Telegram connections are stored in the database.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const limited = await enforceRateLimit(req, RATE_LIMITS.telegramConnect, guard.userId);
    if (limited) return limited;

    const bot = parseBotParam(req.nextUrl.searchParams.get("bot"));
    if (!bot) return apiError("INVALID_REQUEST", "Unknown Telegram bot.", 400);

    if (!isTelegramConfigured(bot)) {
      return apiError(
        "TELEGRAM_NOT_CONFIGURED",
        // Names the variable rather than assuming which bot is missing: with
        // two of them, "add TELEGRAM_BOT_TOKEN" is advice that cannot work
        // half the time.
        `No bot token is set on this machine. Add ${tokenVariableFor(bot)} to .env and restart.`,
        503,
      );
    }

    const { code } = await beginTelegramConnection(guard.userId, bot);

    return NextResponse.json({ code, expiresInMs: CONNECTION_CODE_TTL_MS });
  } catch (err) {
    return handleRouteError(err, "POST /api/notifications/telegram/connect");
  }
}
