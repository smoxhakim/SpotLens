import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { isTelegramConfigured } from "@/lib/notifications";
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

    if (!isTelegramConfigured()) {
      return apiError(
        "TELEGRAM_NOT_CONFIGURED",
        "No bot token is set on this machine. Add TELEGRAM_BOT_TOKEN to .env and restart.",
        503,
      );
    }

    const { code } = await beginTelegramConnection(guard.userId);

    return NextResponse.json({ code, expiresInMs: CONNECTION_CODE_TTL_MS });
  } catch (err) {
    return handleRouteError(err, "POST /api/notifications/telegram/connect");
  }
}
