import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The replay service against a stubbed database.
 *
 * The point of these tests is *where* the cutoff is enforced. Filtering in
 * memory would pass a naive assertion while still loading tomorrow's candles
 * into the process — so these assert on the query itself, and then, as a
 * defect-injection check, hand the stub future candles it was never asked for
 * and prove they do not appear.
 */

const findFirst = vi.fn();
const findManyCandles = vi.fn();
const findManyEvents = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    trackedSetup: { findFirst: (a: unknown) => findFirst(a) },
    candle: { findMany: (a: unknown) => findManyCandles(a) },
    setupEvent: { findMany: (a: unknown) => findManyEvents(a) },
  },
}));

const { buildReplayFrame } = await import("./replay");

const HOUR = 3_600_000;
const CREATED = Date.UTC(2026, 0, 10);
const DECIDED = CREATED + 10 * HOUR;

function candleRow(openTime: number, close: number) {
  return {
    openTime: new Date(openTime),
    closeTime: new Date(openTime + HOUR - 1),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
  };
}

const setupRow = {
  id: "setup-1",
  userId: "user-1",
  timeframe: "H1",
  tradingPair: { id: "pair-1", exchangeSymbol: "BTCUSDT" },
  journalEntry: { decision: "TAKEN", decidedAt: new Date(DECIDED), notes: "took it" },
  createdAt: new Date(CREATED),
  entryLow: 100,
  entryHigh: 102,
  stopLoss: 95,
  takeProfit1: 110,
  takeProfit2: null,
  riskReward: 2,
  riskRewardIsSynthetic: false,
  score: 71,
  scoreGrade: "B",
  analysisStatus: "POTENTIAL_SETUP",
  snapshot: { note: "as recorded" },
};

beforeEach(() => {
  findFirst.mockReset();
  findManyCandles.mockReset();
  findManyEvents.mockReset();

  findFirst.mockResolvedValue(setupRow);
  findManyCandles.mockResolvedValue([]);
  findManyEvents.mockResolvedValue([]);
});

describe("the cutoff is enforced in the query", () => {
  it("asks the database only for candles that had closed", async () => {
    await buildReplayFrame({ userId: "user-1", setupId: "setup-1", at: DECIDED });

    const where = findManyCandles.mock.calls[0][0].where;
    expect(where.closeTime).toEqual({ lte: new Date(DECIDED) });
    expect(where.tradingPairId).toBe("pair-1");
    expect(where.timeframe).toBe("H1");
  });

  it("asks the database only for events that had been written", async () => {
    await buildReplayFrame({ userId: "user-1", setupId: "setup-1", at: DECIDED });

    expect(findManyEvents.mock.calls[0][0].where.createdAt).toEqual({ lte: new Date(DECIDED) });
  });

  it("never fetches from the exchange", async () => {
    // Nothing in this module may reach the network — the stub provides no
    // candles at all, and the frame must come back empty rather than filled.
    findManyCandles.mockResolvedValue([]);

    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1", at: DECIDED });

    expect(frame!.candles).toEqual([]);
    expect(frame!.coverage.incomplete).toBe(true);
    expect(frame!.coverage.note).toMatch(/Nothing has been fetched/i);
  });

  it("does not show a future candle even if the database returns one", async () => {
    // Defect injection: pretend the `where` clause was weakened by an edit and
    // the row set came back unbounded. The second filter must still catch it.
    const past = candleRow(DECIDED - 2 * HOUR, 100);
    const future = candleRow(DECIDED + 5 * HOUR, 999);
    findManyCandles.mockResolvedValue([past, future]);

    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1", at: DECIDED });

    expect(frame!.candles).toHaveLength(1);
    expect(frame!.candles[0].close).toBe(100);
    expect(frame!.candles.some((c) => c.closeTime > DECIDED)).toBe(false);
  });

  it("does not show a future event even if the database returns one", async () => {
    findManyEvents.mockResolvedValue([
      {
        id: "e1",
        type: "CREATED",
        fromStatus: null,
        toStatus: "SETUP_FORMING",
        detail: "seen",
        createdAt: new Date(CREATED),
      },
      {
        id: "e2",
        type: "STATUS_CHANGE",
        fromStatus: "SETUP_FORMING",
        toStatus: "INVALIDATED",
        detail: "stop taken out",
        createdAt: new Date(DECIDED + HOUR),
      },
    ]);

    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1", at: DECIDED });

    expect(frame!.events.map((e) => e.id)).toEqual(["e1"]);
    expect(frame!.markers.some((m) => m.kind === "INVALIDATED")).toBe(false);
  });
});

describe("what the frame reports", () => {
  it("defaults the moment to the decision", async () => {
    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1" });

    expect(frame!.at).toBe(DECIDED);
  });

  it("falls back to when the setup was first seen", async () => {
    findFirst.mockResolvedValue({ ...setupRow, journalEntry: null });

    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1" });

    expect(frame!.at).toBe(CREATED);
  });

  it("hides a decision that had not been made yet", async () => {
    // Replaying the moment the setup appeared must not reveal what the user
    // eventually did with it.
    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1", at: CREATED });

    expect(frame!.decision).toBeNull();
    expect(frame!.markers.some((m) => m.kind === "DECISION")).toBe(false);
  });

  it("shows the decision once the cutoff has passed it", async () => {
    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1", at: DECIDED });

    expect(frame!.decision?.decision).toBe("TAKEN");
  });

  it("labels the stored numbers as a snapshot, not a recalculation", async () => {
    const frame = await buildReplayFrame({ userId: "user-1", setupId: "setup-1" });

    expect(frame!.snapshot.source).toBe("HISTORICAL_SNAPSHOT");
    expect(frame!.snapshot.entryLow).toBe(100);
    expect(frame!.snapshot.stopLoss).toBe(95);
    expect(frame!.snapshot.score).toBe(71);
  });

  it("scopes the lookup to the owner", async () => {
    await buildReplayFrame({ userId: "user-1", setupId: "setup-1" });

    expect(findFirst.mock.calls[0][0].where).toEqual({ id: "setup-1", userId: "user-1" });
  });

  it("returns nothing for a setup that is not the user's", async () => {
    findFirst.mockResolvedValue(null);

    expect(await buildReplayFrame({ userId: "user-2", setupId: "setup-1" })).toBeNull();
  });
});
