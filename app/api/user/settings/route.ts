import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    // Capped at 10%: beyond that a short losing streak takes the account with
    // it, and a tool about risk management should not help you set it.
    defaultRiskPercent: z.number().positive().max(10).optional(),
    defaultTimeframe: z.enum(["M15", "H1", "H4", "D1", "W1"]).optional(),
  })
  .refine((v) => v.defaultRiskPercent !== undefined || v.defaultTimeframe !== undefined, {
    message: "Provide at least one setting to update.",
  });

/** PATCH /api/user/settings */
export async function PATCH(req: NextRequest) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = bodySchema.parse(json);

    const user = await prisma.user.update({
      where: { id: guard.userId },
      data: {
        ...(body.defaultRiskPercent !== undefined
          ? { defaultRiskPercent: body.defaultRiskPercent }
          : {}),
        ...(body.defaultTimeframe !== undefined ? { defaultTimeframe: body.defaultTimeframe } : {}),
      },
      select: { defaultRiskPercent: true, defaultTimeframe: true },
    });

    return NextResponse.json({
      settings: { ...user, defaultRiskPercent: Number(user.defaultRiskPercent) },
    });
  } catch (err) {
    return handleRouteError(err, "PATCH /api/user/settings");
  }
}
