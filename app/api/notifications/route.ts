import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { listNotifications, unreadCount } from "@/services/notifications";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unreadOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
});

/** GET /api/notifications — the caller's in-app notifications, newest first. */
export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Notifications are stored, so they need a database.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    const [notifications, unread] = await Promise.all([
      listNotifications({ userId: guard.userId, ...query }),
      unreadCount(guard.userId),
    ]);

    return NextResponse.json({ notifications, unread });
  } catch (err) {
    return handleRouteError(err, "GET /api/notifications");
  }
}
