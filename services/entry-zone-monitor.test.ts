import { beforeEach, describe, expect, it, vi } from "vitest";

import { MarketDataError, type MarketDataProvider, type PriceQuote } from "@/lib/market-data";
import type { SetupFacts } from "@/lib/notifications";

/**
 * The monitor against a database that behaves like one.
 *
 * Earlier service tests stub single Prisma calls. These need more than that:
 * restart and concurrency are claims about what a *table* does when two writers
 * or two processes meet, so the fake below keeps rows and enforces the same
 * unique keys Postgres does — `Notification(userId, channel, dedupeKey)` and
 * `SetupEntryZoneWatch(trackedSetupId)` — and throws P2002 exactly where the
 * real index would. Delivery runs through the real `deliverEvents`, so
 * preferences and Telegram routing are the production rules, not mocks of them.
 */

interface SetupRow {
  id: string;
  userId: string;
  symbol: string;
  timeframe: "H1" | "H4";
  status: string;
  entryLow: number;
  entryHigh: number;
  createdStatus: string;
  analysisStatus: string;
  riskRewardIsSynthetic: boolean;
}

interface WatchRow {
  trackedSetupId: string;
  userId: string;
  armedAt: Date | null;
  reachedAt: Date | null;
  reachedPrice: number | null;
}

interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  channel: string;
  dedupeKey: string;
  title: string;
  body: string;
  status: string;
  trackedSetupId: string | null;
}

const store = {
  setups: [] as SetupRow[],
  watches: new Map<string, WatchRow>(),
  notifications: [] as NotificationRow[],
  prefs: new Map<string, Record<string, boolean>>(),
  chats: new Map<string, string>(),
  failNotificationWrites: false,
};

function uniqueViolation() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

const db = {
  trackedSetup: {
    findMany: vi.fn(async () =>
      store.setups
        .filter((s) => s.status !== "INVALIDATED")
        .map((s) => ({
          id: s.id,
          userId: s.userId,
          timeframe: s.timeframe,
          entryLow: s.entryLow,
          entryHigh: s.entryHigh,
          tradingPair: { exchangeSymbol: s.symbol },
          events: [{ toStatus: s.createdStatus }],
          entryZoneWatch: store.watches.get(s.id)
            ? {
                armedAt: store.watches.get(s.id)!.armedAt,
                reachedAt: store.watches.get(s.id)!.reachedAt,
              }
            : null,
        })),
    ),
    findFirst: vi.fn(
      async ({ where }: { where: { id: string; userId: string } }) =>
        store.setups.find(
          (s) => s.id === where.id && s.userId === where.userId && s.status !== "INVALIDATED",
        ) ?? null,
    ),
    // Present so a call would be visible. The monitor must never make one.
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  setupEvent: { create: vi.fn() },
  journalEntry: { create: vi.fn() },
  setupEntryZoneWatch: {
    // `ON CONFLICT DO NOTHING`: an existing row is skipped, never an error.
    createMany: vi.fn(
      async ({
        data,
      }: {
        data: (Partial<WatchRow> & { trackedSetupId: string; userId: string })[];
        skipDuplicates: boolean;
      }) => {
        let count = 0;
        for (const row of data) {
          if (store.watches.has(row.trackedSetupId)) continue;
          store.watches.set(row.trackedSetupId, {
            armedAt: null,
            reachedAt: null,
            reachedPrice: null,
            ...row,
          });
          count += 1;
        }
        return { count };
      },
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { trackedSetupId: string; userId: string; armedAt?: null; reachedAt?: null };
        data: Partial<WatchRow>;
      }) => {
        const row = store.watches.get(where.trackedSetupId);
        if (!row || row.userId !== where.userId) return { count: 0 };
        if ("armedAt" in where && row.armedAt !== null) return { count: 0 };
        if ("reachedAt" in where && row.reachedAt !== null) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    ),
  },
  notification: {
    create: vi.fn(async ({ data }: { data: Omit<NotificationRow, "id"> }) => {
      if (store.failNotificationWrites) throw new Error("connection closed");
      const clash = store.notifications.some(
        (n) =>
          n.userId === data.userId && n.channel === data.channel && n.dedupeKey === data.dedupeKey,
      );
      if (clash) throw uniqueViolation();
      const row = { ...data, id: `n${store.notifications.length + 1}` };
      store.notifications.push(row);
      return { id: row.id };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
      const row = store.notifications.find((n) => n.id === where.id);
      if (row) row.status = data.status;
    }),
  },
  notificationPreference: {
    findUnique: vi.fn(async ({ where }: { where: { userId: string } }) =>
      store.prefs.has(where.userId) ? { ...store.prefs.get(where.userId) } : null,
    ),
  },
  telegramConnection: {
    findUnique: vi.fn(async ({ where }: { where: { userId_bot: { userId: string } } }) => {
      const chatId = store.chats.get(where.userId_bot.userId);
      return chatId ? { chatId } : null;
    }),
  },
};

