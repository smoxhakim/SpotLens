import { describe, expect, it } from "vitest";

import {
  buildLateEntryPayload,
  checkSetupDecision,
  closedSetupMove,
  lateEntryRecord,
  readLateEntry,
  type DecisionSetup,
} from "./closed-setup";
import { buildDecisionContext, readDecisionContext } from "./decision-context";
import type { JournalDecision } from "./types";

/**
 * What a decision may say about a setup that has closed.
 *
 * Open setups and untracked opportunities are untouched. A closed setup refuses
 * a watch, keeps skip, and takes only a trade the user states they entered
 * while it was open — inside the window SpotLens recorded it open, with an
 * explicit acknowledgement. Anything missing or outside is refused, never
 * completed by a guess.
 */

const DECISIONS: JournalDecision[] = ["WATCHING", "SKIPPED", "TAKEN", "CANCELLED", "CLOSED"];
const OPEN_STATUSES = [
  "SETUP_FORMING",
  "WAITING_CONFIRMATION",
  "CONFIRMATION_DETECTED",
  "POTENTIAL_SETUP",
];

const FIRST_SEEN = Date.parse("2026-10-26T15:50:29Z");
const CLOSED_AT = Date.parse("2026-10-28T18:07:12Z");
const closed: DecisionSetup = {
  status: "INVALIDATED",
  firstSeenAt: FIRST_SEEN,
  closedAt: CLOSED_AT,
};
const INSIDE = Date.parse("2026-10-27T09:30:00Z");
const claim = (enteredAt: number, acknowledged = true) => ({ acknowledged, enteredAt });

describe("checkSetupDecision — open setups and untracked opportunities", () => {
  it("refuses nothing on an open setup, from any decision to any decision", () => {
    for (const status of OPEN_STATUSES) {
      const setup = { status, firstSeenAt: FIRST_SEEN, closedAt: null };
      for (const from of [null, ...DECISIONS]) {
        for (const to of DECISIONS) {
          expect(checkSetupDecision({ setup, from, to }), `${status} ${from}→${to}`).toBeNull();
        }
      }
    }
  });

  it("refuses nothing on an untracked opportunity, which has no lifecycle to close", () => {
    for (const from of [null, ...DECISIONS]) {
      for (const to of DECISIONS) {
        expect(checkSetupDecision({ setup: null, from, to })).toBeNull();
      }
    }
  });

  it("refuses a late-entry statement where there is nothing closed to state it about", () => {
    const open = { status: "WAITING_CONFIRMATION", firstSeenAt: FIRST_SEEN, closedAt: null };
    expect(
      checkSetupDecision({ setup: open, from: null, to: "TAKEN", lateEntry: claim(INSIDE) })?.code,
    ).toBe("LATE_ENTRY_INVALID");
    expect(
      checkSetupDecision({ setup: null, from: null, to: "TAKEN", lateEntry: claim(INSIDE) })?.code,
    ).toBe("LATE_ENTRY_INVALID");
  });
});

