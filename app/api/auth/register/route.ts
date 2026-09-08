import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/response";
import { MIN_PASSWORD_LENGTH, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
    .max(200),
  name: z.string().min(1).max(80).optional(),
});

/** POST /api/auth/register — email/password signup. */
export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = bodySchema.parse(json);
    const email = body.email.toLowerCase();

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return apiError("EMAIL_TAKEN", "An account with that email already exists.", 409);
    }

    const user = await prisma.user.create({
      data: {
        email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        acceptedTermsAt: new Date(),
      },
      select: { id: true, email: true, name: true },
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (err) {
    return handleRouteError(err, "POST /api/auth/register");
  }
}