vi.mock("@/lib/db/prisma", () => ({ isDatabaseConfigured: true, prisma: db }));

const sendTelegramMessage = vi.fn();
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return { ...actual, sendTelegramMessage: (i: unknown) => sendTelegramMessage(i) };
});

// The facts loader is the scan path's own and is covered there; here it reads
// the fake's setup rows so the routing inputs are the ones each test set.
vi.mock("@/services/notification-events", () => ({
  loadSetupFacts: async (ids: string[]) =>
    new Map(
      store.setups
        .filter((s) => ids.includes(s.id))
        .map((s) => [s.id, factsFor(s)] as [string, SetupFacts]),
    ),
}));

const { DEFAULT_PREFERENCES } = await import("@/lib/notifications");
const { createEntryZoneMonitor } = await import("./entry-zone-monitor");

function factsFor(s: SetupRow): SetupFacts {
  return {
    setupId: s.id,
    lifecycleStatus: s.createdStatus as SetupFacts["lifecycleStatus"],
    previousStatus: null,
    entryLow: s.entryLow,
    entryHigh: s.entryHigh,
    stopLoss: s.entryLow * 0.97,
    takeProfit1: s.entryHigh * 1.1,
    takeProfit2: null,
    riskReward: 2.4,
    riskRewardIsSynthetic: s.riskRewardIsSynthetic,
    score: 80,
    scoreGrade: "STRONG",
    analysisStatus: s.analysisStatus,
    trend: "BULLISH",
    mtfAgreement: null,
    supportLow: s.entryLow,
    supportHigh: s.entryHigh,
    entryReason: "r",
    statusReason: "r",
    confirmationSignals: [],
    confirmationExplanation: null,
    invalidationReason: null,
    regime: null,
    isReplacement: false,
    replacementZoneLow: null,
    replacementZoneHigh: null,
    everConfirmed: false,
  };
}

let clock = Date.UTC(2026, 9, 3, 12);

/** A provider whose prices the test sets, and which records every request. */
function fakeProvider() {
  const prices = new Map<string, number>();
  const requests: string[][] = [];
  let failure: Error | null = null;
  let receivedAtOffset = 0;

  const provider = {
    getPrices: vi.fn(async (symbols: string[]): Promise<PriceQuote[]> => {
      requests.push(symbols);
      if (failure) throw failure;
      return symbols
        .filter((s) => prices.has(s))
        .map((s) => ({ symbol: s, price: prices.get(s)!, receivedAt: clock + receivedAtOffset }));
    }),
  } as unknown as MarketDataProvider;

  return {
    provider,
    requests,
    set: (symbol: string, price: number) => prices.set(symbol, price),
    fail: (err: Error | null) => (failure = err),
    receivedAgo: (ms: number) => (receivedAtOffset = -ms),
  };
}

function monitorFor(feed: ReturnType<typeof fakeProvider>) {
  return createEntryZoneMonitor({ provider: feed.provider, now: () => clock });
}

