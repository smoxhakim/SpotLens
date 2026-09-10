import { describe, expect, it } from "vitest";

import {
  buildAmendmentPayload,
  hasRecordedOutcome,
  readAmendmentPayload,
  supersededVersions,
  type StoredOutcome,
} from "./amendment";
import { computeOutcome } from "./decide";

/**
 * Correcting a mistyped fill has to stay possible — there is no other route to
 * fix one. What must not happen is the previous version disappearing when it
 * does. These are the rules that keep every earlier recording recoverable.
 */

const stored = (over: Partial<StoredOutcome> = {}): StoredOutcome => ({
  actualEntry: 100,
  actualStopLoss: 95,
  actualTakeProfit: 115,
  actualExit: 110,
  quantity: 2,
  fees: 1,
  slippage: 0.5,
  exitReason: "TAKE_PROFIT",
  openedAt: 1_000,
  closedAt: 5_000,
  ...over,
});

describe("hasRecordedOutcome", () => {
  it("needs both a fill and a size to count as a recording", () => {
    expect(hasRecordedOutcome(stored())).toBe(true);
    expect(hasRecordedOutcome(stored({ actualEntry: null }))).toBe(false);
    expect(hasRecordedOutcome(stored({ quantity: null }))).toBe(false);
  });
});

describe("buildAmendmentPayload", () => {
  it("preserves all ten trade fields, not a summary of them", () => {
    // The specific failure this prevents: a prose detail line saying "2.19R"
    // while the fill, stop, exit, size and costs that produced it are gone.
    const payload = buildAmendmentPayload(stored(), 9_999)!;

    expect(payload.supersededOutcome).toMatchObject({
      actualEntry: 100,
      actualStopLoss: 95,
      actualTakeProfit: 115,
      actualExit: 110,
      quantity: 2,
      fees: 1,
      slippage: 0.5,
      exitReason: "TAKE_PROFIT",
      openedAt: 1_000,
      closedAt: 5_000,
    });
  });

  it("records what that version reported at the time", () => {
    // Entry 100, stop 95, 2 units: 10 at risk. Exit 110 makes 20, less 1.5 in
    // costs, so 1.85R.
    const payload = buildAmendmentPayload(stored(), 9_999)!;

    expect(payload.supersededOutcome.realizedR).toBeCloseTo(1.85);
    expect(payload.supersededOutcome.supersededAt).toBe(9_999);
  });

  it("keeps a null field null rather than defaulting it", () => {
    // A trade recorded without a stop had no R. The preserved version must say
    // so, not fill in a number that was never there.
    const payload = buildAmendmentPayload(
      stored({ actualStopLoss: null, fees: null, exitReason: null }),
      1,
    )!;

    expect(payload.supersededOutcome.actualStopLoss).toBeNull();
    expect(payload.supersededOutcome.fees).toBeNull();
    expect(payload.supersededOutcome.exitReason).toBeNull();
    expect(payload.supersededOutcome.realizedR).toBeNull();
  });

  it("produces nothing when there was no recording to supersede", () => {
    // A first recording replaces nothing, so it carries no payload.
    expect(buildAmendmentPayload(stored({ actualEntry: null, quantity: null }), 1)).toBeNull();
  });

  it("is a plain JSON value, so it survives the round trip to the column", () => {
    const payload = buildAmendmentPayload(stored(), 42)!;

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});

describe("readAmendmentPayload", () => {
  it("reads back exactly what was written", () => {
    const payload = buildAmendmentPayload(stored(), 42)!;
    const roundTripped = JSON.parse(JSON.stringify(payload));

    expect(readAmendmentPayload(roundTripped)).toEqual(payload.supersededOutcome);
  });

  it("treats an event written before the column existed as having no version", () => {
    // Every JournalEvent already in the database has a null payload. They stay
    // valid; they simply have nothing to offer.
    expect(readAmendmentPayload(null)).toBeNull();
    expect(readAmendmentPayload(undefined)).toBeNull();
  });

  it("refuses a payload that is not a superseded recording", () => {
    expect(readAmendmentPayload({})).toBeNull();
    expect(readAmendmentPayload({ supersededOutcome: null })).toBeNull();
    expect(readAmendmentPayload({ supersededOutcome: { actualEntry: 100 } })).toBeNull();
    expect(readAmendmentPayload("a string")).toBeNull();
    expect(readAmendmentPayload(7)).toBeNull();
  });
});

describe("supersededVersions", () => {
  it("returns every previous version, oldest first", () => {
    const v1 = buildAmendmentPayload(stored({ actualEntry: 100 }), 1_000)!;
    const v2 = buildAmendmentPayload(stored({ actualEntry: 200 }), 2_000)!;
    const v3 = buildAmendmentPayload(stored({ actualEntry: 300 }), 3_000)!;

    const versions = supersededVersions([
      { payload: v1, createdAt: 1_000 },
      { payload: v2, createdAt: 2_000 },
      { payload: v3, createdAt: 3_000 },
    ]);

    expect(versions.map((v) => v.actualEntry)).toEqual([100, 200, 300]);
  });

  it("orders by when the version was recorded, not by argument order", () => {
    const v1 = buildAmendmentPayload(stored({ actualEntry: 100 }), 1_000)!;
    const v2 = buildAmendmentPayload(stored({ actualEntry: 200 }), 2_000)!;

    const versions = supersededVersions([
      { payload: v2, createdAt: 2_000 },
      { payload: v1, createdAt: 1_000 },
    ]);

    expect(versions.map((v) => v.actualEntry)).toEqual([100, 200]);
  });

  it("skips events that superseded nothing", () => {
    // A CREATED event, a decision change, and the first recording all sit in
    // the same log and none of them replaced a trade.
    const versions = supersededVersions([
      { payload: null, createdAt: 1 },
      { payload: buildAmendmentPayload(stored(), 2), createdAt: 2 },
      { payload: null, createdAt: 3 },
    ]);

    expect(versions).toHaveLength(1);
  });

  it("reconstructs the original recording from the log alone", () => {
    // The point of the whole exercise: given only the events, the first
    // version's numbers and its result come back exactly.
    const original = stored({ actualEntry: 100, actualStopLoss: 95, actualExit: 110, quantity: 2 });
    const events = [
      { payload: buildAmendmentPayload(original, 1_000), createdAt: 1_000 },
      { payload: buildAmendmentPayload(stored({ actualEntry: 101 }), 2_000), createdAt: 2_000 },
    ];

    const [first] = supersededVersions(events);

    expect(first.actualEntry).toBe(original.actualEntry);
    expect(first.actualStopLoss).toBe(original.actualStopLoss);
    expect(first.actualExit).toBe(original.actualExit);
    expect(first.quantity).toBe(original.quantity);
    // And recomputing from the preserved fields agrees with what was stored.
    expect(
      computeOutcome({
        actualEntry: first.actualEntry!,
        actualStopLoss: first.actualStopLoss ?? undefined,
        actualExit: first.actualExit ?? undefined,
        quantity: first.quantity!,
        fees: first.fees ?? undefined,
        slippage: first.slippage ?? undefined,
      }).realizedR,
    ).toBeCloseTo(first.realizedR!);
  });
});
