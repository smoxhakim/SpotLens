import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Journal persistence against a stubbed database.
 *
 * Two things are being protected here. One is ownership: every read is scoped
 * in the `where`, so another account's entry is indistinguishable from a
 * missing one. The other is the setup snapshot — journaling records what the
 * user did and must never write back to what SpotLens said.
 */

const setupFindFirst = vi.fn();
const setupUpdate = vi.fn();
const entryFindUnique = vi.fn();
const entryFindFirst = vi.fn();
const entryFindMany = vi.fn();
const entryCreate = vi.fn();
const entryUpdate = vi.fn();
const eventCreate = vi.fn();
const eventUpdate = vi.fn();
const eventDeleteMany = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    trackedSetup: {
      findFirst: (a: unknown) => setupFindFirst(a),
      update: (a: unknown) => setupUpdate(a),
    },
    journalEntry: {
      findUnique: (a: unknown) => entryFindUnique(a),
      findFirst: (a: unknown) => entryFindFirst(a),
      findMany: (a: unknown) => entryFindMany(a),
      create: (a: unknown) => entryCreate(a),
      update: (a: unknown) => entryUpdate(a),
    },
    journalEvent: {
      create: (a: unknown) => eventCreate(a),
      // Stubbed only so a test can assert they are never reached: the event
      // log is append-only, and nothing may edit or remove a past version.
      update: (a: unknown) => eventUpdate(a),
      deleteMany: (a: unknown) => eventDeleteMany(a),
    },
    $transaction: (ops: unknown) => transaction(ops),
  },
}));

import { supersededVersions } from "@/lib/journal";

const { createEntry, listEntries, recordOutcome, updateDecision } = await import("./journal");

beforeEach(() => {
  for (const fn of [
    setupFindFirst,
    setupUpdate,
    entryFindUnique,
    entryFindFirst,
    entryFindMany,
    entryCreate,
    entryUpdate,
    eventCreate,
    eventUpdate,
    eventDeleteMany,
    transaction,
  ]) {
    fn.mockReset();
  }

  setupFindFirst.mockResolvedValue({ id: "setup-1", status: "WAITING_CONFIRMATION" });
  entryFindUnique.mockResolvedValue(null);
  entryCreate.mockResolvedValue({ id: "entry-1" });
  entryFindMany.mockResolvedValue([]);
  transaction.mockResolvedValue([]);
});