function addSetup(overrides: Partial<SetupRow> = {}): SetupRow {
  const row: SetupRow = {
    id: `setup-${store.setups.length + 1}`,
    userId: "user-1",
    symbol: "BTCUSDT",
    timeframe: "H1",
    status: "SETUP_FORMING",
    entryLow: 100,
    entryHigh: 105,
    createdStatus: "SETUP_FORMING",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    riskRewardIsSynthetic: false,
    ...overrides,
  };
  store.setups.push(row);
  return row;
}

function connectTelegram(userId: string) {
  store.prefs.set(userId, { ...DEFAULT_PREFERENCES, telegramEnabled: true });
  store.chats.set(userId, `chat-${userId}`);
}

const rowsFor = (setupId: string) =>
  store.notifications.filter((n) => n.trackedSetupId === setupId);

beforeEach(() => {
  store.setups = [];
  store.watches = new Map();
  store.notifications = [];
  store.prefs = new Map();
  store.chats = new Map();
  store.failNotificationWrites = false;
  clock = Date.UTC(2026, 9, 3, 12);
  vi.clearAllMocks();
  sendTelegramMessage.mockResolvedValue({ ok: true, attempts: 1, retryable: false });
});

describe("the transition, end to end", () => {
  it("alerts once on outside → inside, in-app and Telegram, and records it", async () => {
    connectTelegram("user-1");
    const setup = addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 110);
    expect((await monitor.tick()).alerts).toBe(0);

    feed.set("BTCUSDT", 104.5);
    clock += 10_000;
    expect((await monitor.tick()).alerts).toBe(1);

    expect(
      rowsFor(setup.id)
        .map((n) => [n.type, n.channel, n.dedupeKey])
        .sort(),
    ).toEqual([
      ["ENTRY_ZONE_REACHED", "IN_APP", `entry-zone:${setup.id}`],
      ["ENTRY_ZONE_REACHED", "TELEGRAM", `entry-zone:${setup.id}`],
    ]);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-user-1", bot: "MAIN" }),
    );
    expect(store.watches.get(setup.id)).toMatchObject({
      reachedAt: new Date(clock),
      reachedPrice: 104.5,
    });
  });

  it("does not spam while price stays inside, or on re-entry", async () => {
    const setup = addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    for (const price of [110, 104, 103, 102, 101, 120, 104, 99, 102]) {
      feed.set("BTCUSDT", price);
      clock += 10_000;
      await monitor.tick();
    }

    expect(rowsFor(setup.id)).toHaveLength(1); // in-app only: Telegram not connected
  });

  it("a price tick that changes nothing writes nothing", async () => {
    addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 110);
    for (let i = 0; i < 5; i += 1) await monitor.tick();

    // Created outside: already armed by its creation event, so not even an arm.
    expect(db.setupEntryZoneWatch.createMany).not.toHaveBeenCalled();
    expect(db.notification.create).not.toHaveBeenCalled();
  });

  it("a setup created inside is silent until it has been seen outside, then arms durably", async () => {
    const setup = addSetup({
      createdStatus: "WAITING_CONFIRMATION",
      status: "WAITING_CONFIRMATION",
    });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 102);
    await monitor.tick();
    expect(rowsFor(setup.id)).toHaveLength(0);
    expect(store.watches.has(setup.id)).toBe(false);

    feed.set("BTCUSDT", 108);
    expect((await monitor.tick()).armed).toBe(1);
    expect(store.watches.get(setup.id)?.armedAt).toEqual(new Date(clock));

    feed.set("BTCUSDT", 103);
    expect((await monitor.tick()).alerts).toBe(1);
  });

  it("changes nothing about the setup: no lifecycle write, no event, no decision", async () => {
    addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();
    feed.set("BTCUSDT", 110);
    await monitor.tick();
    feed.set("BTCUSDT", 101);
    await monitor.tick();

    expect(db.trackedSetup.update).not.toHaveBeenCalled();
    expect(db.trackedSetup.updateMany).not.toHaveBeenCalled();
    expect(db.setupEvent.create).not.toHaveBeenCalled();
    expect(db.journalEntry.create).not.toHaveBeenCalled();
  });
});

