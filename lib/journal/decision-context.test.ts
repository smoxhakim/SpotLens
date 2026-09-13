import { describe, expect, it } from "vitest";

import { buildAmendmentPayload } from "./amendment";
import {
  buildDecisionContext,
  coachWasRead,
  readDecisionContext,
  type DecisionContext,
} from "./decision-context";

/**
 * What was on screen when a decision was made.
 *
 * The interesting property is what this deliberately cannot express: there is
 * no field that says the Coach approved anything, and none can be smuggled in
 * through the payload, because reading is a whitelist rather than a cast.
 */

const tracked: DecisionContext = {
  source: "TRACKED_SETUP",
  runId: null,
  coach: null,
};

const withCoach: DecisionContext = {
  source: "SCANNER_RESULT",
  runId: "run-1",
  coach: {
    providerId: "openai:gpt-5.6-terra",
    verdict: "PROMISING_NEEDS_CONFIRMATION",
    recordedAt: 1_757_000_000_000,
  },
};

describe("decision context payload", () => {
  it("round-trips what was recorded", () => {
    expect(readDecisionContext(buildDecisionContext(withCoach))).toEqual(withCoach);
  });

  it("records a decision made without the Coach as an ordinary decision", () => {
    // Not an incomplete record. Deciding without asking is a normal way to
    // decide, and the absence is stored as an absence rather than a gap.
    const read = readDecisionContext(buildDecisionContext(tracked));

    expect(read).toEqual(tracked);
    expect(read?.coach).toBeNull();
  });

  it("never carries an approval, whatever the payload claims", () => {
    // The concern is not a hostile client so much as a future edit: if the
    // shape were cast rather than rebuilt field by field, an extra key would
    // survive into the record and something would eventually read it.
    const forged = {
      decisionContext: {
        ...tracked,
        coachApproved: true,
        approvedBy: "coach",
      },
    };

    const read = readDecisionContext(forged);

    expect(read).toEqual(tracked);
    expect(read).not.toHaveProperty("coachApproved");
    expect(read).not.toHaveProperty("approvedBy");
  });

  it("drops a coach reference whose verdict is not one the Coach can produce", () => {
    const read = readDecisionContext({
      decisionContext: {
        source: "TRACKED_SETUP",
        runId: null,
        coach: { providerId: "x", verdict: "DEFINITELY_BUY", recordedAt: 1 },
      },
    });

    expect(read?.coach).toBeNull();
  });

  it("returns null for an event that carries no decision context", () => {
    expect(readDecisionContext(null)).toBeNull();
    expect(readDecisionContext({})).toBeNull();
    // An event written before Phase O existed. Older rows stay valid; they
    // simply do not say what was on screen.
    expect(readDecisionContext({ supersededOutcome: { actualEntry: 1, quantity: 1 } })).toBeNull();
  });

  it("shares an event payload with a superseded outcome without either losing anything", () => {
    // The two keys are siblings by design: `readAmendmentPayload` looks only at
    // its own, so adding this one cost no migration and disturbs nothing that
    // was already stored.
    const amendment = buildAmendmentPayload(
      {
        actualEntry: 100,
        actualStopLoss: 95,
        actualTakeProfit: null,
        actualExit: 110,
        quantity: 2,
        fees: 0.5,
        slippage: null,
        exitReason: null,
        openedAt: null,
        closedAt: null,
      },
      1_757_000_000_000,
    );

    expect(amendment).not.toBeNull();
    const combined = { ...amendment!, ...buildDecisionContext(withCoach) };

    expect(readDecisionContext(combined)).toEqual(withCoach);
    expect(combined.supersededOutcome.actualEntry).toBe(100);
  });
});

describe("coachWasRead", () => {
  it("is true when any decision on the entry was made after reading a review", () => {
    // Reading a review before deciding to watch, then changing to skipped a day
    // later without reopening it, does not un-read the review.
    expect(coachWasRead([buildDecisionContext(withCoach), buildDecisionContext(tracked)])).toBe(
      true,
    );
  });

  it("is false when no decision was made with a review on screen", () => {
    expect(coachWasRead([buildDecisionContext(tracked), null, {}])).toBe(false);
  });

  it("is false for an entry with no events at all", () => {
    expect(coachWasRead([])).toBe(false);
  });
});
