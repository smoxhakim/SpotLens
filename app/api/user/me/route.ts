import { NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

/** GET /api/user/me — the caller's profile and defaults. */
export async function GET() {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const user = await prisma.user.findUnique({
      where: { id: guard.userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        plan: true,
        defaultRiskPercent: true,
        defaultTimeframe: true,
      },
    });

    return NextResponse.json({
      user: user && { ...user, defaultRiskPercent: Number(user.defaultRiskPercent) },
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/user/me");
  }
}