describe("restart", () => {
  it("N. a new process with price still inside does not alert again", async () => {
    const setup = addSetup();
    const feed = fakeProvider();

    const first = monitorFor(feed);
    await first.refresh();
    feed.set("BTCUSDT", 110);
    await first.tick();
    feed.set("BTCUSDT", 102);
    await first.tick();
    expect(rowsFor(setup.id)).toHaveLength(1);

    // Process restarts. Same price, still inside.
    const second = monitorFor(feed);
    await second.refresh();
    for (let i = 0; i < 3; i += 1) {
      clock += 10_000;
      await second.tick();
    }

    expect(rowsFor(setup.id)).toHaveLength(1);
    expect(db.notification.create).toHaveBeenCalledTimes(1);
  });

  it("the event exists but the watch write was lost: the restart heals it silently", async () => {
    connectTelegram("user-1");
    const setup = addSetup();
    const feed = fakeProvider();

    // The crash window: notifications written, process died before the watch.
    store.notifications.push(
      {
        id: "n-a",
        userId: "user-1",
        type: "ENTRY_ZONE_REACHED",
        channel: "IN_APP",
        dedupeKey: `entry-zone:${setup.id}`,
        title: "",
        body: "",
        status: "SENT",
        trackedSetupId: setup.id,
      },
      {
        id: "n-b",
        userId: "user-1",
        type: "ENTRY_ZONE_REACHED",
        channel: "TELEGRAM",
        dedupeKey: `entry-zone:${setup.id}`,
        title: "",
        body: "",
        status: "SENT",
        trackedSetupId: setup.id,
      },
    );

    const monitor = monitorFor(feed);
    await monitor.refresh();
    feed.set("BTCUSDT", 102);
    expect((await monitor.tick()).alerts).toBe(1); // re-derived…

    expect(rowsFor(setup.id)).toHaveLength(2); // …but refused by the index
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(store.watches.get(setup.id)?.reachedAt).not.toBeNull(); // and the watch caught up

    await monitor.tick();
    expect(db.notification.create).toHaveBeenCalledTimes(2); // nothing further attempted
  });

  it("armed before a restart, entered while it was down: alerts once on startup", async () => {
    const setup = addSetup({ createdStatus: "WAITING_CONFIRMATION" });
    store.watches.set(setup.id, {
      trackedSetupId: setup.id,
      userId: "user-1",
      armedAt: new Date(clock - 3_600_000),
      reachedAt: null,
      reachedPrice: null,
    });

    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();
    feed.set("BTCUSDT", 101);
    await monitor.tick();
    await monitor.tick();

    expect(rowsFor(setup.id)).toHaveLength(1);
  });
});

describe("concurrency", () => {
  it("O. two monitors raising the same alert at once produce exactly one row per channel", async () => {
    connectTelegram("user-1");
    const setup = addSetup();
    const feed = fakeProvider();
    const a = monitorFor(feed);
    const b = monitorFor(feed);
    await Promise.all([a.refresh(), b.refresh()]);

    feed.set("BTCUSDT", 102);
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);

    // Both decided to alert; the index let exactly one of each channel through.
    expect(ra.alerts + rb.alerts).toBe(2);
    expect(
      rowsFor(setup.id)
        .map((n) => n.channel)
        .sort(),
    ).toEqual(["IN_APP", "TELEGRAM"]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(store.watches.size).toBe(1);
  });
});

