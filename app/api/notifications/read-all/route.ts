import { NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { handleRouteError } from "@/lib/api/response";
import { markAllRead } from "@/services/notifications";

export const dynamic = "force-dynamic";

/** POST /api/notifications/read-all — marks every unread one read. */
export async function POST() {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    return NextResponse.json({ marked: await markAllRead(guard.userId) });
  } catch (err) {
    return handleRouteError(err, "POST /api/notifications/read-all");
  }
}
