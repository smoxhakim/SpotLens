// @vitest-environment node
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FaultProxy } from "@/lib/test-utils/fault-proxy";
import { startRecordedExchange, stubNetwork } from "@/lib/test-utils/fixture-exchange";
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
 * A week of real candles, three ways, through the real pass, the real schedule and the
 * real delivery code.
 *
 *  - control: no faults. What the week should have looked like.
 *  - faulted: random cuts, lost commits, outages and dead stores, all transient. Every
 *    window ends in a success, so what is stored must be identical to the control. This
 *    is the claim that a retry is safe: faults may cost notifications, never history.
 *  - poison: the same, plus real permanent refusals. A blocked window is not retried, so
 *    that hour's candle may never be read and history may differ. Everything else holds.
 *
 * The candles are four public markets, exported once to a fixture; nothing here reaches
 * an exchange or reads any other database. Random, but seeded.
 *
 * Opt-in: SPOTLENS_FAULT_TESTS=1, Docker and a local postgres:16-alpine. It starts its
 * own server and takes no database URL. A few minutes.
 */

const FIXTURE = join(process.cwd(), "services/__fixtures__/replay-candles.csv.gz");
const SYMBOLS = ["PYTHUSDT", "SKYUSDT", "STXUSDT", "UNIUSDT"];
const TFS: ("H1" | "H4")[] = ["H1", "H4"];
const H = 3_600_000;
const SETTLE = 90_000;
const STEPS = 168;
const LAST_CLOSE = Date.UTC(2026, 10, 5, 21);
const FIRST = LAST_CLOSE - (STEPS - 1) * H;
const VIA_PROXY =
  "sslmode=disable&statement_cache_size=0&connection_limit=10&connect_timeout=2&pool_timeout=5";
const LOG_LEAK = /postgres(ql)?:\/\/|throwaway:throwaway/;

/** One of each, first, so "the faults really happened" does not depend on a dice roll. */
const FORCED_FAULTS = [
  "BODY",
  "BEFORE_COMMIT",
  "AFTER_COMMIT",
  "FINISH_BEFORE_COMMIT",
  "FINISH_AFTER_COMMIT",
  "OUTAGE",
  "FULL_OUTAGE",
] as const;

type Mode = "control" | "faulted" | "poison";