describe("createEntry", () => {
  it("freezes the lifecycle state the decision was made against", async () => {
    // The setup will keep moving. What matters later is where it was when the
    // person decided, not where it ended up.
    await createEntry({ userId: "user-1", trackedSetupId: "setup-1", decision: "SKIPPED" });

    const data = entryCreate.mock.calls[0][0].data;
    expect(data.setupStatusAtDecision).toBe("WAITING_CONFIRMATION");
    expect(data.decision).toBe("SKIPPED");
    expect(data.userId).toBe("user-1");
  });

  it("does not write anything back to the setup", async () => {
    // The snapshot is the record of what was on offer. Journaling is an
    // observation about it and must leave it exactly as it was.
    await createEntry({ userId: "user-1", trackedSetupId: "setup-1" });

    expect(setupUpdate).not.toHaveBeenCalled();
  });

  it("defaults to watching", async () => {
    await createEntry({ userId: "user-1", trackedSetupId: "setup-1" });

    expect(entryCreate.mock.calls[0][0].data.decision).toBe("WATCHING");
  });

  it("opens the decision history with a CREATED event", async () => {
    await createEntry({ userId: "user-1", trackedSetupId: "setup-1" });

    expect(entryCreate.mock.calls[0][0].data.events.create.type).toBe("CREATED");
  });

  it("returns the existing entry instead of writing a second", async () => {
    // Journaling the same setup twice is a double click, not a second opinion.
    entryFindUnique.mockResolvedValue({ id: "entry-9", userId: "user-1" });

    const result = await createEntry({ userId: "user-1", trackedSetupId: "setup-1" });

    expect(result).toEqual({ ok: true, value: { id: "entry-9", created: false } });
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("scopes the setup lookup to the owner", async () => {
    await createEntry({ userId: "user-1", trackedSetupId: "setup-1" });

    expect(setupFindFirst.mock.calls[0][0].where).toEqual({ id: "setup-1", userId: "user-1" });
  });

  it("answers the same way for another account's setup as for a missing one", async () => {
    // Distinguishable errors would turn this endpoint into a way of asking
    // which setup ids exist.
    setupFindFirst.mockResolvedValue(null);
    const missing = await createEntry({ userId: "user-1", trackedSetupId: "nope" });

    setupFindFirst.mockResolvedValue({ id: "setup-1", status: "SETUP_FORMING" });
    entryFindUnique.mockResolvedValue({ id: "entry-9", userId: "someone-else" });
    const foreign = await createEntry({ userId: "user-1", trackedSetupId: "setup-1" });

    expect(missing).toEqual(foreign);
    expect(entryCreate).not.toHaveBeenCalled();
  });
});

describe("updateDecision", () => {
  const entry = (decision: string) => entryFindFirst.mockResolvedValue({ id: "entry-1", decision });

  it("records the move and appends an event", async () => {
    entry("WATCHING");

    const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: "TAKEN" });

    expect(result).toEqual({ ok: true, value: { changed: true } });
    expect(entryUpdate.mock.calls[0][0].data.decision).toBe("TAKEN");

    const event = eventCreate.mock.calls[0][0].data;
    expect(event.type).toBe("DECISION_CHANGED");
    expect(event.fromDecision).toBe("WATCHING");
    expect(event.toDecision).toBe("TAKEN");
  });

  it("refuses to unwind a position into a skip, and writes nothing", async () => {
    entry("TAKEN");

    const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: "SKIPPED" });

    expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses to move a closed entry", async () => {
    entry("CLOSED");

    const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: "TAKEN" });

    expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("writes nothing when nothing changed", async () => {
    entry("WATCHING");

    const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: "WATCHING" });

    expect(result).toEqual({ ok: true, value: { changed: false } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("still records a note against an unchanged decision", async () => {
    entry("WATCHING");

    const result = await updateDecision({
      userId: "user-1",
      id: "entry-1",
      decision: "WATCHING",
      notes: "waiting on the daily close",
    });

    expect(result).toEqual({ ok: true, value: { changed: false } });
    expect(transaction).toHaveBeenCalled();
  });

  it("answers 'no such entry' for another account's row", async () => {
    entryFindFirst.mockResolvedValue(null);

    const result = await updateDecision({ userId: "user-2", id: "entry-1", decision: "TAKEN" });

    expect(result.ok).toBe(false);
    expect(entryFindFirst.mock.calls[0][0].where).toEqual({ id: "entry-1", userId: "user-2" });
  });
});

