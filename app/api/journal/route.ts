import { NextRequest, NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { createEntry, listEntries } from "@/services/journal";

import { journalCreateSchema, journalListQuerySchema } from "./validation";

export const dynamic = "force-dynamic";

/** GET /api/journal — the caller's entries, newest decision first. */
export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "The journal is stored, so it needs a database.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const query = journalListQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    return NextResponse.json(await listEntries({ userId: guard.userId, ...query }));
  } catch (err) {
    return handleRouteError(err, "GET /api/journal");
  }
}

/**
 * POST /api/journal — journals a setup.
 *
 * Idempotent: a setup that is already journaled returns its existing entry
 * rather than a second one. Nothing here places an order; the entry records a
 * decision the user has already made elsewhere.
 */
export async function POST(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "The journal is stored, so it needs a database.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const body = journalCreateSchema.parse(json);
    const result = await createEntry({ userId: guard.userId, ...body });

    if (!result.ok) {
      // A setup owned by someone else is reported exactly as a missing one, so
      // the endpoint cannot be used to discover which ids exist.
      return NextResponse.json(
        { error: { code: "SETUP_NOT_FOUND", message: result.errors[0].message } },
        { status: 404 },
      );
    }

    return NextResponse.json(result.value, { status: result.value.created ? 201 : 200 });
  } catch (err) {
    return handleRouteError(err, "POST /api/journal");
  }
}