function seededRandom(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!FAULT_TESTS_ENABLED)("a week of real candles under real faults", () => {
  let pg: ThrowawayPostgres;
  let network: ReturnType<typeof stubNetwork>;
  let exchange: Awaited<ReturnType<typeof startRecordedExchange>>;
  const logged: string[] = [];
  const results = {} as Record<Mode, Awaited<ReturnType<typeof replay>>>;

  async function replay(mode: Mode, concurrency: number, seed: number) {
    const dbName = `replay_${mode}_test`;
    const direct = await pg.createDatabase(dbName, { faultFixtures: true });
    const proxy = new FaultProxy(pg.port);
    await proxy.start();

    // A database of its own for this mode, so the app's client has to be built again.
    vi.resetModules();
    delete (globalThis as { prisma?: unknown }).prisma;
    process.env.DATABASE_URL = pg.urlVia(proxy, dbName, VIA_PROXY);
    process.env.DIRECT_URL = direct;

    const observer = new PrismaClient({ datasourceUrl: direct, log: [] });
    const { prisma } = await import("@/lib/db/prisma");
    const scanner = await import("@/services/scanner");
    const { classifyPass, classifyPassError, nextWake, recordPass } =
      await import("@/lib/scanner/retry");
    const { scannedThroughAt, scanOnWake, settlementDelayMs } =
      await import("@/lib/scanner/schedule");
    const { eventsFromScan, buildDailySummary } = await import("@/services/notification-events");
    const { deliverEvents } = await import("@/services/notifications");
    const { deliverConfirmationAlerts } = await import("@/services/confirmation-alerts");
    const { deliverScanReport } = await import("@/services/scan-report");

    const setClock = async (ms: number) => {
      vi.setSystemTime(ms);
      await observer.$executeRawUnsafe(
        `UPDATE test_clock SET at = '${new Date(ms).toISOString()}'::timestamp`,
      );
    };

    const userId = (await observer.user.create({ data: { email: "replay@example.test" } })).id;
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
    for (const symbol of SYMBOLS) {
      await observer.tradingPair.create({
        data: {
          quoteCurrency: "USDT",
          exchangeSymbol: symbol,
          asset: {
            create: {
              symbol: symbol.replace(/USDT$/, ""),
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
    }

    const random = seededRandom(seed);
    const stats = {
      passes: 0,
      outcomes: {} as Record<string, number>,
      faults: {} as Record<string, number>,
      succeededWithDatabaseFailure: 0,
      maxBlockedPerWindow: 0,
      maxAttemptsPerWindow: 0,
      windowsLost: 0,
      failedPassesWithCommittedEvents: 0,
      closedUnfinished: 0,
      storedAsSuccessAfterDatabaseFailure: 0,
    };
    const named = new Map<string, { storeDown: boolean }>();
    const skippedObservation = new Set<string>();
    const failedAttemptRunIds = new Set<string>();
    const runsPerWindow = new Map<number, string[]>();

    const deliver = async (summary: Awaited<ReturnType<typeof scanner.runScan>>, down: boolean) => {
      network.phase = "NOTIFY";
      for (const e of summary.events) {
        if (!e.eventId) continue;
        named.set(e.eventId, { storeDown: down || (named.get(e.eventId)?.storeDown ?? false) });
      }
      try {
        const events = await eventsFromScan({ userId, scannerEvents: summary.events });
        if (events.length > 0) await deliverEvents(events);
      } catch {
        // `notify` logs and carries on.
      }
      network.phase = "CONFIRM";
      try {
        if (summary.observations.length > 0) {
          if (down) for (const o of summary.observations) skippedObservation.add(o.trackedSetupId);
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

    let state: ReturnType<typeof recordPass> = {
      covered: scannedThroughAt(TFS, FIRST - H + SETTLE),
      retry: null,
      notBefore: null,
    };
    let unfinished: string | null = null;
    const attemptsInWindow = new Map<number, number>();
    const blockedInWindow = new Map<number, number>();
    const succeededWindows = new Set<number>();

    for (;;) {
      const wake = nextWake({ state, timeframes: TFS });
      if (wake.at > LAST_CLOSE + H - 1) break;
      const now = wake.at + settlementDelayMs(TFS, wake.at);
      await setClock(now);
      const due = scanOnWake({
        timeframes: TFS,
        scannedThrough: state.covered,
        plannedAt: wake.at,
        now,
      });
      if (due.timeframes.length === 0) {
        state = { ...state, retry: null };
        continue;
      }
      if (unfinished) {
        if ((await scanner.closeUnfinishedRun(unfinished)) === "CLOSED")
          stats.closedUnfinished += 1;
        unfinished = null;
      }

      const window = Math.floor(now / H);
      const attempt = (attemptsInWindow.get(window) ?? 0) + 1;
      attemptsInWindow.set(window, attempt);

      // The last attempt a window gets is clean, connections included: a window lost to
      // a pool of dead sockets would prove nothing about what a retry does to history.
      if (attempt >= 5) await prisma.$disconnect();

      // Draw this attempt's faults.
      const base = proxy.lifecycleCount;
      const transactions = SYMBOLS.length * due.timeframes.length;
      let fullOutage = false;
      let outageToEnd = false;
      let storeDownOnly = false;
      const forced =
        mode !== "control" && attempt === 1 ? FORCED_FAULTS[attemptsInWindow.size - 1] : undefined;
      if (forced === "BODY" || forced === "BEFORE_COMMIT" || forced === "AFTER_COMMIT") {
        proxy.plan.set(base + 1, forced);
      } else if (forced === "FINISH_BEFORE_COMMIT") {
        proxy.finishFault = "BEFORE_COMMIT";
      } else if (forced === "FINISH_AFTER_COMMIT") {
        proxy.finishFault = "AFTER_COMMIT";
      } else if (forced === "OUTAGE") {
        proxy.outageAt = base + 2;
      } else if (forced === "FULL_OUTAGE") {
        fullOutage = true;
        stats.faults.FULL_OUTAGE = (stats.faults.FULL_OUTAGE ?? 0) + 1;
        await proxy.stop();
      } else if (mode !== "control") {
        const roll = attempt >= 5 ? 0 : attempt === 1 ? random() : random() * 0.4;
        if (roll >= 0.3 && roll < 0.7) {
          for (let k = 1; k <= transactions; k += 1) {
            if (random() < 0.15) {
              const m = random();
              proxy.plan.set(
                base + k,
                m < 0.34 ? "BODY" : m < 0.67 ? "BEFORE_COMMIT" : "AFTER_COMMIT",
              );
            }
          }
        } else if (roll >= 0.7 && roll < 0.78) {
          proxy.outageAt = base + 1 + Math.floor(random() * transactions);
          outageToEnd = random() < 0.5;
        } else if (roll >= 0.78 && roll < 0.86) {
          proxy.finishFault = random() < 0.5 ? "BEFORE_COMMIT" : "AFTER_COMMIT";
        } else if (roll >= 0.86 && roll < 0.9) {
          fullOutage = true;
          stats.faults.FULL_OUTAGE = (stats.faults.FULL_OUTAGE ?? 0) + 1;
          await proxy.stop();
        } else if (roll >= 0.9) {
          storeDownOnly = true;
        }
        // Never on the last window: a block there has no later window to recover in, and
        // "every window is covered by the end" is what proves a blocked one does recover.
        if (mode === "poison" && attempt === 1 && window !== Math.floor(LAST_CLOSE / H)) {
          if (random() < 0.2) {
            proxy.plan.set(base + 1 + Math.floor(random() * transactions), "PERMANENT");
          } else if (random() < 0.05) {
            await observer.$executeRawUnsafe("UPDATE test_flags SET poison_results = true");
          }
        }
      }
      const firedBefore = proxy.fired.length;

      let summary: Awaited<ReturnType<typeof scanner.runScan>> | null = null;
      let outcome: ReturnType<typeof classifyPass>;
      try {
        summary = await scanner.runScan({
          userId,
          timeframes: due.timeframes,
          maxConcurrency: concurrency,
          triggeredBy: "SCHEDULE",
          now,
        });
        outcome = classifyPass(summary);
      } catch (err) {
        outcome = classifyPassError(err, false);
      }
      proxy.finishFault = null;
      proxy.outageAt = null;
      proxy.plan.clear();
      await observer.$executeRawUnsafe("UPDATE test_flags SET poison_results = false");
      for (const f of proxy.fired.slice(firedBefore)) {
        stats.faults[f.mode] = (stats.faults[f.mode] ?? 0) + 1;
      }

      stats.passes += 1;
      stats.outcomes[outcome] = (stats.outcomes[outcome] ?? 0) + 1;
      stats.maxAttemptsPerWindow = Math.max(stats.maxAttemptsPerWindow, attempt);
      if (outcome === "SUCCEEDED") succeededWindows.add(window);
      if (outcome === "FAILED_BLOCKED") {
        blockedInWindow.set(window, (blockedInWindow.get(window) ?? 0) + 1);
        stats.maxBlockedPerWindow = Math.max(
          stats.maxBlockedPerWindow,
          blockedInWindow.get(window)!,
        );
      }

      if (summary) {
        if (summary.unfinishedRunId) unfinished = summary.unfinishedRunId;
        const lostAWrite =
          summary.saveFailure !== null ||
          summary.results.some((r) => r.failure?.category === "DATABASE_ERROR");
        if (lostAWrite && outcome === "SUCCEEDED") stats.succeededWithDatabaseFailure += 1;
        if (lostAWrite && summary.runId) {
          const row = await observer.scannerRun.findUnique({
            where: { id: summary.runId },
            select: { status: true },
          });
          if (row?.status === "COMPLETED" || row?.status === "PARTIAL") {
            stats.storedAsSuccessAfterDatabaseFailure += 1;
          }
        }
        if (summary.status === "FAILED" && summary.events.some((e) => e.eventId)) {
          stats.failedPassesWithCommittedEvents += 1;
        }
        if (summary.status === "FAILED") {
          if (summary.runId) failedAttemptRunIds.add(summary.runId);
          if (summary.unfinishedRunId) failedAttemptRunIds.add(summary.unfinishedRunId);
        }
        if (summary.runId) {
          runsPerWindow.set(window, [...(runsPerWindow.get(window) ?? []), summary.runId]);
        }
      }

      // Delivery. A mid-pass outage may or may not last until the end of the pass.
      const down = fullOutage || outageToEnd || storeDownOnly;
      if (storeDownOnly) await proxy.stop();
      else if (!outageToEnd && !fullOutage) await proxy.start();
      if (summary) await deliver(summary, down);
      await proxy.start();

      const finishedAt = now + 1000;
      state = recordPass(state, {
        timeframes: TFS,
        scanned: due.timeframes,
        decidedAt: now,
        finishedAt,
        outcome,
      });
      vi.setSystemTime(finishedAt);
    }
    stats.windowsLost = attemptsInWindow.size - succeededWindows.size;

    await proxy.start();
    const setups = await observer.trackedSetup.findMany({
      include: {
        events: { orderBy: [{ createdAt: "asc" }, { type: "asc" }] },
        tradingPair: { select: { exchangeSymbol: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const eventKey = new Map<string, string>();
    const eventIdsByKey = new Map<string, string[]>();
    const setupKey = new Map<string, string>();
    const history: Record<string, string[]> = {};
    for (const s of setups) {
      const identity = `${s.tradingPair.exchangeSymbol}|${s.timeframe}`;
      const head = [
        s.entryLow,
        s.entryHigh,
        s.stopLoss,
        s.takeProfit1,
        s.takeProfit2,
        s.takeProfit3,
        s.status,
      ]
        .map(String)
        .join(",");
      setupKey.set(s.id, `${identity} ${head}`);
      (history[identity] ??= []).push(`SETUP ${head}`);
      for (const e of s.events) {
        const key = `${identity} ${head} ${e.type} ${e.fromStatus}>${e.toStatus} ${e.detail}`;
        eventKey.set(e.id, key);
        eventIdsByKey.set(key, [...(eventIdsByKey.get(key) ?? []), e.id]);
        history[identity].push(
          `  EVENT ${e.type} ${e.fromStatus}>${e.toStatus} ${e.detail} ${JSON.stringify(e.payload)}`,
        );
      }
    }

    const notifications = await observer.notification.findMany({
      select: { dedupeKey: true, channel: true, type: true, status: true },
    });
    const UUID = /([0-9a-f]{8}-[0-9a-f-]{27})/;
    const normal = notifications.map((n) => {
      const id = UUID.exec(n.dedupeKey)?.[1];
      if (n.type === "SCAN_REPORT" || n.type === "DAILY_SUMMARY" || n.type === "SYSTEM_ERROR") {
        return `${n.channel} ${n.type} -`;
      }
      if (id && eventKey.has(id)) return `${n.channel} ${n.type} ${eventKey.get(id)}`;
      if (id && setupKey.has(id)) {
        return `${n.channel} ${n.type} ${setupKey.get(id)} ${n.dedupeKey.split(":").slice(2).join(":")}`;
      }
      return `${n.channel} ${n.type} unmatched`;
    });

    const duplicates = await observer.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) n FROM (
        SELECT "userId", channel, "dedupeKey" FROM "Notification" GROUP BY 1, 2, 3 HAVING count(*) > 1
      ) x`;
    const twoOpen = await observer.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) n FROM (
        SELECT "tradingPairId", timeframe FROM "TrackedSetup" WHERE status <> 'INVALIDATED' GROUP BY 1, 2 HAVING count(*) > 1
      ) x`;

    const reportRows = notifications.filter((n) => n.type === "SCAN_REPORT");
    let windowsWithTwoReports = 0;
    for (const ids of runsPerWindow.values()) {
      const keys = new Set(ids.map((id) => `scan-report:${id}`));
      if (reportRows.filter((r) => keys.has(r.dedupeKey)).length > 1) windowsWithTwoReports += 1;
    }

    const attribution: Record<string, ({ storeDown: boolean } | null)[]> = {};
    for (const [key, ids] of eventIdsByKey) {
      attribution[key] = ids.map((id) => named.get(id) ?? null);
    }
    const skippedSetupKeys = [...skippedObservation].map((id) => setupKey.get(id) ?? id);

    const totals = {
      setups: setups.length,
      events: setups.reduce((total, s) => total + s.events.length, 0),
      identitiesWithTwoOpen: Number(twoOpen[0].n),
      duplicateDedupeKeys: Number(duplicates[0].n),
      windowsWithTwoReports,
      reportsOnFailedAttempt: reportRows.filter((r) =>
        failedAttemptRunIds.has(r.dedupeKey.replace(/^scan-report:/, "")),
      ).length,
      runsLeftRunning: await observer.scannerRun.count({ where: { status: "RUNNING" } }),
      uncoveredAtEnd: (state.covered.H1 ?? 0) < LAST_CLOSE,
    };

    await prisma.$disconnect();
    await observer.$disconnect();
    await proxy.stop();
    return { stats, totals, history, normal: normal.sort(), attribution, skippedSetupKeys };
  }

  beforeAll(async () => {
    pg = await startThrowawayPostgres();
    exchange = await startRecordedExchange(FIXTURE, {
      get now() {
        return Date.now();
      },
    });
    network = stubNetwork();
    process.env.BINANCE_API_BASE_URL = `http://127.0.0.1:${exchange.port}`;
    // Not tokens: the stub answers before anything leaves this process.
    process.env.TELEGRAM_BOT_TOKEN = "stub";
    process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN = "stub";

    // Only the date: real timers keep running, so real timeouts still happen.
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
    vi.setSystemTime(FIRST + SETTLE);

    results.control = await replay("control", 1, 20261106);
    results.faulted = await replay("faulted", 4, 20261106);
    results.poison = await replay("poison", 4, 20261107);
  }, 900_000);

  afterAll(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    network?.restore();
    await exchange?.close();
    await pg?.stop();
  });

  it("the control run: every window succeeds, once, and the week actually moved", () => {
    const { stats, totals } = results.control;
    expect(stats.outcomes).toEqual({ SUCCEEDED: STEPS });
    expect(stats.passes).toBe(STEPS);
    expect(stats.faults).toEqual({});
    expect(stats.maxAttemptsPerWindow).toBe(1);
    expect(stats.windowsLost).toBe(0);
    // Enough churn for the comparisons below to mean something. Not a pinned count:
    // the engine's own golden file is what holds its decisions still.
    expect(totals.setups).toBeGreaterThan(50);
    expect(totals.events).toBeGreaterThan(100);
  });

  it.each(["control", "faulted", "poison"] as const)(
    "%s: no database failure is a success, nothing is duplicated, every window is covered",
    (mode) => {
      const { stats, totals } = results[mode];
      expect(stats.succeededWithDatabaseFailure).toBe(0);
      expect(stats.storedAsSuccessAfterDatabaseFailure).toBe(0);
      expect(stats.maxAttemptsPerWindow).toBeLessThanOrEqual(5);
      expect(totals.identitiesWithTwoOpen).toBe(0);
      expect(totals.duplicateDedupeKeys).toBe(0);
      expect(totals.windowsWithTwoReports).toBe(0);
      expect(totals.reportsOnFailedAttempt).toBe(0);
      expect(totals.runsLeftRunning).toBe(0);
      expect(totals.uncoveredAtEnd).toBe(false);
    },
  );

  it("faulted: the faults really happened, on every kind of statement", () => {
    const { stats } = results.faulted;
    expect(Object.keys(stats.faults).sort()).toEqual(
      [
        "AFTER_COMMIT",
        "BEFORE_COMMIT",
        "BODY",
        "FINISH_AFTER_COMMIT",
        "FINISH_BEFORE_COMMIT",
        "FULL_OUTAGE",
        "OUTAGE",
      ].sort(),
    );
    expect(stats.outcomes.FAILED_TRANSIENT).toBeGreaterThan(20);
    expect(stats.outcomes.FAILED_BLOCKED).toBeUndefined();
    expect(stats.failedPassesWithCommittedEvents).toBeGreaterThan(0);
    expect(stats.closedUnfinished).toBeGreaterThan(0);
  });

  it("faulted: every window succeeded, so the stored history is identical to the control's", () => {
    const { stats, history } = results.faulted;
    expect(stats.outcomes.SUCCEEDED).toBe(STEPS);
    expect(stats.windowsLost).toBe(0);
    expect(history).toEqual(results.control.history);
  });

  it("faulted: nothing extra was notified, and every notification lost is one the policy loses", () => {
    const { normal, attribution, skippedSetupKeys } = results.faulted;
    const remaining = new Map<string, number>();
    for (const key of results.control.normal) remaining.set(key, (remaining.get(key) ?? 0) + 1);

    const extra: string[] = [];
    for (const key of normal) {
      const left = remaining.get(key) ?? 0;
      if (left === 0) extra.push(key);
      else remaining.set(key, left - 1);
    }
    // A failed attempt can report on its own window only if it saved; a report is per run,
    // so these compare by count. The scan report and the daily summary have no event.
    expect(extra.filter((k) => !/ (SCAN_REPORT|DAILY_SUMMARY|SYSTEM_ERROR) /.test(k))).toEqual([]);

    const unexplained: string[] = [];
    for (const [key, count] of remaining) {
      if (count === 0) continue;
      const [, type, rest = ""] = key.split(/ (\S+) (.*)/s);
      if (/^(SCAN_REPORT|DAILY_SUMMARY|SYSTEM_ERROR)$/.test(type)) continue;
      if (type.startsWith("CONFIRMATION_") && type !== "CONFIRMATION_DETECTED") {
        if (!skippedSetupKeys.some((s) => rest.startsWith(s))) unexplained.push(key);
        continue;
      }
      const seen = attribution[rest];
      // Never named: the commit landed and its answer was lost. Named, with the store down
      // at delivery. Either is the documented loss; named with the store up is a bug.
      const lost = seen && seen.every((n) => n === null || n.storeDown);
      if (!lost) unexplained.push(key);
    }
    expect(unexplained).toEqual([]);
  });

  it("poison: blocked at most once a window, never retried within it, and it still recovers", () => {
    const { stats } = results.poison;
    expect(stats.outcomes.FAILED_BLOCKED).toBeGreaterThan(0);
    expect(stats.maxBlockedPerWindow).toBe(1);
    expect(stats.outcomes.SUCCEEDED).toBeGreaterThan(STEPS / 2);
    expect(stats.faults.PERMANENT).toBeGreaterThan(0);
  });

  it("no log line carried a password or a connection string, and nothing left this machine", () => {
    expect(logged.filter((line) => LOG_LEAK.test(line))).toEqual([]);
    expect(network.blocked).toEqual([]);
  });
});