describe("recordOutcome", () => {
  const trade = { actualEntry: 100, actualStopLoss: 95, quantity: 2, actualExit: 110 };

  /** A stored row with no trade on it yet. */
  const blank = {
    actualEntry: null,
    actualStopLoss: null,
    actualTakeProfit: null,
    actualExit: null,
    quantity: null,
    fees: null,
    slippage: null,
    exitReason: null,
    openedAt: null,
    closedAt: null,
  };

  it("refuses an outcome on a setup that was never entered", async () => {
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "SKIPPED", ...blank });

    const result = await recordOutcome({ userId: "user-1", id: "entry-1", outcome: trade });

    expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("stores the user's own numbers, not the setup's plan", async () => {
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "TAKEN", ...blank });

    const result = await recordOutcome({
      userId: "user-1",
      id: "entry-1",
      outcome: trade,
      close: true,
    });

    // Entry 100, stop 95, 2 units risks 10; exiting at 110 makes 20. That is
    // 2R against the risk the user actually took.
    expect(result).toEqual({ ok: true, value: { realizedR: 2 } });
    expect(entryUpdate.mock.calls[0][0].data).toMatchObject({
      decision: "CLOSED",
      actualEntry: 100,
      actualStopLoss: 95,
      actualExit: 110,
    });

    // The setup was never read for a price: the fill and the stop are the
    // user's, and the difference from the plan is the point.
    expect(setupFindFirst).not.toHaveBeenCalled();
    expect(setupUpdate).not.toHaveBeenCalled();
  });

  it("records the first outcome with no payload, because it superseded nothing", async () => {
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "TAKEN", ...blank });

    await recordOutcome({ userId: "user-1", id: "entry-1", outcome: trade });

    const event = eventCreate.mock.calls[0][0].data;
    expect(event.type).toBe("OUTCOME_RECORDED");
    expect(event.detail).not.toMatch(/Amended/);
    expect(event.payload).toBeUndefined();
  });

  it("logs a correction to a closed entry as an amendment", async () => {
    // A mistyped fill has to stay correctable — there is no other route to fix
    // one. What must not happen is the correction landing silently, so the
    // history says which recording replaced which.
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "CLOSED", ...blank });

    const result = await recordOutcome({
      userId: "user-1",
      id: "entry-1",
      outcome: trade,
      close: true,
    });

    expect(result.ok).toBe(true);
    expect(eventCreate.mock.calls[0][0].data.detail).toMatch(/^Amended\./);
  });

  it("preserves every superseded field before overwriting it", async () => {
    // The whole point. The entry already holds a full recording; correcting it
    // must put those exact values somewhere recoverable first.
    entryFindFirst.mockResolvedValue({
      id: "entry-1",
      decision: "CLOSED",
      actualEntry: 100,
      actualStopLoss: 95,
      actualTakeProfit: 118,
      actualExit: 110,
      quantity: 2,
      fees: 1,
      slippage: 0.5,
      exitReason: "TAKE_PROFIT",
      openedAt: new Date(1_000),
      closedAt: new Date(5_000),
    });

    await recordOutcome({
      userId: "user-1",
      id: "entry-1",
      outcome: { actualEntry: 101, actualStopLoss: 96, actualExit: 120, quantity: 3 },
      close: true,
    });

    const superseded = eventCreate.mock.calls[0][0].data.payload.supersededOutcome;
    expect(superseded).toMatchObject({
      actualEntry: 100,
      actualStopLoss: 95,
      actualTakeProfit: 118,
      actualExit: 110,
      quantity: 2,
      fees: 1,
      slippage: 0.5,
      exitReason: "TAKE_PROFIT",
      openedAt: 1_000,
      closedAt: 5_000,
    });
    // And what that version reported: 10 at risk, 20 made, 1.5 in costs.
    expect(superseded.realizedR).toBeCloseTo(1.85);
    expect(typeof superseded.supersededAt).toBe("number");

    // The entry itself moves on to the corrected values.
    expect(entryUpdate.mock.calls[0][0].data).toMatchObject({
      actualEntry: 101,
      actualStopLoss: 96,
      actualExit: 120,
      quantity: 3,
    });
  });

  it("appends the amendment rather than editing any existing event", async () => {
    entryFindFirst.mockResolvedValue({
      id: "entry-1",
      decision: "CLOSED",
      ...blank,
      actualEntry: 100,
      quantity: 1,
    });

    await recordOutcome({ userId: "user-1", id: "entry-1", outcome: trade, close: true });

    // One create, and nothing that could rewrite history.
    expect(eventCreate).toHaveBeenCalledTimes(1);
    expect(eventUpdate).not.toHaveBeenCalled();
    expect(eventDeleteMany).not.toHaveBeenCalled();
  });

  it("refuses to close without an exit price", async () => {
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "TAKEN" });

    const result = await recordOutcome({
      userId: "user-1",
      id: "entry-1",
      outcome: { actualEntry: 100, actualStopLoss: 95, quantity: 2 },
      close: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].code).toBe("CLOSED_REQUIRES_EXIT");
  });
});

