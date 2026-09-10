import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { listScannerRuns } from "@/services/scanner";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/**
 * GET /api/scanner/runs — recent scanner passes, newest first.
 *
 * Read-only. The scanner is a local process started from the command line, and
 * an endpoint that could kick off ninety analyses would be a way to make the
 * app hammer the exchange from a browser tab.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError(
        "DATABASE_REQUIRED",
        "Scanner history is stored, so it needs a database. Set DATABASE_URL and run the migrations.",
        503,
      );
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { limit } = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    return NextResponse.json({ runs: await listScannerRuns(limit) });
  } catch (err) {
    return handleRouteError(err, "GET /api/scanner/runs");
  }
}
