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
    journalEvent: { create: (a: unknown) => eventCreate(a) },
    $transaction: (ops: unknown) => transaction(ops),
  },
}));

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

  it("refuses an outcome on a setup that was never entered", async () => {
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "SKIPPED" });

    const result = await recordOutcome({ userId: "user-1", id: "entry-1", outcome: trade });

    expect(result.ok).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("stores the user's own numbers, not the setup's plan", async () => {
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "TAKEN" });

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

  it("logs a correction to a closed entry as an amendment", async () => {
    // A mistyped fill has to stay correctable — there is no other route to fix
    // one. What must not happen is the correction landing silently, so the
    // history says which recording replaced which.
    entryFindFirst.mockResolvedValue({ id: "entry-1", decision: "CLOSED" });

    const result = await recordOutcome({
      userId: "user-1",
      id: "entry-1",
      outcome: trade,
      close: true,
    });

    expect(result.ok).toBe(true);
    expect(eventCreate.mock.calls[0][0].data.detail).toMatch(/^Amended\./);
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
