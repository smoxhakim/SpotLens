import { z } from "zod";

import { COACH_VERDICTS } from "@/lib/journal";
import { timeframeSchema } from "@/lib/market-data/schema";

/**
 * The journal's request contracts, in one place.
 *
 * Shared by every journal route and by the research filter, so the set of
 * decisions cannot be extended in the schema and quietly left stale in one of
 * the four handlers that also has to accept it.
 *
 * Every object is `.strict()`: an unrecognised field is a caller mistake worth
 * reporting, not something to drop silently.
 */

export const DECISIONS = ["WATCHING", "SKIPPED", "TAKEN", "CANCELLED", "CLOSED"] as const;

export const SKIP_REASONS = [
  "LOW_CONFIDENCE",
  "POOR_RR",
  "BAD_REGIME",
  "NO_CONFIRMATION",
  "PERSONAL_RULE",
  "MARKET_CONDITION",
  "MISSED_ENTRY",
  "OTHER",
] as const;

export const EXIT_REASONS = [
  "TAKE_PROFIT",
  "STOP_LOSS",
  "MANUAL_EXIT",
  "INVALIDATED",
  "OTHER",
] as const;

export const decisionSchema = z.enum(DECISIONS);

export const journalListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  decision: decisionSchema.optional(),
  cursor: z.string().uuid().optional(),
});

/**
 * A Coach review the user had read when they decided.
 *
 * Optional, validated, and never trusted for anything but its own description:
 * the verdict is checked against the Coach's own enum and the provider id is
 * bounded, so a hand-edited request can record a different reading but cannot
 * put arbitrary text into the record. There is no `approved` field, and the
 * timestamp is deliberately absent — the server stamps it, because a moment
 * the browser sent is a moment the browser chose.
 */
export const coachReferenceSchema = z
  .object({
    providerId: z.string().min(1).max(64),
    verdict: z.enum(COACH_VERDICTS),
  })
  .strict();

/**
 * What a decision is recorded against.
 *
 * Two shapes, and exactly one of them. A tracked setup is referenced by its
 * id; a market the scanner scored but never followed is referenced by the pass
 * it was scored in. Neither carries a number — every figure on the record is
 * read from the row these references resolve to, so an edited request can
 * change *which* opportunity is journaled and never what SpotLens said about it.
 */
export const journalCreateSchema = z.union([
  z
    .object({
      trackedSetupId: z.string().uuid(),
      decision: decisionSchema.optional(),
      notes: z.string().max(2000).optional(),
      coach: coachReferenceSchema.optional(),
    })
    .strict(),
  z
    .object({
      runId: z.string().uuid(),
      symbol: z
        .string()
        .transform((value) => value.toUpperCase())
        .pipe(z.string().regex(/^[A-Z0-9]{2,20}$/)),
      timeframe: timeframeSchema,
      decision: decisionSchema.optional(),
      notes: z.string().max(2000).optional(),
      coach: coachReferenceSchema.optional(),
    })
    .strict(),
]);

export const journalDecisionSchema = z
  .object({
    decision: decisionSchema,
    skipReason: z.enum(SKIP_REASONS).optional(),
    notes: z.string().max(2000).optional(),
    coach: coachReferenceSchema.optional(),
  })
  .strict();

/**
 * What the user actually did.
 *
 * Nothing here is defaulted from the setup's plan. A missing stop stays
 * missing, and the consequence — no R — is the honest one.
 */
export const journalOutcomeSchema = z
  .object({
    actualEntry: z.number().positive().finite(),
    actualStopLoss: z.number().positive().finite().optional(),
    actualTakeProfit: z.number().positive().finite().optional(),
    actualExit: z.number().positive().finite().optional(),
    quantity: z.number().positive().finite(),
    fees: z.number().min(0).finite().optional(),
    slippage: z.number().min(0).finite().optional(),
    exitReason: z.enum(EXIT_REASONS).optional(),
    openedAt: z.number().int().positive().optional(),
    closedAt: z.number().int().positive().optional(),
    close: z.boolean().optional(),
  })
  .strict();

export const journalIdSchema = z.object({ id: z.string().uuid() });