describe("isolation", () => {
  it("J. H1 and H4 on one symbol: one request, independent zones and alerts", async () => {
    const h1 = addSetup({ timeframe: "H1", entryLow: 100, entryHigh: 105 });
    const h4 = addSetup({ timeframe: "H4", entryLow: 90, entryHigh: 95 });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 110);
    await monitor.tick();
    feed.set("BTCUSDT", 104);
    await monitor.tick();

    expect(rowsFor(h1.id)).toHaveLength(1);
    expect(rowsFor(h4.id)).toHaveLength(0);
    expect(feed.requests.every((r) => r.length === 1 && r[0] === "BTCUSDT")).toBe(true);

    feed.set("BTCUSDT", 93);
    await monitor.tick();
    expect(rowsFor(h4.id)).toHaveLength(1);
    expect(rowsFor(h4.id)[0].dedupeKey).not.toBe(rowsFor(h1.id)[0].dedupeKey);
  });

  it("K. a move on one symbol never triggers another", async () => {
    const btc = addSetup({ symbol: "BTCUSDT", entryLow: 100, entryHigh: 105 });
    const eth = addSetup({ symbol: "ETHUSDT", entryLow: 100, entryHigh: 105 });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 110);
    feed.set("ETHUSDT", 110);
    await monitor.tick();
    feed.set("ETHUSDT", 102); // BTC stays at 110
    await monitor.tick();

    expect(rowsFor(eth.id)).toHaveLength(1);
    expect(rowsFor(btc.id)).toHaveLength(0);
    // One shared request covering both markets, not a loop per market.
    expect(feed.requests).toEqual([
      ["BTCUSDT", "ETHUSDT"],
      ["BTCUSDT", "ETHUSDT"],
    ]);
  });

  it("M. each owner is told about their own setup only", async () => {
    connectTelegram("user-1");
    store.prefs.set("user-2", { ...DEFAULT_PREFERENCES, telegramEnabled: false });
    const mine = addSetup({ userId: "user-1" });
    const theirs = addSetup({ userId: "user-2" });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 110);
    await monitor.tick();
    feed.set("BTCUSDT", 102);
    await monitor.tick();

    expect(rowsFor(mine.id).every((n) => n.userId === "user-1")).toBe(true);
    expect(rowsFor(theirs.id).every((n) => n.userId === "user-2")).toBe(true);
    expect(rowsFor(theirs.id).map((n) => n.channel)).toEqual(["IN_APP"]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-user-1" }),
    );
    expect(store.watches.get(theirs.id)?.userId).toBe("user-2");
  });

  it("L. an invalidated setup is never loaded", async () => {
    const setup = addSetup({ status: "INVALIDATED" });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();
    expect(monitor.watching()).toBe(0);

    feed.set("BTCUSDT", 102);
    await monitor.tick();
    expect(rowsFor(setup.id)).toHaveLength(0);
    expect(feed.requests).toEqual([]);
  });

  it("L. a setup invalidated after the last reload is dropped at the moment of alerting", async () => {
    const setup = addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    setup.status = "INVALIDATED"; // a scan closed it; the monitor has not reloaded
    feed.set("BTCUSDT", 102);
    expect((await monitor.tick()).gone).toBe(1);

    expect(rowsFor(setup.id)).toHaveLength(0);
    expect(monitor.watching()).toBe(0);
  });
});