describe("a trade corrected more than once", () => {
  /**
   * Threads a mutable row through the mocks so the sequence behaves like the
   * database does: each write lands on the row, and the next read sees it.
   */
  function withStoredRow() {
    const row: Record<string, unknown> = {
      id: "entry-1",
      decision: "CLOSED",
      actualEntry: null,
      actualStopLoss: null,
      actualTakeProfit: null,
      actualExit: null,
      quantity: null,
      fees: null,
      slippage: null,
      exitReason: null,
      openedAt: null,
      closedAt: null,
    };

    entryFindFirst.mockImplementation(async () => ({ ...row }));
    entryUpdate.mockImplementation((args: { data: Record<string, unknown> }) => {
      Object.assign(row, args.data);
      return {};
    });
    return row;
  }

  it("keeps every previous version, oldest first", async () => {
    const row = withStoredRow();
    // Version 1 is a first recording; there is nothing before it.
    row.decision = "TAKEN";

    const record = (actualEntry: number, quantity: number, close = false) =>
      recordOutcome({
        userId: "user-1",
        id: "entry-1",
        outcome: {
          actualEntry,
          actualStopLoss: actualEntry - 5,
          actualExit: actualEntry + 10,
          quantity,
        },
        close,
      });

    await record(100, 1, true); // v1
    await record(200, 2, true); // v2 supersedes v1
    await record(300, 3, true); // v3 supersedes v2

    const payloads = eventCreate.mock.calls.map((call) => call[0].data.payload);

    // Three writes, two of which replaced something.
    expect(payloads[0]).toBeUndefined();
    expect(payloads[1].supersededOutcome).toMatchObject({ actualEntry: 100, quantity: 1 });
    expect(payloads[2].supersededOutcome).toMatchObject({ actualEntry: 200, quantity: 2 });

    // Each version was superseded after the one before it.
    expect(payloads[2].supersededOutcome.supersededAt).toBeGreaterThanOrEqual(
      payloads[1].supersededOutcome.supersededAt,
    );

    // And the entry holds the latest.
    expect(row.actualEntry).toBe(300);
    expect(row.quantity).toBe(3);
  });

  it("reconstructs version 1 from the log after version 3", async () => {
    const row = withStoredRow();
    row.decision = "TAKEN";

    for (const [entry, qty] of [
      [100, 1],
      [200, 2],
      [300, 3],
    ]) {
      await recordOutcome({
        userId: "user-1",
        id: "entry-1",
        outcome: {
          actualEntry: entry,
          actualStopLoss: entry - 5,
          actualExit: entry + 10,
          quantity: qty,
          fees: 1,
        },
        close: true,
      });
    }

    const versions = supersededVersions(
      eventCreate.mock.calls.map((call, i) => ({
        payload: call[0].data.payload ?? null,
        createdAt: i,
      })),
    );

    expect(versions.map((v) => v.actualEntry)).toEqual([100, 200]);
    // v1: 5 at risk on 1 unit, 10 made, 1 in fees.
    expect(versions[0].realizedR).toBeCloseTo(1.8);
    expect(versions[0].actualStopLoss).toBe(95);
    expect(versions[0].fees).toBe(1);
  });

  it("leaves the decision closed and the setup untouched", async () => {
    const row = withStoredRow();
    row.actualEntry = 100;
    row.quantity = 1;

    await recordOutcome({
      userId: "user-1",
      id: "entry-1",
      outcome: { actualEntry: 101, actualStopLoss: 96, actualExit: 120, quantity: 1 },
      close: true,
    });

    // An amendment corrects the numbers; it does not reopen the decision.
    expect(row.decision).toBe("CLOSED");
    const reopen = await updateDecision({ userId: "user-1", id: "entry-1", decision: "TAKEN" });
    expect(reopen.ok).toBe(false);

    // And nothing reached the engine's own record.
    expect(setupUpdate).not.toHaveBeenCalled();
  });
});

describe("listEntries", () => {
  it("scopes to the caller and pages by cursor", async () => {
    entryFindMany.mockResolvedValue([]);

    await listEntries({ userId: "user-1", limit: 20, cursor: "entry-5" });

    const args = entryFindMany.mock.calls[0][0];
    expect(args.where.userId).toBe("user-1");
    // One extra row is what tells the caller whether there is another page.
    expect(args.take).toBe(21);
    expect(args.cursor).toEqual({ id: "entry-5" });
    expect(args.skip).toBe(1);
  });

  it("reports no next page when the last one is short", async () => {
    entryFindMany.mockResolvedValue([]);

    expect(await listEntries({ userId: "user-1", limit: 20 })).toEqual({
      entries: [],
      nextCursor: null,
    });
  });
});
