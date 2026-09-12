import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { viewOf } from "@/lib/scanner";
import { getShortlist } from "@/services/scanner";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  /** Omitted means the most recent pass. */
  runId: z.string().uuid().optional(),
  size: z.enum(["PRIMARY", "EXPANDED", "EXTENDED", "ALL"]).default("PRIMARY"),
});

/**
 * GET /api/scanner/shortlist — the few results from one pass worth reviewing.
 *
 * Read-only, like the runs endpoint and for the same reason: the scanner is a
 * local process, and an endpoint that could start ninety analyses would be a
 * way to make a browser tab hammer the exchange.
 *
 * The ranking is not computed here. `buildShortlist` decides it once, in
 * `lib/scanner/shortlist.ts`, and this route selects a view of that one list —
 * so the API can never disagree with the scanner process about what is fifth.
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

    const { runId, size } = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    const result = await getShortlist({ runId });
    if (!result) return apiError("NOT_FOUND", "No scanner run has been recorded yet.", 404);

    const { run, shortlist } = result;

    return NextResponse.json({
      run,
      size,
      // Counts first, because "eight of ninety" is the honest headline and a
      // list of five on its own hides how much was looked at and refused.
      totalAnalysed: shortlist.totalAnalysed,
      totalEligible: shortlist.totalEligible,
      excluded: shortlist.excluded,
      rankingVersion: shortlist.rankingVersion,
      candidates: viewOf(shortlist, size),
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/scanner/shortlist");
  }
}
