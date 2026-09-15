import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { parseBotParam } from "@/lib/api/telegram-bot-param";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { claimTelegramConnection } from "@/services/notifications";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/telegram/claim — looks for the code and binds the chat.
 *
 * Polled by Settings while the connect dialog is open. Polling rather than a
 * webhook because SpotLens is local-only: a webhook would mean exposing this
 * machine to the internet to receive a message the user is about to send.
 *
 * Wrong codes are counted server-side and the code is burned after ten, so the
 * short code cannot be brute-forced inside its ten-minute window. The counter
 * tracks guesses sent to the bot rather than polls, which is why this route has
 * its own, roomier rate limit: a poll that finds nothing is not an attempt.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "Telegram connections are stored in the database.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const limited = await enforceRateLimit(req, RATE_LIMITS.telegramClaim, guard.userId);
    if (limited) return limited;

    const bot = parseBotParam(req.nextUrl.searchParams.get("bot"));
    if (!bot) return apiError("INVALID_REQUEST", "Unknown Telegram bot.", 400);

    return NextResponse.json({ result: await claimTelegramConnection(guard.userId, bot) });
  } catch (err) {
    return handleRouteError(err, "POST /api/notifications/telegram/claim");
  }
}