describe("checkSetupDecision — a closed setup", () => {
  it("cannot be newly watched, whether creating or changing", () => {
    for (const from of [null, "SKIPPED", "CANCELLED"] as const) {
      expect(checkSetupDecision({ setup: closed, from, to: "WATCHING" })?.code).toBe(
        "SETUP_CLOSED",
      );
    }
  });

  it("can still be skipped, cancelled and closed", () => {
    expect(checkSetupDecision({ setup: closed, from: null, to: "SKIPPED" })).toBeNull();
    expect(checkSetupDecision({ setup: closed, from: "WATCHING", to: "SKIPPED" })).toBeNull();
    expect(checkSetupDecision({ setup: closed, from: "TAKEN", to: "CLOSED" })).toBeNull();
    expect(checkSetupDecision({ setup: closed, from: "TAKEN", to: "CANCELLED" })).toBeNull();
  });

  it("never refuses a decision that does not change — a note against it, say", () => {
    for (const decision of DECISIONS) {
      expect(checkSetupDecision({ setup: closed, from: decision, to: decision })).toBeNull();
    }
  });

  it("refuses a new take without a late-entry statement", () => {
    for (const from of [null, "WATCHING", "SKIPPED", "CANCELLED"] as const) {
      expect(checkSetupDecision({ setup: closed, from, to: "TAKEN" })?.code).toBe(
        "LATE_ENTRY_REQUIRED",
      );
    }
  });

  it("refuses a statement that is not acknowledged", () => {
    expect(
      checkSetupDecision({
        setup: closed,
        from: null,
        to: "TAKEN",
        lateEntry: claim(INSIDE, false),
      })?.code,
    ).toBe("LATE_ENTRY_REQUIRED");
  });

  it("accepts an acknowledged entry time inside the window, both ends included", () => {
    for (const at of [INSIDE, FIRST_SEEN, CLOSED_AT]) {
      expect(
        checkSetupDecision({ setup: closed, from: "WATCHING", to: "TAKEN", lateEntry: claim(at) }),
      ).toBeNull();
    }
  });

  it("refuses an entry time before the setup was first seen or after it closed", () => {
    for (const at of [FIRST_SEEN - 1, CLOSED_AT + 1, CLOSED_AT + 86_400_000]) {
      expect(
        checkSetupDecision({ setup: closed, from: null, to: "TAKEN", lateEntry: claim(at) })?.code,
      ).toBe("LATE_ENTRY_INVALID");
    }
  });

  it("refuses an entry time that is not a time", () => {
    for (const at of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(
        checkSetupDecision({ setup: closed, from: null, to: "TAKEN", lateEntry: claim(at) })?.code,
      ).toBe("LATE_ENTRY_INVALID");
    }
  });

  it("refuses rather than guesses when the window is missing or impossible", () => {
    for (const setup of [
      { ...closed, closedAt: null },
      { ...closed, firstSeenAt: null },
      { ...closed, firstSeenAt: Number.NaN },
      { ...closed, firstSeenAt: CLOSED_AT + 1 },
    ]) {
      expect(
        checkSetupDecision({ setup, from: null, to: "TAKEN", lateEntry: claim(INSIDE) })?.code,
      ).toBe("LATE_ENTRY_INVALID");
    }
  });

  it("refuses a statement attached to anything but a change to taken", () => {
    expect(
      checkSetupDecision({ setup: closed, from: null, to: "SKIPPED", lateEntry: claim(INSIDE) })
        ?.code,
    ).toBe("LATE_ENTRY_INVALID");
    expect(
      checkSetupDecision({ setup: closed, from: "TAKEN", to: "TAKEN", lateEntry: claim(INSIDE) })
        ?.code,
    ).toBe("LATE_ENTRY_INVALID");
  });
});

describe("closedSetupMove", () => {
  it("refuses watching, routes taking through a late entry, and allows the rest", () => {
    expect(DECISIONS.map(closedSetupMove)).toEqual([
      "REFUSED",
      "ALLOWED",
      "LATE_ENTRY",
      "ALLOWED",
      "ALLOWED",
    ]);
  });
});

describe("the late-entry record", () => {
  it("is labelled user-stated and carries the window it was checked against", () => {
    expect(lateEntryRecord(closed, claim(INSIDE))).toEqual({
      source: "USER_STATED",
      acknowledged: true,
      statedEnteredAt: INSIDE,
      setupFirstSeenAt: FIRST_SEEN,
      setupClosedAt: CLOSED_AT,
    });
  });

  it("is never built for a statement the rule would refuse", () => {
    expect(lateEntryRecord(closed, claim(CLOSED_AT + 1))).toBeNull();
    expect(lateEntryRecord(closed, claim(INSIDE, false))).toBeNull();
    expect(lateEntryRecord({ ...closed, closedAt: null }, claim(INSIDE))).toBeNull();
  });

  it("round-trips beside the decision context without disturbing it", () => {
    const record = lateEntryRecord(closed, claim(INSIDE))!;
    const context = { source: "TRACKED_SETUP" as const, runId: null, coach: null };
    const payload = JSON.parse(
      JSON.stringify({ ...buildDecisionContext(context), ...buildLateEntryPayload(record) }),
    );

    expect(readLateEntry(payload)).toEqual(record);
    expect(readDecisionContext(payload)).toEqual(context);
  });

  it("reads nothing from a payload that is not one, or is malformed", () => {
    expect(readLateEntry(null)).toBeNull();
    expect(
      readLateEntry(buildDecisionContext({ source: "TRACKED_SETUP", runId: null, coach: null })),
    ).toBeNull();
    const record = lateEntryRecord(closed, claim(INSIDE))!;
    expect(readLateEntry({ lateEntry: { ...record, source: "SPOTLENS" } })).toBeNull();
    expect(readLateEntry({ lateEntry: { ...record, acknowledged: false } })).toBeNull();
    expect(readLateEntry({ lateEntry: { ...record, statedEnteredAt: "yesterday" } })).toBeNull();
    // An extra key does not survive into what a reader sees.
    expect(readLateEntry({ lateEntry: { ...record, verified: true } })).toEqual(record);
  });
});
