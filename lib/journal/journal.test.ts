import { describe, expect, it } from "vitest";

import { canTransition, computeOutcome, validateOutcome, validateTransition } from "./decide";
import { ALLOWED_TRANSITIONS, type JournalDecision, type TradeOutcomeInput } from "./types";

/**
 * The journal records a human decision. Everything here is about keeping that
 * record honest — never inferring what the user meant, and never attributing
 * the engine's plan to the user's trade.
 */

const TRADE: TradeOutcomeInput = { actualEntry: 100, actualStopLoss: 95, quantity: 2 };

describe("decision transitions", () => {
  it("lets a watched setup be taken, skipped or abandoned", () => {
    expect(canTransition("WATCHING", "TAKEN")).toBe(true);
    expect(canTransition("WATCHING", "SKIPPED")).toBe(true);
    expect(canTransition("WATCHING", "CANCELLED")).toBe(true);
  });

  it("lets a skipped setup be taken later", () => {
    // Changing your mind two candles later is an ordinary sequence, not an error.
    expect(canTransition("SKIPPED", "TAKEN")).toBe(true);
  });

  it("refuses to turn a taken position into a skipped one", () => {
    // A position that was entered cannot retroactively become one passed over.
    expect(canTransition("TAKEN", "SKIPPED")).toBe(false);
    expect(validateTransition("TAKEN", "SKIPPED")?.code).toBe("INVALID_TRANSITION");
  });

  it("treats closed as terminal", () => {
    // The recorded outcome describes the position as it was entered; letting
    // it move again would leave the result attached to something else.
    expect(ALLOWED_TRANSITIONS.CLOSED).toEqual([]);
    for (const to of ["WATCHING", "SKIPPED", "TAKEN", "CANCELLED"] as JournalDecision[]) {
      expect(canTransition("CLOSED", to), to).toBe(false);
    }
    expect(validateTransition("CLOSED", "TAKEN")?.message).toMatch(/closed entry cannot change/i);
  });

  it("treats a no-op as neither an error nor a transition", () => {
    expect(validateTransition("WATCHING", "WATCHING")).toBeNull();
  });
});

describe("recording an outcome", () => {
  it("refuses an outcome on a decision that is not a position", () => {
    for (const decision of ["WATCHING", "SKIPPED", "CANCELLED"] as JournalDecision[]) {
      const codes = validateOutcome(decision, TRADE).map((e) => e.code);
      expect(codes, decision).toContain("OUTCOME_REQUIRES_POSITION");
    }
    expect(validateOutcome("TAKEN", TRADE)).toEqual([]);
  });

  it("requires an exit before an entry can be closed", () => {
    expect(validateOutcome("CLOSED", TRADE).map((e) => e.code)).toContain("CLOSED_REQUIRES_EXIT");
    expect(validateOutcome("CLOSED", { ...TRADE, actualExit: 110 })).toEqual([]);
  });

  it("rejects a stop at or above the entry", () => {
    // Spot longs only, exactly as the risk calculator requires.
    const codes = validateOutcome("TAKEN", { ...TRADE, actualStopLoss: 105 }).map((e) => e.code);
    expect(codes).toContain("STOP_NOT_BELOW_ENTRY");
  });

  it("rejects nonsense numbers rather than guessing at them", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        validateOutcome("TAKEN", { ...TRADE, actualEntry: bad }).length,
        `entry ${bad}`,
      ).toBeGreaterThan(0);
      expect(
        validateOutcome("TAKEN", { ...TRADE, quantity: bad }).length,
        `quantity ${bad}`,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects negative costs", () => {
    expect(validateOutcome("TAKEN", { ...TRADE, fees: -1 }).map((e) => e.code)).toContain(
      "INVALID_COSTS",
    );
  });

  it("rejects a trade that closes before it opened", () => {
    const codes = validateOutcome("TAKEN", {
      ...TRADE,
      actualExit: 110,
      openedAt: 2000,
      closedAt: 1000,
    }).map((e) => e.code);

    expect(codes).toContain("INVALID_TIMESTAMPS");
  });
});

describe("what a recorded trade produced", () => {
  it("computes profit, risk and R from the user's own numbers", () => {
    // Entry 100, stop 95, 2 units: 10 at risk. Exit 110: 20 profit, so 2R.
    const outcome = computeOutcome({ ...TRADE, actualExit: 110 });

    expect(outcome.grossPnl).toBeCloseTo(20);
    expect(outcome.riskAmount).toBeCloseTo(10);
    expect(outcome.realizedR).toBeCloseTo(2);
  });

  it("subtracts the costs the user actually recorded", () => {
    const outcome = computeOutcome({ ...TRADE, actualExit: 110, fees: 1, slippage: 1 });

    expect(outcome.costs).toBeCloseTo(2);
    expect(outcome.netPnl).toBeCloseTo(18);
    // R follows the net result, not the gross one.
    expect(outcome.realizedR).toBeCloseTo(1.8);
  });

  it("reports a loss as a negative R", () => {
    expect(computeOutcome({ ...TRADE, actualExit: 95 }).realizedR).toBeCloseTo(-1);
  });

  it("produces no R without an exit", () => {
    const outcome = computeOutcome(TRADE);

    expect(outcome.grossPnl).toBeNull();
    expect(outcome.realizedR).toBeNull();
  });

  it("produces no R without a real stop, rather than borrowing the plan's", () => {
    // Measuring against the setup's planned stop would credit the engine's
    // intention to the user's trade.
    const outcome = computeOutcome({ actualEntry: 100, quantity: 2, actualExit: 110 });

    expect(outcome.grossPnl).toBeCloseTo(20);
    expect(outcome.riskAmount).toBeNull();
    expect(outcome.realizedR).toBeNull();
  });

  it("measures holding time only when both ends are known", () => {
    expect(computeOutcome(TRADE).holdingMs).toBeNull();
    expect(
      computeOutcome({ ...TRADE, openedAt: 1_000, closedAt: 4_600_000 }).holdingMs,
    ).toBeCloseTo(4_599_000);
  });

  it("is deterministic", () => {
    const input = { ...TRADE, actualExit: 110, fees: 0.5 };
    expect(JSON.stringify(computeOutcome(input))).toBe(JSON.stringify(computeOutcome(input)));
  });
});
