// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { eventsForOutcome, type ScannerEvent } from "@/lib/scanner";

/**
 * A scan's notifications are built from the exact `SetupEvent` rows the
 * lifecycle wrote, read back by id and scoped to the owner in the query.
 *
 * Before, `eventsFromScan` took "the newest event on the setup" — which a later
 * writer's event could replace — and found a replaced setup as "the setup
 * invalidated most recently on this symbol and timeframe", with no owner
 * filter. Nothing tested either. The fake below behaves like the database: it
 * returns only the rows the query's own `where` selects.
 */

const OWNER = "owner-1";
const T0 = Date.UTC(2026, 10, 4, 10);

function setupRow(id: string, userId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    userId,
    tradingPairId: "pair-btc",
    timeframe: "H1",
    status: "INVALIDATED",
    entryLow: 189,
    entryHigh: 192,
    stopLoss: 185,
    takeProfit1: 200,
    takeProfit2: 210,
    takeProfit3: null,
    riskReward: 2.1,
    riskRewardIsSynthetic: false,
    score: 72,
    scoreGrade: "MODERATE",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    snapshot: { entryReason: "support", statusReason: "waiting", trend: "BULLISH" },
    originZoneLow: 189,
    originZoneHigh: 192,
    invalidationReason: "The entry no longer rests on this level.",
    confirmedAt: null,
    invalidatedAt: new Date(T0),
    createdAt: new Date(T0 - 3_600_000),
    updatedAt: new Date(T0),
    analysisSnapshotId: null,
    ...over,
  };
}

const OLD = setupRow("setup-old", OWNER);
const NEW = setupRow("setup-new", OWNER, {
  status: "WAITING_CONFIRMATION",
  originZoneLow: 170,
  originZoneHigh: 174,
  invalidatedAt: null,
  invalidationReason: null,
});
/** Another account's setup on the same market, invalidated *later* than OLD. */
const FOREIGN = setupRow("setup-foreign", "owner-2", { invalidatedAt: new Date(T0 + 60_000) });

function eventRow(id: string, setup: ReturnType<typeof setupRow>, over: Record<string, unknown>) {
  return { id, setupId: setup.id, detail: "detail", payload: null, setup, ...over };
}

const EVENTS = [
  eventRow("event-invalidated", OLD, {
    type: "INVALIDATED",
    fromStatus: "WAITING_CONFIRMATION",
    toStatus: "INVALIDATED",
    createdAt: new Date(T0),
  }),
  eventRow("event-created", NEW, {
    type: "CREATED",
    fromStatus: null,
    toStatus: "WAITING_CONFIRMATION",
    createdAt: new Date(T0),
  }),
  // Written after this pass's event, on the same setup — "the newest event"
  // would have picked it.
  eventRow("event-later", OLD, {
    type: "STATUS_CHANGED",
    fromStatus: "SETUP_FORMING",
    toStatus: "CONFIRMATION_DETECTED",
    createdAt: new Date(T0 + 120_000),
  }),
  eventRow("event-foreign", FOREIGN, {
    type: "INVALIDATED",
    fromStatus: "SETUP_FORMING",
    toStatus: "INVALIDATED",
    createdAt: new Date(T0 + 60_000),
  }),
];

const findMany = vi.fn();
const guesses: string[] = [];
const refuse = (name: string) => () => {
  guesses.push(name);
  throw new Error(`${name} — a scan's notification must not look a setup up`);
};

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    setupEvent: { findMany: (a: unknown) => findMany(a) },
    trackedSetup: {
      findFirst: refuse("trackedSetup.findFirst"),
      findMany: refuse("trackedSetup.findMany"),
      findUnique: refuse("trackedSetup.findUnique"),
    },
  },
}));

const { eventsFromScan } = await import("./notification-events");

const replacement = (): ScannerEvent[] =>
  eventsForOutcome({
    symbol: "BTCUSDT",
    timeframe: "H1",
    detail: "because",
    outcome: {
      action: "REPLACE",
      setupId: "setup-new",
      status: "WAITING_CONFIRMATION",
      replacedSetupId: "setup-old",
      events: [
        { setupId: "setup-old", eventId: "event-invalidated" },
        { setupId: "setup-new", eventId: "event-created" },
      ],
    },
  });

beforeEach(() => {
  guesses.length = 0;
  findMany.mockReset();
  findMany.mockImplementation(
    async (args: { where: { id: { in: string[] }; setup: { userId: string } } }) =>
      EVENTS.filter(
        (row) => args.where.id.in.includes(row.id) && row.setup.userId === args.where.setup.userId,
      ),
  );
});

