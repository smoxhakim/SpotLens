import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { RATE_LIMITS, enforceRateLimit } from "@/lib/rate-limit";
import { sendTelegramTest } from "@/services/notifications";

export const dynamic = "force-dynamic";

/**
 * POST /api/notifications/telegram/test — sends the connection test message.
 *
 * The message says nothing about any market. A "test" that described a trade
 * would be a trading notification wearing a different hat.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "Telegram connections are stored in the database.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const limited = await enforceRateLimit(req, RATE_LIMITS.telegramTest, guard.userId);
    if (limited) return limited;

    const result = await sendTelegramTest(guard.userId);

    // The error is already sanitised by the provider; it can never carry the
    // token, because the provider strips it before returning.
    return NextResponse.json({ ok: result.ok, error: result.error });
  } catch (err) {
    return handleRouteError(err, "POST /api/notifications/telegram/test");
  }
}
