import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { timeframeSchema } from "@/lib/market-data/schema";
import { riskPrefillFrom } from "@/lib/risk";
import { resolveCoachContext } from "@/services/coach";
import { findEntryForOpportunity } from "@/services/journal";

export const dynamic = "force-dynamic";

/**
 * GET /api/decision/context — what SpotLens recorded, and nothing else.
 *
 * The same four references the Coach takes, resolving to the same canonical
 * numbers — but through `resolveCoachContext`, which has no provider argument
 * and therefore no path to OpenAI. That separation is the point rather than a
 * tidy-up: the decision page shows a setup the moment it loads, the Coach costs
 * money and is only ever invoked when the reader presses Ask Coach, and a
 * single function with a "skip the model" flag would be one careless edit away
 * from a page that quietly called it on every render.
 *
 * Read-only by construction. It resolves stored rows and returns them; there is
 * no write, no exchange call, and nothing that could place an order.
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

export async function GET(req: NextRequest) {
  try {
    if (!isDatabaseConfigured) {
      return apiError("DATABASE_REQUIRED", "Decisions are recorded against stored analyses.", 503);
    }

    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
    if (!parsed.success) {
      return apiError(
        "INVALID_REQUEST",
        "A decision needs a market, a timeframe and the scanner run it came from.",
        400,
      );
    }

    const lookup = await resolveCoachContext({
      userId: guard.userId,
      symbol: parsed.data.symbol,
      timeframe: parsed.data.tf,
      runId: parsed.data.runId,
      setupId: parsed.data.setupId ?? null,
    });

    if (!lookup.ok) {
      // One shape for every miss, as everywhere else: a setup belonging to
      // someone else must be indistinguishable from one that was never there.
      return apiError("NOT_FOUND", "No recorded analysis matches that reference.", 404);
    }

    // Whether a decision is already on record for this opportunity, so the
    // panel offers only the moves the state machine would actually accept.
    const journal = await findEntryForOpportunity(
      guard.userId,
      lookup.context.identity.setupId
        ? { kind: "TRACKED", trackedSetupId: lookup.context.identity.setupId }
        : {
            kind: "UNTRACKED",
            scannerRunId: parsed.data.runId,
            symbol: parsed.data.symbol,
            timeframe: parsed.data.tf,
          },
    );

    return NextResponse.json({
      context: lookup.context,
      journal,
      // Derived on the server from the levels that were just resolved, so the
      // calculator is prefilled from the database rather than from anything a
      // caller sent. Null when the opportunity was never tracked — there are no
      // levels to size, and none are invented here.
      prefill: lookup.context.levels === null ? null : riskPrefillFrom(lookup.context.levels),
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/decision/context");
  }
}