describe("a scan's notifications name their exact events", () => {
  it("reads exactly the events the lifecycle wrote, scoped to the owner, in one query", async () => {
    await eventsFromScan({ userId: OWNER, scannerEvents: replacement() });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["event-invalidated", "event-created"] }, setup: { userId: OWNER } },
      include: { setup: true },
    });
    expect(guesses).toEqual([]);
  });

  it("closes the replaced setup by its own event — not a newer one, not another owner's", async () => {
    const [closing] = await eventsFromScan({ userId: OWNER, scannerEvents: replacement() });

    expect(closing.type).toBe("SETUP_INVALIDATED");
    expect(closing.setup?.setupId).toBe("setup-old");
    expect(closing.dedupeKey).toBe("setup-event:event-invalidated");
    expect(closing.setup?.lifecycleStatus).toBe("INVALIDATED");
    // The replacement's level, from the row the opening half's id resolved.
    expect(closing.setup).toMatchObject({
      isReplacement: true,
      replacementZoneLow: 170,
      replacementZoneHigh: 174,
    });
  });

  it("both halves of a replacement are notified, each under its own event's key", async () => {
    // A replacement that opens straight at POTENTIAL_SETUP is announced too.
    findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      EVENTS.filter((row) => args.where.id.in.includes(row.id)).map((row) =>
        row.id === "event-created" ? { ...row, toStatus: "POTENTIAL_SETUP" } : row,
      ),
    );

    const notified = await eventsFromScan({ userId: OWNER, scannerEvents: replacement() });

    expect(notified.map((n) => [n.type, n.setup?.setupId, n.dedupeKey])).toEqual([
      ["SETUP_INVALIDATED", "setup-old", "setup-event:event-invalidated"],
      ["SETUP_DETECTED", "setup-new", "setup-event:event-created"],
    ]);
  });

  it("an invalidation with no replacement in the pass stands alone", async () => {
    const [closing] = replacement();
    const [event] = await eventsFromScan({ userId: OWNER, scannerEvents: [closing] });

    expect(event.setup).toMatchObject({ setupId: "setup-old", isReplacement: false });
  });

  it("never resolves another account's event, even when named", async () => {
    const forged: ScannerEvent = {
      ...replacement()[0],
      eventId: "event-foreign",
      closedSetupId: "setup-foreign",
    };

    expect(await eventsFromScan({ userId: OWNER, scannerEvents: [forged] })).toEqual([]);
  });

  it("notifies nothing for an event the lifecycle did not name", async () => {
    const [closing, opening] = replacement();
    const unnamed = [
      { ...closing, eventId: null },
      { ...opening, eventId: null },
    ];

    expect(await eventsFromScan({ userId: OWNER, scannerEvents: unnamed })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(guesses).toEqual([]);
  });

  it("still reports a failed market, which names no event", async () => {
    const failed: ScannerEvent = {
      type: "ANALYSIS_FAILED",
      symbol: "BTCUSDT",
      timeframe: "H1",
      setupId: null,
      lifecycleStatus: null,
      failureCategory: "MARKET_DATA_ERROR",
      detail: "timeout",
      eventId: null,
      closedSetupId: null,
    };

    const [event] = await eventsFromScan({ userId: OWNER, scannerEvents: [failed], now: T0 });

    expect(event.type).toBe("SYSTEM_ERROR");
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("why a moved anchor closed a setup", () => {
  const closingWith = async (payload: unknown) => {
    findMany.mockImplementation(async (args: { where: { id: { in: string[] } } }) =>
      EVENTS.filter((row) => args.where.id.in.includes(row.id)).map((row) =>
        row.id === "event-invalidated" ? { ...row, payload } : row,
      ),
    );
    const [closing] = await eventsFromScan({ userId: OWNER, scannerEvents: replacement() });
    return closing.setup;
  };

  it("reads the cause the lifecycle stored on that event", async () => {
    const setup = await closingWith({ status: "PRESENT", closure: { cause: "SUPPORT_LOST" } });

    expect(setup).toMatchObject({ isReplacement: true, closureCause: "SUPPORT_LOST" });
  });

  it("has none for an event written before causes were recorded", async () => {
    const setup = await closingWith({ status: "PRESENT", signals: [] });

    expect(setup).toMatchObject({ isReplacement: true, closureCause: null });
  });

  it("has none for an invalidation that carries no payload at all", async () => {
    expect((await closingWith(null))?.closureCause).toBeNull();
  });

  it("does not trust a cause it does not recognise", async () => {
    expect((await closingWith({ closure: { cause: "ELSEWHERE" } }))?.closureCause).toBeNull();
  });
});
