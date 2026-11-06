// @vitest-environment node
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FaultProxy } from "@/lib/test-utils/fault-proxy";
import {
  startFixtureExchange,
  stubNetwork,
  type FixtureSeries,
} from "@/lib/test-utils/fixture-exchange";
import { downtrend, extendedAboveSupport, pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import {
  FAULT_TESTS_ENABLED,
  startThrowawayPostgres,
  type ThrowawayPostgres,
} from "@/lib/test-utils/throwaway-postgres";

await vi.hoisted(async () => {
  const { applyHermeticEnv } = await import("@/lib/test-utils/hermetic-env");
  applyHermeticEnv({});
});

/**
 * Every lifecycle transition against every fault, from a real pass through the real
 * delivery code, with the schedule's real retries.
 *
 * Notifications are at most once, by accepted policy, and Part A adds no recovery. So
 * what this pins is that policy's edges: an event the pass can name is delivered once,
 * through any number of retries; an event whose commit lost its answer, or whose
 * delivery met a dead store, is lost and stays lost; nothing is ever sent twice; and a
 * failed pass still delivers what it did commit.
 *
 * Telegram is answered in-process by a stub with a stub token. Nothing leaves this
 * machine, and the last test checks that. Exact rows per case are in
 * `__golden__/scanner-notifications.golden.txt`, generated like the lifecycle golden and
 * reviewed in a diff; regenerate only when delivery changes on purpose.
 *
 * Opt-in: SPOTLENS_FAULT_TESTS=1, Docker and a local postgres:16-alpine. It starts its
 * own server and takes no database URL. About 90 seconds.
 */

const H = 3_600_000;
const SETTLE = 90_000;

const KINDS = ["CREATE", "REPLACE", "REPLACE_SUPPORT_LOST", "INVALIDATE"] as const;
type Kind = (typeof KINDS)[number];

/** What each transition produces when nothing goes wrong. */
const TRANSITION: Record<
  Kind,
  { setups: number; open: number; events: number; closure: string[]; sends: number }
> = {
  CREATE: { setups: 1, open: 1, events: 1, closure: [], sends: 1 },
  // In-app only: a replacement is low routing unless a confirmed setup lost support.
  REPLACE: { setups: 2, open: 1, events: 3, closure: ["SUPERSEDED"], sends: 0 },
  REPLACE_SUPPORT_LOST: { setups: 2, open: 1, events: 3, closure: ["SUPPORT_LOST"], sends: 2 },
  INVALIDATE: { setups: 1, open: 0, events: 2, closure: [], sends: 1 },
};

type Delivery =
  | "ALL" //      every notification, once
  | "LOST" //     none of this transition's, and never later
  | "PARTIAL" //  some rows written before the cut; never more than ALL
  | "TELEGRAM"; // every in-app row, and Telegram's outcome recorded as failed or pending

interface Expected {
  outcomes: string[];
  stored: string[];
  fired: string[];
  delivery: Delivery;
}

const OK: Pick<Expected, "outcomes" | "stored"> = {
  outcomes: ["SUCCEEDED"],
  stored: ["COMPLETED"],
};
const TRANSIENT = ["FAILED_TRANSIENT", "SUCCEEDED"];
const BLOCKED = ["FAILED_BLOCKED", "SUCCEEDED"];

const FAULTS = {
  NONE: { ...OK, fired: [], delivery: "ALL" },
  // Cut before the commit: nothing written, and the retry writes and names it.
  CUT_BODY: {
    outcomes: TRANSIENT,
    stored: ["FAILED", "COMPLETED"],
    fired: ["BODY"],
    delivery: "ALL",
  },
  CUT_BEFORE_COMMIT: {
    outcomes: TRANSIENT,
    stored: ["FAILED", "COMPLETED"],
    fired: ["BEFORE_COMMIT"],
    delivery: "ALL",
  },
  // Committed, answer lost: the event exists and nothing names it. Lost, by policy.
  ACK_LOST: {
    outcomes: TRANSIENT,
    stored: ["FAILED", "COMPLETED"],
    fired: ["AFTER_COMMIT"],
    delivery: "LOST",
  },
  // Another market failed: this one's commit stands, and is delivered from a FAILED pass.
  OTHER_TRANSIENT: {
    outcomes: TRANSIENT,
    stored: ["FAILED", "COMPLETED"],
    fired: ["BODY"],
    delivery: "ALL",
  },
  OTHER_PERMANENT: {
    outcomes: BLOCKED,
    stored: ["FAILED", "COMPLETED"],
    fired: ["PERMANENT"],
    delivery: "ALL",
  },
  SAVE_TRANSIENT: {
    outcomes: TRANSIENT,
    stored: ["RUNNING", "COMPLETED"],
    fired: ["FINISH_BEFORE_COMMIT"],
    delivery: "ALL",
  },
  SAVE_ACK_LOST: {
    outcomes: TRANSIENT,
    stored: ["COMPLETED", "COMPLETED"],
    fired: ["FINISH_AFTER_COMMIT"],
    delivery: "ALL",
  },
  SAVE_PERMANENT: {
    outcomes: BLOCKED,
    stored: ["RUNNING", "COMPLETED"],
    fired: [],
    delivery: "ALL",
  },
  // The store is gone when delivery needs it: committed, named, and still lost.
  OUTAGE_TO_END: {
    outcomes: TRANSIENT,
    stored: ["RUNNING", "COMPLETED"],
    fired: ["OUTAGE"],
    delivery: "LOST",
  },
  STORE_DOWN_ONLY: { ...OK, fired: [], delivery: "LOST" },
  NOTIF_FIRST_INSERT_CUT: { ...OK, fired: ["NOTIF_INSERT"], delivery: "PARTIAL" },
  NOTIF_SECOND_INSERT_CUT: { ...OK, fired: ["NOTIF_INSERT"], delivery: "PARTIAL" },
  TG_500: { ...OK, fired: [], delivery: "TELEGRAM" },
  TG_TIMEOUT: { ...OK, fired: [], delivery: "TELEGRAM" },
  TG_RECORD_LOST: { ...OK, fired: [], delivery: "TELEGRAM" },
  CRASH_BEFORE_NOTIFY: { ...OK, fired: [], delivery: "LOST" },
  REDELIVER: { ...OK, fired: [], delivery: "ALL" },
} satisfies Record<string, Expected>;
type Fault = keyof typeof FAULTS;

const CASES = KINDS.flatMap((kind) =>
  (Object.keys(FAULTS) as Fault[]).map((fault) => [kind, fault] as const),
);

describe.skipIf(!FAULT_TESTS_ENABLED)("notifications under real faults", () => {
  let pg: ThrowawayPostgres;
  let observer: PrismaClient;
  let proxy: FaultProxy;
  let exchange: Awaited<ReturnType<typeof startFixtureExchange>>;
  let network: ReturnType<typeof stubNetwork>;
  let scanner: typeof import("@/services/scanner");
  let retry: typeof import("@/lib/scanner/retry");
  let schedule: typeof import("@/lib/scanner/schedule");
  let eventsFromScan: typeof import("@/services/notification-events").eventsFromScan;
  let buildDailySummary: typeof import("@/services/notification-events").buildDailySummary;
  let deliverEvents: typeof import("@/services/notifications").deliverEvents;
  let deliverConfirmationAlerts: typeof import("@/services/confirmation-alerts").deliverConfirmationAlerts;
  let deliverScanReport: typeof import("@/services/scan-report").deliverScanReport;
  let userId: string;
  const golden: string[] = [];
  const logged: string[] = [];
  /** What each transition delivers with nothing wrong. Its NONE case runs first. */
  const fullRows = {} as Record<Kind, Record<string, number>>;

  const bull = pullbackIntoSupport();
  type Candle = (typeof bull)[number];
  const scaled = (candles: Candle[], k: number) =>
    candles.map((c) => ({
      ...c,
      open: c.open * k,
      high: c.high * k,
      low: c.low * k,
      close: c.close * k,
    }));

  const setClock = async (ms: number) => {
    vi.setSystemTime(ms);
    await observer.$executeRawUnsafe(
      `UPDATE test_clock SET at = '${new Date(ms).toISOString()}'::timestamp`,
    );
  };

  let marketNumber = 0;
  const newMarket = async (prefix: string) => {
    marketNumber += 1;
    const symbol = `${prefix}${marketNumber}USDT`;
    const pair = await observer.tradingPair.create({
      data: {
        quoteCurrency: "USDT",
        exchangeSymbol: symbol,
        asset: {
          create: {
            symbol: `${prefix}${marketNumber}`,
            name: symbol,
            category: "OTHER",
            officialWebsite: "https://example.test",
            description: "x",
            utilityExplanation: "x",
            riskLevel: "LOW",
          },
        },
      },
    });
    return { pairId: pair.id, exchangeSymbol: symbol, label: symbol } as never as {
      pairId: string;
      exchangeSymbol: string;
    };
  };

  /** The script's delivery, in the script's order, each wrapped the way the script wraps it. */
  const deliver = async (summary: Awaited<ReturnType<typeof scanner.runScan>>) => {
    network.phase = "NOTIFY";
    try {
      const events = await eventsFromScan({ userId, scannerEvents: summary.events });
      if (events.length > 0) await deliverEvents(events);
    } catch {
      // `notify` logs and carries on.
    }
    network.phase = "CONFIRM";
    try {
      if (summary.observations.length > 0) {
        await deliverConfirmationAlerts({ userId, observations: summary.observations });
      }
    } catch {
      // `watchConfirmation` logs and carries on.
    }
    network.phase = "REPORT";
    await deliverScanReport({ userId, runId: summary.runId, events: summary.events }).catch(
      () => undefined,
    );
    network.phase = "DAILY";
    try {
      const daily = await buildDailySummary({ userId });
      if (daily) await deliverEvents([daily]);
    } catch {
      // `maybeSendDailySummary` logs and carries on.
    }
    network.phase = "NONE";
  };

  beforeAll(async () => {
    pg = await startThrowawayPostgres();
    const direct = await pg.createDatabase("notifications_test", { faultFixtures: true });
    proxy = new FaultProxy(pg.port);
    await proxy.start();
    exchange = await startFixtureExchange({
      get now() {
        return Date.now();
      },
    });
    network = stubNetwork();

    process.env.DATABASE_URL = pg.urlVia(
      proxy,
      "notifications_test",
      "sslmode=disable&statement_cache_size=0&connection_limit=4&connect_timeout=2&pool_timeout=4",
    );
    process.env.DIRECT_URL = direct;
    process.env.BINANCE_API_BASE_URL = `http://127.0.0.1:${exchange.port}`;
    // Not tokens: the stub answers before anything leaves this process.
    process.env.TELEGRAM_BOT_TOKEN = "stub";
    process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN = "stub";

    observer = new PrismaClient({ datasourceUrl: direct, log: [] });
    userId = (await observer.user.create({ data: { email: "notifications@example.test" } })).id;
    await observer.notificationPreference.create({
      data: {
        userId,
        inAppEnabled: true,
        telegramEnabled: true,
        setupDetected: true,
        confirmationDetected: true,
        setupInvalidated: true,
        structureChanged: true,
        dailySummary: true,
        systemError: true,
        confirmationAlerts: true,
        entryZoneReached: true,
        scanReport: true,
      },
    });
    for (const bot of ["MAIN", "CONFIRMATION"] as const) {
      await observer.telegramConnection.create({
        data: { userId, bot, chatId: `stub-${bot}`, connectedAt: new Date() },
      });
    }

    // Only the date: real timers keep running, so real timeouts still happen.
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }

    scanner = await import("@/services/scanner");
    retry = await import("@/lib/scanner/retry");
    schedule = await import("@/lib/scanner/schedule");
    ({ eventsFromScan, buildDailySummary } = await import("@/services/notification-events"));
    ({ deliverEvents } = await import("@/services/notifications"));
    ({ deliverConfirmationAlerts } = await import("@/services/confirmation-alerts"));
    ({ deliverScanReport } = await import("@/services/scan-report"));
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    network?.restore();
    const { prisma } = await import("@/lib/db/prisma");
    await prisma.$disconnect().catch(() => undefined);
    await observer?.$disconnect();
    await proxy?.stop();
    await exchange?.close();
    await pg?.stop();
  });

  let caseIndex = 0;

  it.each(CASES)(
    "%s under %s",
    async (kind, fault) => {
      caseIndex += 1;
      const expected: Expected = FAULTS[fault];
      const shape = TRANSITION[kind];
      const C0 = Date.UTC(2026, 0, 5, 12) + caseIndex * 48 * H;

      const target = await newMarket("T");
      const other = await newMarket("O");
      const steady: FixtureSeries = { H1: bull, H4: bull };
      const before: FixtureSeries =
        kind === "REPLACE_SUPPORT_LOST"
          ? { H1: scaled(bull, 2), H4: scaled(bull, 2) }
          : { H1: bull, H4: bull };
      exchange.series.set(other.exchangeSymbol, steady);
      if (kind !== "CREATE") exchange.series.set(target.exchangeSymbol, before);

      // The window before: the state each transition starts from.
      await setClock(C0 + SETTLE);
      const pre = await scanner.runScan({
        userId,
        timeframes: ["H1"],
        markets: (kind === "CREATE" ? [other] : [target, other]) as never[],
        maxConcurrency: 1,
        triggeredBy: "SCHEDULE",
        now: Date.now(),
      });
      await deliver(pre);

      exchange.series.set(
        target.exchangeSymbol,
        kind === "CREATE"
          ? steady
          : kind === "REPLACE"
            ? { H1: extendedAboveSupport(), H4: bull }
            : kind === "REPLACE_SUPPORT_LOST"
              ? steady
              : { H1: downtrend(), H4: downtrend() },
      );

      const setupIds = async () =>
        (
          await observer.trackedSetup.findMany({
            where: { tradingPairId: target.pairId },
            select: { id: true },
          })
        ).map((s) => s.id);
      const rows = async () => {
        const list = await observer.notification.findMany({
          where: { trackedSetupId: { in: await setupIds() } },
          select: { channel: true, type: true, status: true },
        });
        const grouped: Record<string, number> = {};
        for (const r of list) {
          const key = `${r.channel} ${r.type} ${r.status}`;
          grouped[key] = (grouped[key] ?? 0) + 1;
        }
        return Object.fromEntries(Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)));
      };
      const baseline = await rows();

      let state: ReturnType<typeof retry.recordPass> = {
        covered: schedule.scannedThroughAt(["H1"], C0 + SETTLE),
        retry: null,
        notBefore: null,
      };
      let unfinished: string | null = null;
      const attempts: { outcome: string; stored: string | null; covered: boolean }[] = [];
      const sendsBefore = network.sends.filter((s) => s.phase === "NOTIFY").length;
      const runIds: string[] = [];
      const notified = { sendsAfterFirst: 0, rowsAfterFirst: {} as Record<string, number> };
      const firedBefore = proxy.fired.length;

      for (let a = 1; a <= 7; a += 1) {
        const wake = retry.nextWake({ state, timeframes: ["H1"] });
        await setClock(wake.at);
        const due = schedule.scanOnWake({
          timeframes: ["H1"],
          scannedThrough: state.covered,
          plannedAt: wake.at,
          now: wake.at,
        });
        if (unfinished) {
          await scanner.closeUnfinishedRun(unfinished);
          unfinished = null;
        }

        const base = proxy.lifecycleCount;
        if (a === 1) {
          if (fault === "CUT_BODY") proxy.plan.set(base + 1, "BODY");
          if (fault === "CUT_BEFORE_COMMIT") proxy.plan.set(base + 1, "BEFORE_COMMIT");
          if (fault === "ACK_LOST") proxy.plan.set(base + 1, "AFTER_COMMIT");
          if (fault === "OTHER_TRANSIENT") proxy.plan.set(base + 2, "BODY");
          if (fault === "OTHER_PERMANENT") proxy.plan.set(base + 2, "PERMANENT");
          if (fault === "SAVE_TRANSIENT") proxy.finishFault = "BEFORE_COMMIT";
          if (fault === "SAVE_ACK_LOST") proxy.finishFault = "AFTER_COMMIT";
          if (fault === "SAVE_PERMANENT") {
            await observer.$executeRawUnsafe("UPDATE test_flags SET poison_results = true");
          }
          if (fault === "OUTAGE_TO_END") proxy.outageAt = base + 2;
        }

        const summary = await scanner.runScan({
          userId,
          timeframes: due.timeframes,
          markets: [target, other] as never[],
          maxConcurrency: 1,
          triggeredBy: "SCHEDULE",
          now: wake.at,
        });
        const outcome = retry.classifyPass(summary);
        proxy.finishFault = null;
        proxy.outageAt = null;
        await observer.$executeRawUnsafe("UPDATE test_flags SET poison_results = false");

        // The rule this whole phase exists for.
        const lostAWrite =
          summary.saveFailure !== null ||
          summary.results.some((r) => r.failure?.category === "DATABASE_ERROR");
        if (lostAWrite) expect(outcome).not.toBe("SUCCEEDED");

        if (summary.runId) runIds.push(summary.runId);
        if (summary.unfinishedRunId) {
          unfinished = summary.unfinishedRunId;
          runIds.push(unfinished);
        }

        // What happens between the pass and delivery.
        if (a === 1) {
          if (fault === "STORE_DOWN_ONLY") await proxy.stop();
          if (fault === "NOTIF_FIRST_INSERT_CUT") proxy.cutNotificationAfter = 0;
          if (fault === "NOTIF_SECOND_INSERT_CUT") proxy.cutNotificationAfter = 1;
          if (fault === "TG_500") network.mode = "500";
          if (fault === "TG_TIMEOUT") network.mode = "TIMEOUT";
          if (fault === "TG_RECORD_LOST") network.onSend = () => proxy.stop();
        }
        if (!(a === 1 && fault === "CRASH_BEFORE_NOTIFY")) await deliver(summary);
        if (a === 1 && fault === "REDELIVER") await deliver(summary);
        proxy.cutNotificationAfter = null;
        network.mode = "OK";
        network.onSend = null;
        await proxy.start();

        const finishedAt = wake.at + 1000;
        state = retry.recordPass(state, {
          timeframes: ["H1"],
          scanned: due.timeframes,
          decidedAt: wake.at,
          finishedAt,
          outcome,
        });
        vi.setSystemTime(finishedAt);

        const id = summary.runId ?? summary.unfinishedRunId;
        const stored = id
          ? await observer.scannerRun.findUnique({ where: { id }, select: { status: true } })
          : null;
        attempts.push({
          outcome,
          stored: stored?.status ?? null,
          covered: state.covered.H1! > schedule.scannedThroughAt(["H1"], C0 + SETTLE).H1!,
        });
        if (a === 1) {
          notified.rowsAfterFirst = await rows();
          notified.sendsAfterFirst =
            network.sends.filter((s) => s.phase === "NOTIFY").length - sendsBefore;
        }
        if (outcome === "SUCCEEDED" || outcome === "FAILED_PERMANENT") break;
      }

      // A forced repeat of the same candle: nothing new may come of it.
      await setClock(Date.now() + 60_000);
      const repeat = await scanner.runScan({
        userId,
        timeframes: ["H1"],
        markets: [target, other] as never[],
        maxConcurrency: 1,
        triggeredBy: "SCHEDULE",
        now: Date.now(),
      });
      await deliver(repeat);
      if (repeat.runId) runIds.push(repeat.runId);

      const ids = await setupIds();
      const setups = await observer.trackedSetup.findMany({
        where: { id: { in: ids } },
        include: { events: { select: { id: true, type: true, toStatus: true, payload: true } } },
      });
      const notificationRows = await observer.notification.findMany({
        where: { trackedSetupId: { in: ids } },
        select: { dedupeKey: true, channel: true },
      });
      const events = setups.flatMap((s) => s.events);
      const closure = events
        .map((e) => (e.payload as { closure?: { cause?: string } } | null)?.closure?.cause ?? null)
        .filter(Boolean);
      const final = await rows();
      const sends = network.sends.filter((s) => s.phase === "NOTIFY").length - sendsBefore;

      // --- the fault really happened, and the pass was called what it should be
      expect(proxy.fired.slice(firedBefore).map((f) => f.mode)).toEqual(expected.fired);
      expect(attempts.map((t) => t.outcome)).toEqual(expected.outcomes);
      expect(attempts.map((t) => t.stored)).toEqual(expected.stored);
      expect(attempts.at(-1)?.covered).toBe(true);
      for (const t of attempts.slice(0, -1)) expect(t.covered).toBe(false);

      // --- the lifecycle is the same whatever happened to the connection
      expect(setups).toHaveLength(shape.setups);
      expect(setups.filter((s) => s.status !== "INVALIDATED")).toHaveLength(shape.open);
      expect(events).toHaveLength(shape.events);
      expect(closure).toEqual(shape.closure);

      // --- never twice, whatever happened
      expect(repeat.events.filter((e) => e.type !== "ANALYSIS_FAILED")).toEqual([]);
      expect(notificationRows.length).toBe(
        new Set(notificationRows.map((r) => `${r.channel}|${r.dedupeKey}`)).size,
      );
      expect(sends).toBeLessThanOrEqual(
        expected.delivery === "TELEGRAM" ? 3 * shape.sends : shape.sends,
      );

      // --- no run left behind, and no scan report for a pass that could not be saved
      expect(
        await observer.scannerRun.count({ where: { id: { in: runIds }, status: "RUNNING" } }),
      ).toBe(0);
      expect(
        await observer.notification.count({
          where: {
            type: "SYSTEM_ERROR",
            asset: { in: [target.exchangeSymbol, other.exchangeSymbol] },
          },
        }),
      ).toBe(0);

      // --- what the fault did to delivery, by policy
      if (fault === "NONE") fullRows[kind] = final;
      const full = fullRows[kind];
      if (expected.delivery === "ALL") {
        expect(final).toEqual(full);
        expect(sends).toBe(shape.sends);
      }
      if (expected.delivery === "LOST") {
        expect(final).toEqual(baseline);
        expect(sends).toBe(0);
      }
      if (expected.delivery === "PARTIAL" || expected.delivery === "TELEGRAM") {
        for (const key of Object.keys(final).filter((k) => k.endsWith(" SENT"))) {
          expect(final[key]).toBeLessThanOrEqual(full[key]);
        }
      }

      const reports = await observer.notification.count({
        where: { type: "SCAN_REPORT", dedupeKey: { in: runIds.map((r) => `scan-report:${r}`) } },
      });
      golden.push(
        `${kind} ${fault}: ${attempts.map((t) => `${t.outcome}/${t.stored}`).join(" ")} | rows ${JSON.stringify(final)} | sends ${sends} | reports ${reports}`,
      );
    },
    60_000,
  );

  it("exact rows per case match the reviewed golden file", async () => {
    expect(golden).toHaveLength(CASES.length);
    await expect(`${golden.join("\n")}\n`).toMatchFileSnapshot(
      "./__golden__/scanner-notifications.golden.txt",
    );
  });

  it("an exchange failing through every retry: one SYSTEM_ERROR per market per hour, not per attempt", async () => {
    const market = await newMarket("X");
    exchange.series.set(market.exchangeSymbol, { status: 500 });
    const t = Date.UTC(2026, 11, 1, 12);
    const pass = async (minutes: number) => {
      await setClock(t + minutes * 60_000);
      const summary = await scanner.runScan({
        userId,
        timeframes: ["H1"],
        markets: [market] as never[],
        maxConcurrency: 1,
        triggeredBy: "SCHEDULE",
        now: Date.now(),
      });
      const delivered = await deliverEvents(
        await eventsFromScan({ userId, scannerEvents: summary.events, now: Date.now() }),
      );
      return { outcome: retry.classifyPass(summary), created: delivered.created };
    };
    const count = () =>
      observer.notification.groupBy({
        by: ["dedupeKey"],
        where: { type: "SYSTEM_ERROR", asset: market.exchangeSymbol },
        _count: true,
      });

    const first = await pass(1.5);
    expect(first.outcome).toBe("FAILED_TRANSIENT");
    expect(first.created).toBeGreaterThan(0);
    for (const minutes of [2.5, 4.5, 9.5, 19.5, 59.5]) {
      expect(await pass(minutes)).toEqual({ outcome: "FAILED_TRANSIENT", created: 0 });
    }
    expect(await count()).toHaveLength(1);

    const nextHour = await pass(60.5);
    expect(nextHour.created).toBeGreaterThan(0);
    expect(await count()).toHaveLength(2);
  }, 120_000);

  it("across every case: no duplicate key, one daily summary per day, nothing left this machine", async () => {
    const duplicates = await observer.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) n FROM (
        SELECT "userId", channel, "dedupeKey" FROM "Notification" GROUP BY 1, 2, 3 HAVING count(*) > 1
      ) x`;
    expect(Number(duplicates[0].n)).toBe(0);

    const daily = await observer.notification.groupBy({
      by: ["channel", "dedupeKey"],
      where: { type: "DAILY_SUMMARY" },
      _count: true,
    });
    expect(daily.every((d) => d._count === 1)).toBe(true);

    expect(network.blocked).toEqual([]);
    expect(logged.filter((line) => /postgres(ql)?:\/\/|throwaway:throwaway/.test(line))).toEqual(
      [],
    );
  });
});