describe("failure", () => {
  it("P. a stale price alerts nothing and leaves the setup ready for a fresh one", async () => {
    const setup = addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 102);
    feed.receivedAgo(60_000);
    const stale = await monitor.tick();
    expect(stale.skipped).toBe(1);
    expect(rowsFor(setup.id)).toHaveLength(0);

    feed.receivedAgo(0);
    expect((await monitor.tick()).alerts).toBe(1);
  });

  it("Q. a provider failure evaluates nothing and fabricates nothing", async () => {
    const setup = addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.fail(new MarketDataError("NETWORK_ERROR", "socket hang up"));
    const failed = await monitor.tick();
    expect(failed.polled).toBe(false);
    expect(failed.observed).toBe(0);
    expect(rowsFor(setup.id)).toHaveLength(0);

    feed.fail(null);
    feed.set("BTCUSDT", 102);
    expect((await monitor.tick()).alerts).toBe(1);
  });

  it("logs a provider failure by category, never by its message", async () => {
    addSetup();
    const feed = fakeProvider();
    const log = vi.fn();
    const monitor = createEntryZoneMonitor({ provider: feed.provider, now: () => clock, log });
    await monitor.refresh();

    feed.fail(
      new MarketDataError("UPSTREAM_ERROR", "Provider error 500: <html>secret-host</html>"),
    );
    await monitor.tick();

    expect(log).toHaveBeenCalledWith(expect.stringContaining("UPSTREAM_ERROR"));
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret-host");
  });

  it("one unknown symbol does not blind the monitor to the rest", async () => {
    const btc = addSetup({ symbol: "BTCUSDT" });
    addSetup({ symbol: "GONEUSDT" });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 102);
    vi.mocked(feed.provider.getPrices).mockImplementation(async (symbols: string[]) => {
      if (symbols.includes("GONEUSDT")) {
        throw new MarketDataError("UNKNOWN_SYMBOL", "The exchange does not list this symbol.");
      }
      return [{ symbol: "BTCUSDT", price: 102, receivedAt: clock }];
    });

    expect((await monitor.tick()).alerts).toBe(1);
    expect(rowsFor(btc.id)).toHaveLength(1);

    // Remembered until the next reload: the next tick asks for BTC alone.
    vi.mocked(feed.provider.getPrices).mockClear();
    await monitor.tick();
    expect(feed.provider.getPrices).toHaveBeenCalledTimes(1);
    expect(feed.provider.getPrices).toHaveBeenCalledWith(["BTCUSDT"]);
  });

  it("a delivery that fails outright is not marked reached, and is retried", async () => {
    const setup = addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();

    feed.set("BTCUSDT", 102);
    store.failNotificationWrites = true;
    expect((await monitor.tick()).failed).toBe(1);
    expect(store.watches.get(setup.id)?.reachedAt ?? null).toBeNull();

    store.failNotificationWrites = false;
    expect((await monitor.tick()).alerts).toBe(1);
    expect(rowsFor(setup.id)).toHaveLength(1);
  });
});

describe("routing and preferences", () => {
  it("a high-risk setup is recorded in-app and never pushed", async () => {
    connectTelegram("user-1");
    const setup = addSetup({ analysisStatus: "HIGH_RISK" });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();
    feed.set("BTCUSDT", 102);
    await monitor.tick();

    expect(rowsFor(setup.id).map((n) => n.channel)).toEqual(["IN_APP"]);
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("a waiting setup with a synthetic reward is recorded in-app and never pushed", async () => {
    connectTelegram("user-1");
    const setup = addSetup({ riskRewardIsSynthetic: true });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();
    feed.set("BTCUSDT", 102);
    await monitor.tick();

    expect(rowsFor(setup.id).map((n) => n.channel)).toEqual(["IN_APP"]);
  });

  it("a potential setup is pushed", async () => {
    connectTelegram("user-1");
    const setup = addSetup({ analysisStatus: "POTENTIAL_SETUP" });
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();
    feed.set("BTCUSDT", 102);
    await monitor.tick();

    expect(
      rowsFor(setup.id)
        .map((n) => n.channel)
        .sort(),
    ).toEqual(["IN_APP", "TELEGRAM"]);
  });

  it("switched off: nothing is written, and the setup does not alert later either", async () => {
    store.prefs.set("user-1", { ...DEFAULT_PREFERENCES, entryZoneReached: false });
    const setup = addSetup();
    const feed = fakeProvider();
    const monitor = monitorFor(feed);
    await monitor.refresh();
    feed.set("BTCUSDT", 102);
    await monitor.tick();

    expect(rowsFor(setup.id)).toHaveLength(0);
    expect(store.watches.get(setup.id)?.reachedAt).not.toBeNull();

    store.prefs.set("user-1", { ...DEFAULT_PREFERENCES });
    feed.set("BTCUSDT", 110);
    await monitor.tick();
    feed.set("BTCUSDT", 101);
    await monitor.tick();
    expect(rowsFor(setup.id)).toHaveLength(0);
  });
});
