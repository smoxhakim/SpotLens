// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { MarketDataProvider, PriceQuote } from "@/lib/market-data";

/**
 * The monitor against a real PostgreSQL, so the unique indexes doing the
 * deduplication are Postgres's own rather than a fake's.
 *
 * Opt-in. It runs only when `ENTRY_ZONE_TEST_DATABASE_URL` names a database on
 * this machine, and it refuses anything else outright: it creates and deletes
 * rows, and the database it is pointed at must be one nobody would miss.
 *
 *   docker run -d --rm --name spotlens-ezm-test -e POSTGRES_USER=ezm \
 *     -e POSTGRES_PASSWORD=ezm -e POSTGRES_DB=ezm -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   DATABASE_URL=… DIRECT_URL=… npx prisma migrate deploy        # same local URL
 *   ENTRY_ZONE_TEST_DATABASE_URL=postgresql://ezm:ezm@127.0.0.1:55432/ezm \
 *     npx vitest run services/entry-zone-monitor.db.test.ts
 */

const url = process.env.ENTRY_ZONE_TEST_DATABASE_URL;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

function isLocal(raw: string): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(raw).hostname);
  } catch {
    return false;
  }
}

if (url && !isLocal(url)) {
  throw new Error("ENTRY_ZONE_TEST_DATABASE_URL must point at a local, disposable database.");
}

// Telegram is never contacted from a test, whatever the environment holds.
vi.mock("@/lib/notifications", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications")>("@/lib/notifications");
  return {
    ...actual,
    sendTelegramMessage: async () => ({ ok: true, attempts: 1, retryable: false }),
  };
});

describe.skipIf(!url)("entry-zone monitor on a real database", () => {
  const RUN = `ezm-${Date.now()}`;
  let prisma: typeof import("@/lib/db/prisma").prisma;
  let createEntryZoneMonitor: typeof import("./entry-zone-monitor").createEntryZoneMonitor;
  let userId: string;
  let setupId: string;
  let clock = Date.UTC(2026, 9, 3, 12);
  let price = 110;
  let symbol = "";

  // Quotes this test's own market and nothing else. The monitor watches every
  // open setup in the database, so a provider that priced every symbol would
  // arm — or alert — any other setup that happens to be there, with an
  // invented price. That happened once against a verification database; with
  // no quote, every other setup is simply not evaluated.
  const provider = {
    getPrices: async (symbols: string[]): Promise<PriceQuote[]> =>
      symbols.filter((s) => s === symbol).map((s) => ({ symbol: s, price, receivedAt: clock })),
  } as unknown as MarketDataProvider;

  beforeAll(async () => {
    // Set before the client is constructed: the singleton reads it once.
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/db/prisma"));
    ({ createEntryZoneMonitor } = await import("./entry-zone-monitor"));

    const user = await prisma.user.create({ data: { email: `${RUN}@example.test` } });
    userId = user.id;
    await prisma.notificationPreference.create({
      data: { userId, telegramEnabled: true },
    });
    await prisma.telegramConnection.create({
      data: { userId, bot: "MAIN", chatId: "local-test-chat", connectedAt: new Date() },
    });

    const asset = await prisma.asset.create({
      data: {
        symbol: `EZM${Date.now()}`,
        name: "Entry zone test asset",
        category: "OTHER",
        officialWebsite: "https://example.test",
        description: "Test fixture.",
        utilityExplanation: "Test fixture.",
        riskLevel: "LOW",
      },
    });
    const pair = await prisma.tradingPair.create({
      data: { assetId: asset.id, quoteCurrency: "USDT", exchangeSymbol: `${asset.symbol}USDT` },
    });

    const setup = await prisma.trackedSetup.create({
      data: {
        userId,
        tradingPairId: pair.id,
        timeframe: "H1",
        status: "SETUP_FORMING",
        entryLow: "100.00000000",
        entryHigh: "105.00000000",
        stopLoss: "97.00000000",
        takeProfit1: "115.00000000",
        riskReward: "2.40",
        riskRewardIsSynthetic: false,
        score: 82,
        scoreGrade: "STRONG",
        analysisStatus: "WAIT_FOR_CONFIRMATION",
        snapshot: { entryReason: "fixture", statusReason: "fixture", trend: "BULLISH" },
        originZoneLow: "100.00000000",
        originZoneHigh: "105.00000000",
        events: {
          create: { type: "CREATED", toStatus: "SETUP_FORMING", detail: "fixture" },
        },
      },
    });
    setupId = setup.id;
    symbol = pair.exchangeSymbol;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { email: `${RUN}@example.test` } });
    await prisma.asset.deleteMany({ where: { symbol: { startsWith: "EZM" } } });
    await prisma.$disconnect();
  });

  it("two monitors at once, then a restart: exactly one row per channel, one watch, setup untouched", async () => {
    const before = await prisma.trackedSetup.findUniqueOrThrow({ where: { id: setupId } });
    const watchesBefore = await prisma.setupEntryZoneWatch.count({
      where: { trackedSetupId: { not: setupId } },
    });

    const a = createEntryZoneMonitor({ provider, now: () => clock });
    const b = createEntryZoneMonitor({ provider, now: () => clock });
    await Promise.all([a.refresh(), b.refresh()]);

    price = 110; // above the zone
    await Promise.all([a.tick(), b.tick()]);

    price = 104.5; // inside
    clock += 10_000;
    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
    expect(ra.alerts + rb.alerts).toBeGreaterThanOrEqual(1);

    // Restart: a third process, price still inside.
    const c = createEntryZoneMonitor({ provider, now: () => clock });
    await c.refresh();
    clock += 10_000;
    await c.tick();
    price = 120;
    await c.tick();
    price = 101; // re-entry
    await c.tick();

    const rows = await prisma.notification.findMany({
      where: { userId, trackedSetupId: setupId },
      select: { type: true, channel: true, dedupeKey: true, status: true },
      orderBy: { channel: "asc" },
    });
    expect(rows).toEqual([
      {
        type: "ENTRY_ZONE_REACHED",
        channel: "IN_APP",
        dedupeKey: `entry-zone:${setupId}`,
        status: "SENT",
      },
      {
        type: "ENTRY_ZONE_REACHED",
        channel: "TELEGRAM",
        dedupeKey: `entry-zone:${setupId}`,
        status: "SENT",
      },
    ]);

    const watch = await prisma.setupEntryZoneWatch.findUniqueOrThrow({
      where: { trackedSetupId: setupId },
    });
    expect(watch.userId).toBe(userId);
    expect(watch.reachedAt).not.toBeNull();
    expect(watch.reachedPrice?.toString()).toBe("104.5");

    // The setup itself: not one column moved, and no lifecycle event was added.
    const after = await prisma.trackedSetup.findUniqueOrThrow({ where: { id: setupId } });
    expect(after).toEqual(before);
    expect(await prisma.setupEvent.count({ where: { setupId } })).toBe(1);
    expect(await prisma.journalEntry.count({ where: { userId } })).toBe(0);

    // Nothing outside this test's own setup was touched.
    expect(
      await prisma.setupEntryZoneWatch.count({ where: { trackedSetupId: { not: setupId } } }),
    ).toBe(watchesBefore);
  });

  it("the database itself refuses a second row for the same setup and channel", async () => {
    await expect(
      prisma.notification.create({
        data: {
          userId,
          type: "ENTRY_ZONE_REACHED",
          channel: "IN_APP",
          priority: "MEDIUM",
          title: "duplicate",
          body: "duplicate",
          dedupeKey: `entry-zone:${setupId}`,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      prisma.setupEntryZoneWatch.create({ data: { trackedSetupId: setupId, userId } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
