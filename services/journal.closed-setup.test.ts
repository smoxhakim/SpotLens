import { beforeEach, describe, expect, it, vi } from "vitest";

import { readDecisionContext, readLateEntry } from "@/lib/journal";

/**
 * Decisions on a closed setup, enforced where they are written.
 *
 * A closed setup refuses a new watch and a new take; it keeps skip; it accepts
 * a take only as a trade the user states they entered while it was open, inside
 * the window SpotLens recorded. A refusal writes nothing. An accepted late entry
 * is stored beside the decision context as the user's statement and touches
 * neither `decidedAt` nor the trade's `openedAt`. Against a stubbed database.
 */

const setupFindFirst = vi.fn();
const entryFindUnique = vi.fn();
const entryFindFirst = vi.fn();
const entryCreate = vi.fn();
const entryUpdate = vi.fn();
const eventCreate = vi.fn();
const resultFindFirst = vi.fn();
const transaction = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    trackedSetup: { findFirst: (a: unknown) => setupFindFirst(a) },
    journalEntry: {
      findUnique: (a: unknown) => entryFindUnique(a),
      findFirst: (a: unknown) => entryFindFirst(a),
      create: (a: unknown) => entryCreate(a),
      update: (a: unknown) => entryUpdate(a),
    },
    journalEvent: { create: (a: unknown) => eventCreate(a) },
    scannerResult: { findFirst: (a: unknown) => resultFindFirst(a) },
    $transaction: (ops: unknown) => transaction(ops),
  },
}));

const { createEntry, decisionSetupFor, updateDecision } = await import("./journal");

const FIRST_SEEN = new Date("2026-10-26T15:50:29Z");
const CLOSED_AT = new Date("2026-10-28T18:07:12Z");
const INSIDE = Date.parse("2026-10-27T09:30:00Z");

const CLOSED_SETUP = {
  id: "setup-1",
  status: "INVALIDATED",
  createdAt: FIRST_SEEN,
  invalidatedAt: CLOSED_AT,
};
const OPEN_SETUP = {
  id: "setup-1",
  status: "WAITING_CONFIRMATION",
  createdAt: FIRST_SEEN,
  invalidatedAt: null,
};

const tracked = { kind: "TRACKED" as const, trackedSetupId: "setup-1" };
const lateEntry = (enteredAt: number, acknowledged = true) => ({ acknowledged, enteredAt });

/** An existing entry whose setup is now as given. */
function existing(decision: string, setup: Record<string, unknown> | null = CLOSED_SETUP) {
  entryFindFirst.mockResolvedValue({
    id: "entry-1",
    decision,
    trackedSetupId: setup ? "setup-1" : null,
    scannerRunId: setup ? null : "run-1",
    trackedSetup: setup,
  });
}

beforeEach(() => {
  for (const fn of [
    setupFindFirst,
    entryFindUnique,
    entryFindFirst,
    entryCreate,
    entryUpdate,
    eventCreate,
    resultFindFirst,
    transaction,
  ]) {
    fn.mockReset();
  }
  setupFindFirst.mockResolvedValue(CLOSED_SETUP);
  entryFindUnique.mockResolvedValue(null);
  entryCreate.mockResolvedValue({ id: "entry-1" });
  transaction.mockResolvedValue([]);
});

