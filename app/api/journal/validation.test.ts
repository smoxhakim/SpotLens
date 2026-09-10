import { describe, expect, it } from "vitest";

import {
  journalCreateSchema,
  journalDecisionSchema,
  journalListQuerySchema,
  journalOutcomeSchema,
} from "./validation";

/**
 * The journal's request contracts, tested against the schemas the routes
 * actually use — not a copy of them, so these cannot pass while the endpoint
 * accepts something else.
 */

describe("GET /api/journal", () => {
  it("defaults to a bounded page size", () => {
    expect(journalListQuerySchema.parse({}).limit).toBe(25);
  });

  it("refuses an unbounded page", () => {
    expect(journalListQuerySchema.safeParse({ limit: 5000 }).success).toBe(false);
    expect(journalListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it("takes a cursor only in the form the service issues", () => {
    expect(journalListQuerySchema.safeParse({ cursor: "not-a-uuid" }).success).toBe(false);
  });
});

describe("POST /api/journal", () => {
  const setupId = "00000000-0000-4000-8000-000000000000";

  it("requires the setup it is journaling", () => {
    // Setup-linked only: an entry with no setup could not answer "what did
    // SpotLens say at the time?", which is the question the journal exists for.
    expect(journalCreateSchema.safeParse({ notes: "a thought" }).success).toBe(false);
    expect(journalCreateSchema.safeParse({ trackedSetupId: setupId }).success).toBe(true);
  });

  it("rejects an unknown field rather than dropping it", () => {
    const result = journalCreateSchema.safeParse({
      trackedSetupId: setupId,
      // Not a field. Silently ignoring it would let a caller believe an entry
      // price had been stored.
      actualEntry: 100,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a decision outside the five states", () => {
    expect(
      journalCreateSchema.safeParse({ trackedSetupId: setupId, decision: "BOUGHT" }).success,
    ).toBe(false);
  });

  it("bounds the notes", () => {
    expect(
      journalCreateSchema.safeParse({ trackedSetupId: setupId, notes: "x".repeat(2001) }).success,
    ).toBe(false);
  });
});

describe("PATCH /api/journal/:id/decision", () => {
  it("requires a decision", () => {
    expect(journalDecisionSchema.safeParse({ notes: "hmm" }).success).toBe(false);
  });

  it("accepts a skip reason only from the recorded list", () => {
    expect(
      journalDecisionSchema.safeParse({ decision: "SKIPPED", skipReason: "OTHER" }).success,
    ).toBe(true);
    expect(
      journalDecisionSchema.safeParse({ decision: "SKIPPED", skipReason: "vibes" }).success,
    ).toBe(false);
  });

  it("does not accept trade numbers on this route", () => {
    // Recording a fill goes through the outcome endpoint, which validates the
    // stop against the entry. Accepting one here would bypass that.
    expect(journalDecisionSchema.safeParse({ decision: "TAKEN", actualEntry: 100 }).success).toBe(
      false,
    );
  });
});

describe("POST /api/journal/:id/outcome", () => {
  const trade = { actualEntry: 100, quantity: 1 };

  it("requires a fill and a size", () => {
    expect(journalOutcomeSchema.safeParse({ actualEntry: 100 }).success).toBe(false);
    expect(journalOutcomeSchema.safeParse({ quantity: 1 }).success).toBe(false);
    expect(journalOutcomeSchema.safeParse(trade).success).toBe(true);
  });

  it("refuses prices that are not prices", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(journalOutcomeSchema.safeParse({ ...trade, actualEntry: bad }).success, `${bad}`).toBe(
        false,
      );
    }
  });

  it("allows costs of zero but not negative ones", () => {
    expect(journalOutcomeSchema.safeParse({ ...trade, fees: 0 }).success).toBe(true);
    expect(journalOutcomeSchema.safeParse({ ...trade, fees: -1 }).success).toBe(false);
  });

  it("leaves the stop optional, so a trade taken without one stays honest", () => {
    // The consequence — no R — is applied in the domain, not papered over here
    // by defaulting to the setup's planned stop.
    expect(journalOutcomeSchema.safeParse(trade).success).toBe(true);
  });

  it("rejects an exit reason it does not recognise", () => {
    expect(journalOutcomeSchema.safeParse({ ...trade, exitReason: "LIQUIDATED" }).success).toBe(
      false,
    );
    expect(journalOutcomeSchema.safeParse({ ...trade, exitReason: "STOP_LOSS" }).success).toBe(
      true,
    );
  });

  it("has no field that could place an order", () => {
    // A guard against the shape drifting: SpotLens records trades, it never
    // sends them.
    const fields = Object.keys(journalOutcomeSchema.shape);

    for (const forbidden of ["side", "orderType", "leverage", "symbol", "apiKey"]) {
      expect(fields).not.toContain(forbidden);
    }
  });
});
