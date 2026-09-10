import { z } from "zod";

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

export const journalCreateSchema = z
  .object({
    // Setup-linked only: a journal entry always references a tracked setup, so
    // "what did SpotLens say?" always has an answer.
    trackedSetupId: z.string().uuid(),
    decision: decisionSchema.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export const journalDecisionSchema = z
  .object({
    decision: decisionSchema,
    skipReason: z.enum(SKIP_REASONS).optional(),
    notes: z.string().max(2000).optional(),
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