describe("createEntry on a closed setup", () => {
  it("refuses a new watch — asked for, or by default — and writes nothing", async () => {
    for (const decision of ["WATCHING", undefined] as const) {
      const result = await createEntry({ userId: "user-1", target: tracked, decision });
      expect(result).toMatchObject({ ok: false, errors: [{ code: "SETUP_CLOSED" }] });
    }
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("still records a skip, freezing the setup's actual status", async () => {
    const result = await createEntry({ userId: "user-1", target: tracked, decision: "SKIPPED" });

    expect(result).toEqual({ ok: true, value: { id: "entry-1", created: true } });
    const data = entryCreate.mock.calls[0][0].data;
    expect(data.decision).toBe("SKIPPED");
    expect(data.setupStatusAtDecision).toBe("INVALIDATED");
    expect(readLateEntry(data.events.create.payload)).toBeNull();
  });

  it("refuses a new take without a late-entry statement, and writes nothing", async () => {
    const result = await createEntry({ userId: "user-1", target: tracked, decision: "TAKEN" });

    expect(result).toMatchObject({ ok: false, errors: [{ code: "LATE_ENTRY_REQUIRED" }] });
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("refuses a late take whose stated time is outside the window, or missing, and writes nothing", async () => {
    for (const enteredAt of [
      CLOSED_AT.getTime() + 60_000,
      FIRST_SEEN.getTime() - 60_000,
      Number.NaN,
    ]) {
      const result = await createEntry({
        userId: "user-1",
        target: tracked,
        decision: "TAKEN",
        lateEntry: lateEntry(enteredAt),
      });
      expect(result).toMatchObject({ ok: false, errors: [{ code: "LATE_ENTRY_INVALID" }] });
    }
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("refuses rather than guesses when the setup has no recorded close time", async () => {
    setupFindFirst.mockResolvedValue({ ...CLOSED_SETUP, invalidatedAt: null });

    const result = await createEntry({
      userId: "user-1",
      target: tracked,
      decision: "TAKEN",
      lateEntry: lateEntry(INSIDE),
    });

    expect(result).toMatchObject({ ok: false, errors: [{ code: "LATE_ENTRY_INVALID" }] });
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("records an acknowledged late take as the user's statement, beside the decision context", async () => {
    const result = await createEntry({
      userId: "user-1",
      target: tracked,
      decision: "TAKEN",
      lateEntry: lateEntry(INSIDE),
    });

    expect(result).toEqual({ ok: true, value: { id: "entry-1", created: true } });
    const data = entryCreate.mock.calls[0][0].data;
    expect(data.decision).toBe("TAKEN");
    // The setup's actual status when this was recorded — nothing inferred.
    expect(data.setupStatusAtDecision).toBe("INVALIDATED");
    // The stated time is the user's, kept as such: never the decision's time,
    // never the trade's opening time.
    expect(data).not.toHaveProperty("decidedAt");
    expect(data).not.toHaveProperty("openedAt");

    const event = data.events.create;
    expect(readLateEntry(event.payload)).toEqual({
      source: "USER_STATED",
      acknowledged: true,
      statedEnteredAt: INSIDE,
      setupFirstSeenAt: FIRST_SEEN.getTime(),
      setupClosedAt: CLOSED_AT.getTime(),
    });
    expect(readDecisionContext(event.payload)).toEqual({
      source: "TRACKED_SETUP",
      runId: null,
      coach: null,
    });
    expect(event.detail).toMatch(/self-reported, not verified/);
  });

  it("returns an existing entry untouched, whatever the setup's state", async () => {
    entryFindUnique.mockResolvedValue({ id: "entry-9", userId: "user-1" });

    const result = await createEntry({ userId: "user-1", target: tracked, decision: "WATCHING" });

    expect(result).toEqual({ ok: true, value: { id: "entry-9", created: false } });
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("still answers a missing setup and another account's setup identically", async () => {
    setupFindFirst.mockResolvedValue(null);
    const missing = await createEntry({ userId: "user-1", target: tracked, decision: "WATCHING" });

    setupFindFirst.mockResolvedValue(CLOSED_SETUP);
    entryFindUnique.mockResolvedValue({ id: "entry-9", userId: "someone-else" });
    const foreign = await createEntry({ userId: "user-1", target: tracked, decision: "WATCHING" });

    expect(missing).toEqual(foreign);
    expect(missing).toMatchObject({ ok: false, errors: [{ code: "INVALID_TRANSITION" }] });
  });
});

describe("createEntry with a late-entry statement where it does not belong", () => {
  it("refuses one on an open setup", async () => {
    setupFindFirst.mockResolvedValue(OPEN_SETUP);
    const result = await createEntry({
      userId: "user-1",
      target: tracked,
      decision: "TAKEN",
      lateEntry: lateEntry(INSIDE),
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "LATE_ENTRY_INVALID" }] });
    expect(entryCreate).not.toHaveBeenCalled();
  });

  it("refuses one on an untracked opportunity", async () => {
    resultFindFirst.mockResolvedValue({
      tradingPairId: "pair-1",
      analysisStatus: "WAIT_FOR_CONFIRMATION",
      score: 62,
      trackedSetupId: null,
    });
    entryFindFirst.mockResolvedValue(null);

    const result = await createEntry({
      userId: "user-1",
      target: { kind: "UNTRACKED", scannerRunId: "run-1", symbol: "BTCUSDT", timeframe: "H4" },
      decision: "TAKEN",
      lateEntry: lateEntry(INSIDE),
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "LATE_ENTRY_INVALID" }] });
    expect(entryCreate).not.toHaveBeenCalled();
  });
});

describe("updateDecision on an entry whose setup has since closed", () => {
  it("refuses a change to watching, and writes nothing", async () => {
    existing("SKIPPED");
    const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: "WATCHING" });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "SETUP_CLOSED" }] });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a change to taken without a statement, and writes nothing", async () => {
    existing("WATCHING");
    const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: "TAKEN" });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "LATE_ENTRY_REQUIRED" }] });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a change to taken stated after the setup closed", async () => {
    existing("WATCHING");
    const result = await updateDecision({
      userId: "user-1",
      id: "entry-1",
      decision: "TAKEN",
      lateEntry: lateEntry(CLOSED_AT.getTime() + 1),
    });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "LATE_ENTRY_INVALID" }] });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("accepts an acknowledged late take, recorded beside the context, decidedAt untouched", async () => {
    existing("WATCHING");
    const result = await updateDecision({
      userId: "user-1",
      id: "entry-1",
      decision: "TAKEN",
      lateEntry: lateEntry(INSIDE),
    });

    expect(result).toEqual({ ok: true, value: { changed: true } });
    const update = entryUpdate.mock.calls[0][0].data;
    expect(update.decision).toBe("TAKEN");
    expect(update).not.toHaveProperty("decidedAt");
    expect(update).not.toHaveProperty("openedAt");
    const event = eventCreate.mock.calls[0][0].data;
    expect(event.type).toBe("DECISION_CHANGED");
    expect(readLateEntry(event.payload)?.statedEnteredAt).toBe(INSIDE);
    expect(readDecisionContext(event.payload)?.source).toBe("TRACKED_SETUP");
  });

  it("still allows skip, cancel and close, and a note against the same decision", async () => {
    for (const [from, to] of [
      ["WATCHING", "SKIPPED"],
      ["TAKEN", "CANCELLED"],
      ["TAKEN", "CLOSED"],
    ] as const) {
      existing(from);
      const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: to });
      expect(result, `${from}→${to}`).toEqual({ ok: true, value: { changed: true } });
    }

    existing("WATCHING");
    const note = await updateDecision({
      userId: "user-1",
      id: "entry-1",
      decision: "WATCHING",
      notes: "it closed overnight",
    });
    expect(note).toEqual({ ok: true, value: { changed: false } });
    expect(readLateEntry(eventCreate.mock.calls.at(-1)![0].data.payload)).toBeNull();
  });

  it("keeps the journal's own transition rule first", async () => {
    existing("TAKEN");
    const result = await updateDecision({ userId: "user-1", id: "entry-1", decision: "SKIPPED" });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "INVALID_TRANSITION" }] });
  });

  it("still answers 'no such entry' for another account's row", async () => {
    entryFindFirst.mockResolvedValue(null);
    const result = await updateDecision({ userId: "user-2", id: "entry-1", decision: "TAKEN" });
    expect(result).toMatchObject({ ok: false, errors: [{ field: "id" }] });
  });
});

describe("updateDecision on an open setup or an untracked entry", () => {
  it("moves to watching and to taken exactly as before", async () => {
    existing("SKIPPED", OPEN_SETUP);
    expect(await updateDecision({ userId: "user-1", id: "entry-1", decision: "WATCHING" })).toEqual(
      { ok: true, value: { changed: true } },
    );

    existing("WATCHING", null);
    expect(await updateDecision({ userId: "user-1", id: "entry-1", decision: "TAKEN" })).toEqual({
      ok: true,
      value: { changed: true },
    });
  });
});

describe("decisionSetupFor", () => {
  it("reads the window owner-scoped, and is null for a setup that is not yours", async () => {
    expect(await decisionSetupFor("user-1", "setup-1")).toEqual({
      status: "INVALIDATED",
      firstSeenAt: FIRST_SEEN.getTime(),
      closedAt: CLOSED_AT.getTime(),
    });
    expect(setupFindFirst.mock.calls[0][0].where).toEqual({ id: "setup-1", userId: "user-1" });

    setupFindFirst.mockResolvedValue(null);
    expect(await decisionSetupFor("user-2", "setup-1")).toBeNull();
  });
});
