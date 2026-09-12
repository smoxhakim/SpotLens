import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { timeframeSchema } from "@/lib/market-data/schema";
import { buildCoachReview } from "@/services/coach";

export const dynamic = "force-dynamic";

/**
 * Every parameter validated, and nothing beyond them accepted.
 *
 * `strict()` so an unexpected key is refused rather than ignored: the handoff
 * contract is four references, and a fifth would mean something travelling in
 * a URL that should have been read from the database.
 */
const querySchema = z
  .object({
    symbol: z
      .string()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{2,20}$/)),
    tf: timeframeSchema,
    runId: z.string().uuid(),
    setupId: z.string().uuid().optional(),
  })
  .strict();

/**
 * GET /api/coach — an educational review of an analysis already recorded.
 *
 * Read-only, and read-only by construction rather than by convention: it
 * resolves stored rows, hands them to a pure reviewer and returns prose. There
 * is no write, no exchange call, and nothing that could place an order.
 *
 * Numbers are never taken from the request. A caller supplies references — the
 * market, the timeframe, the run, optionally the setup — and every figure in
 * the response is read from the row those references resolve to.
 */
export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "Coach reviews are built from stored analyses.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
      return apiError(
        "INVALID_REQUEST",
        "A Coach review needs a market, a timeframe and the scanner run it came from.",
        400,
      );
    }

    const lookup = await buildCoachReview({
      userId: guard.userId,
      symbol: parsed.data.symbol,
      timeframe: parsed.data.tf,
      runId: parsed.data.runId,
      setupId: parsed.data.setupId ?? null,
    });

    if (!lookup.ok) {
      // One shape for every miss. A setup belonging to someone else must be
      // indistinguishable from one that was never there, so the reason is not
      // reported back and the status does not vary.
      return apiError("NOT_FOUND", "No recorded analysis matches that reference.", 404);
    }

    return NextResponse.json({
      context: lookup.result.context,
      review: lookup.result.review,
      // True when a provider failed or answered with something the rules
      // refused, and the deterministic reading was shown instead.
      degraded: lookup.degraded,
      // Which kind of reading this is, so the page can say so rather than
      // letting the reader guess whether a model was involved. The model *id*
      // is deliberately not returned — it is configuration, not something a
      // browser needs, and the key it sits beside never leaves the server.
      source: lookup.result.review.providerId.startsWith("openai:") ? "MODEL" : "DETERMINISTIC",
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/coach");
  }
}
