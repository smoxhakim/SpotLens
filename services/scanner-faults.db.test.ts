// @vitest-environment node
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FaultProxy } from "@/lib/test-utils/fault-proxy";
import { startFixtureExchange, stubNetwork } from "@/lib/test-utils/fixture-exchange";
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
 * What a pass is called, and what the lifecycle did, when real connections really fail.
 *
 * The real `runScan`, `classifyPass`, `recordPass` and `trackSetup`, against a real
 * PostgreSQL, through a proxy that cuts connections at a chosen statement. Nothing
 * about the database is mocked, because the whole question is what Prisma and Postgres
 * really do at each of these points.
 *
 * Opt-in: SPOTLENS_FAULT_TESTS=1, Docker and a local postgres:16-alpine. It starts its
 * own server and takes no database URL. About two minutes: a few cases wait out real
 * lock and idle timeouts. See `lib/test-utils/throwaway-postgres.ts`.
 */

const H = 3_600_000;
const SETTLE = 90_000;
const BULL = pullbackIntoSupport();
const OK = { H1: BULL, H4: BULL };
const QUIET = { H1: downtrend(), H4: downtrend() };
type Series = typeof OK | typeof QUIET | { status: number };

describe.skipIf(!FAULT_TESTS_ENABLED)("a pass and the lifecycle under real faults", () => {
  let pg: ThrowawayPostgres;
  let observer: PrismaClient;
  let proxy: FaultProxy;
  let exchange: Awaited<ReturnType<typeof startFixtureExchange>>;
  let network: ReturnType<typeof stubNetwork>;
  let scanner: typeof import("@/services/scanner");
  let setups: typeof import("@/services/setups");
  let retry: typeof import("@/lib/scanner/retry");
  let schedule: typeof import("@/lib/scanner/schedule");
  let userId: string;
  const logged: string[] = [];

  const setClock = async (ms: number) => {
    vi.setSystemTime(ms);
    await observer.$executeRawUnsafe(
      `UPDATE test_clock SET at = '${new Date(ms).toISOString()}'::timestamp`,
    );
  };

  let marketNumber = 0;
  const market = async (series: Series) => {
    marketNumber += 1;
    const symbol = `M${marketNumber}USDT`;
    const pair = await observer.tradingPair.create({
      data: {
        quoteCurrency: "USDT",
        exchangeSymbol: symbol,
        asset: {
          create: {
            symbol: `M${marketNumber}`,
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
    exchange.series.set(symbol, series as never);
    return { pairId: pair.id, exchangeSymbol: symbol, label: symbol } as never as {
      pairId: string;
      exchangeSymbol: string;
    };
  };

  beforeAll(async () => {
    pg = await startThrowawayPostgres();
    const direct = await pg.createDatabase("faults_test", { faultFixtures: true });
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
      "faults_test",
      "sslmode=disable&statement_cache_size=0&connection_limit=4&connect_timeout=3&pool_timeout=5",
    );
    process.env.DIRECT_URL = direct;
    process.env.BINANCE_API_BASE_URL = `http://127.0.0.1:${exchange.port}`;

    observer = new PrismaClient({ datasourceUrl: direct, log: [] });
    userId = (await observer.user.create({ data: { email: "faults@example.test" } })).id;

    // Only the date: real timers keep running, so real timeouts still happen.
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }

    scanner = await import("@/services/scanner");
    setups = await import("@/services/setups");
    retry = await import("@/lib/scanner/retry");
    schedule = await import("@/lib/scanner/schedule");
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

  // --- the precedence, row by row -------------------------------------------

  interface Row {
    memoryStatus: string | null;
    storedStatus: string;
    outcome: string;
    threw?: string[];
    covered: boolean;
    retryIn: number | null;
    nextWindow: boolean;
    countsAsSuccess: boolean;
    dbFailures: string[];
    otherFailures: string[];
    ok: number | null;
    untracked?: string[];
  }

  let at = Date.UTC(2026, 0, 5, 12);

  const runRow = async (
    markets: { pairId: string }[],
    apply: (base: number) => Promise<unknown> | void,
    opts: { interrupted?: boolean } = {},
  ) => {
    at += 10 * H;
    await setClock(at + SETTLE);
    const before = schedule.scannedThroughAt(["H1"], at + SETTLE - H);
    const base = proxy.lifecycleCount;
    await apply(base);
    const firedBefore = proxy.fired.length;
    const controller = new AbortController();
    if (opts.interrupted) controller.abort();

    let summary: Awaited<ReturnType<typeof scanner.runScan>> | null = null;
    let outcome: ReturnType<typeof retry.classifyPass>;
    let threw: string | null = null;
    try {
      summary = await scanner.runScan({
        userId,
        timeframes: ["H1"],
        markets: markets as never[],
        maxConcurrency: 1,
        triggeredBy: "SCHEDULE",
        now: Date.now(),
        signal: controller.signal,
      });
      outcome = retry.classifyPass(summary);
    } catch (e) {
      threw = (e as { code?: string }).code ?? (e as Error).name;
      outcome = retry.classifyPassError(e, false);
    }
    const fired = proxy.fired.slice(firedBefore).length;
    proxy.finishFault = null;
    proxy.plan.clear();
    await observer.$executeRawUnsafe("UPDATE test_flags SET poison_results = false");
    await proxy.start();

    const state = retry.recordPass(
      { covered: before, retry: null, notBefore: null },
      {
        timeframes: ["H1"],
        scanned: ["H1"],
        decidedAt: Date.now(),
        finishedAt: Date.now() + 1000,
        outcome,
      },
    );
    const id = summary?.runId ?? summary?.unfinishedRunId;
    const stored = id
      ? await observer.scannerRun.findUnique({ where: { id }, select: { status: true } })
      : null;
    const lastSuccess = await scanner.lastSuccessfulPassStartedAt();
    if (summary?.unfinishedRunId) await scanner.closeUnfinishedRun(summary.unfinishedRunId);

    const results = summary?.results ?? [];
    return {
      fired,
      threw,
      row: {
        memoryStatus: summary?.status ?? null,
        storedStatus: stored?.status ?? "none",
        outcome,
        covered: state.covered.H1! > before.H1!,
        retryIn: state.retry ? Math.round((state.retry.at - Date.now() - 1000) / 1000) : null,
        nextWindow: state.notBefore !== null,
        countsAsSuccess: lastSuccess?.getTime() === at + SETTLE,
        dbFailures: results
          .filter((r) => r.failure?.category === "DATABASE_ERROR")
          .map((r) => r.failure!.message),
        otherFailures: results
          .filter((r) => r.failure && r.failure.category !== "DATABASE_ERROR")
          .map((r) => `${r.failure!.category}:${r.failure!.retryable}`),
        ok: summary?.succeeded ?? null,
      } satisfies Row,
    };
  };

  const SUCCESS = {
    outcome: "SUCCEEDED",
    covered: true,
    retryIn: null,
    nextWindow: false,
    countsAsSuccess: true,
    dbFailures: [],
    otherFailures: [],
  };
  const RETRY = { covered: false, retryIn: 60, nextWindow: false, countsAsSuccess: false };
  const BLOCKED = {
    outcome: "FAILED_BLOCKED",
    covered: false,
    retryIn: null,
    nextWindow: true,
    countsAsSuccess: false,
  };

  it("no failures: COMPLETED, covered, a success", async () => {
    const { row } = await runRow([await market(OK), await market(OK)], () => undefined);
    expect(row).toEqual({
      ...SUCCESS,
      memoryStatus: "COMPLETED",
      storedStatus: "COMPLETED",
      ok: 2,
    });
  }, 30_000);

  it("the engine offering no setup on any market is not a failure", async () => {
    const { row } = await runRow([await market(QUIET)], () => undefined);
    expect(row).toEqual({
      ...SUCCESS,
      memoryStatus: "COMPLETED",
      storedStatus: "COMPLETED",
      ok: 1,
    });
  }, 30_000);

  it("an unchanged setup is not a failure: a write decided against is not a write lost", async () => {
    const same = await market(OK);
    await runRow([same], () => undefined);
    const { row } = await runRow([same], () => undefined);
    expect(row).toEqual({
      ...SUCCESS,
      memoryStatus: "COMPLETED",
      storedStatus: "COMPLETED",
      ok: 1,
    });
  }, 30_000);

  it("exchange: one market 500, others fine: PARTIAL, a success", async () => {
    const { row } = await runRow(
      [await market(OK), await market({ status: 500 })],
      () => undefined,
    );
    expect(row).toEqual({
      ...SUCCESS,
      memoryStatus: "PARTIAL",
      storedStatus: "PARTIAL",
      otherFailures: ["MARKET_DATA_ERROR:true"],
      ok: 1,
    });
  }, 30_000);

  it("exchange: every market 500: transient, retried", async () => {
    const { row } = await runRow(
      [await market({ status: 500 }), await market({ status: 500 })],
      () => undefined,
    );
    expect(row).toEqual({
      ...RETRY,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      outcome: "FAILED_TRANSIENT",
      dbFailures: [],
      otherFailures: ["MARKET_DATA_ERROR:true", "MARKET_DATA_ERROR:true"],
      ok: 0,
    });
  }, 30_000);

  it("exchange: every symbol refused: permanent, covered, the schedule moves on", async () => {
    const { row } = await runRow(
      [await market({ status: 400 }), await market({ status: 400 })],
      () => undefined,
    );
    expect(row).toEqual({
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      outcome: "FAILED_PERMANENT",
      covered: true,
      retryIn: null,
      nextWindow: false,
      countsAsSuccess: false,
      dbFailures: [],
      otherFailures: ["INVALID_DATA:false", "INVALID_DATA:false"],
      ok: 0,
    });
  }, 30_000);

  it("transient database failure on one market, the others committed: never a success", async () => {
    const { row, fired } = await runRow(
      [await market(OK), await market(OK), await market(OK)],
      (base) => void proxy.plan.set(base + 2, "BODY"),
    );
    expect(fired).toBe(1);
    expect(row).toEqual({
      ...RETRY,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      outcome: "FAILED_TRANSIENT",
      dbFailures: ["Database error P1017"],
      otherFailures: [],
      ok: 2,
    });
  }, 30_000);

  it("permanent database failure on one market, the others committed: blocked", async () => {
    const { row, fired } = await runRow(
      [await market(OK), await market(OK), await market(OK)],
      (base) => void proxy.plan.set(base + 2, "PERMANENT"),
    );
    expect(fired).toBe(1);
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      dbFailures: ["Database error 42P01"],
      otherFailures: [],
      ok: 2,
    });
  }, 30_000);

  it("permanent database failure on every market: blocked", async () => {
    const { row, fired } = await runRow([await market(OK), await market(OK)], (base) => {
      proxy.plan.set(base + 1, "PERMANENT");
      proxy.plan.set(base + 2, "PERMANENT");
    });
    expect(fired).toBe(2);
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      dbFailures: ["Database error 42P01", "Database error 42P01"],
      otherFailures: [],
      ok: 0,
    });
  }, 30_000);

  it("transient and permanent together: permanent outranks", async () => {
    const { row } = await runRow([await market(OK), await market(OK), await market(OK)], (base) => {
      proxy.plan.set(base + 1, "BODY");
      proxy.plan.set(base + 2, "PERMANENT");
    });
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      dbFailures: ["Database error P1017", "Database error 42P01"],
      otherFailures: [],
      ok: 1,
    });
  }, 30_000);

  it("exchange 500 and a transient database failure: transient", async () => {
    const { row } = await runRow(
      [await market(OK), await market({ status: 500 })],
      (base) => void proxy.plan.set(base + 1, "BODY"),
    );
    expect(row).toEqual({
      ...RETRY,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      outcome: "FAILED_TRANSIENT",
      dbFailures: ["Database error P1017"],
      otherFailures: ["MARKET_DATA_ERROR:true"],
      ok: 0,
    });
  }, 30_000);

  it("exchange 500 and a permanent database failure: blocked, however retryable the exchange", async () => {
    const { row } = await runRow(
      [await market(OK), await market({ status: 500 })],
      (base) => void proxy.plan.set(base + 1, "PERMANENT"),
    );
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      dbFailures: ["Database error 42P01"],
      otherFailures: ["MARKET_DATA_ERROR:true"],
      ok: 0,
    });
  }, 30_000);

  it("results save cut: transient, the run left for this process to close", async () => {
    const { row, fired } = await runRow([await market(OK)], () => {
      proxy.finishFault = "BEFORE_COMMIT";
    });
    expect(fired).toBe(1);
    expect(row).toEqual({
      ...RETRY,
      memoryStatus: "FAILED",
      storedStatus: "RUNNING",
      outcome: "FAILED_TRANSIENT",
      dbFailures: [],
      otherFailures: [],
      ok: 1,
    });
  }, 30_000);

  it("results save landed but its answer was lost: retried, and the store is what is true", async () => {
    const { row, fired } = await runRow([await market(OK)], () => {
      proxy.finishFault = "AFTER_COMMIT";
    });
    expect(fired).toBe(1);
    expect(row).toEqual({
      ...RETRY,
      memoryStatus: "FAILED",
      storedStatus: "COMPLETED",
      outcome: "FAILED_TRANSIENT",
      countsAsSuccess: true,
      dbFailures: [],
      otherFailures: [],
      ok: 1,
    });
  }, 30_000);

  it("results save refused: blocked", async () => {
    const { row } = await runRow([await market(OK)], () =>
      observer.$executeRawUnsafe("UPDATE test_flags SET poison_results = true"),
    );
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "RUNNING",
      dbFailures: [],
      otherFailures: [],
      ok: 1,
    });
  }, 30_000);

  it("results save refused and a lifecycle write cut: permanent outranks", async () => {
    const markets = [await market(OK), await market(OK)];
    const { row } = await runRow(markets, async (base) => {
      proxy.plan.set(base + 1, "BODY");
      await observer.$executeRawUnsafe("UPDATE test_flags SET poison_results = true");
    });
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "RUNNING",
      dbFailures: ["Database error P1017"],
      otherFailures: [],
      ok: 1,
    });
  }, 30_000);

  it("a real foreign key refusal: P2003, blocked", async () => {
    const real = await market(OK);
    const { row } = await runRow(
      [{ ...real, pairId: "00000000-0000-0000-0000-000000000000" }],
      () => undefined,
    );
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "RUNNING",
      dbFailures: ["Database error P2003"],
      otherFailures: [],
      ok: 0,
    });
  }, 30_000);

  it("zero markets: FAILED, blocked, stored, and not a success", async () => {
    const { row } = await runRow([], () => undefined);
    expect(row).toEqual({
      ...BLOCKED,
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      dbFailures: [],
      otherFailures: [],
      ok: 0,
    });
  }, 30_000);

  it("database unreachable before the pass: it throws, transient, retried", async () => {
    const { row, threw } = await runRow([await market(OK)], () => proxy.stop());
    expect(["P1001", "P1017"]).toContain(threw);
    expect(row).toEqual({
      ...RETRY,
      memoryStatus: null,
      storedStatus: "none",
      outcome: "FAILED_TRANSIENT",
      dbFailures: [],
      otherFailures: [],
      ok: null,
    });
  }, 30_000);

  it("a deliberate stop outranks everything", async () => {
    const { row } = await runRow(
      [await market(OK)],
      (base) => void proxy.plan.set(base + 1, "PERMANENT"),
      { interrupted: true },
    );
    expect(row).toEqual({
      memoryStatus: "FAILED",
      storedStatus: "FAILED",
      outcome: "INTERRUPTED",
      covered: false,
      retryIn: null,
      nextWindow: false,
      countsAsSuccess: false,
      dbFailures: [],
      otherFailures: ["UNKNOWN:false"],
      ok: 0,
    });
  }, 30_000);

  // --- one market refused, hour after hour ------------------------------------

  it("a real check constraint: blocked once a window until it is fixed, H4 still due, no newer read vouched for", async () => {
    const good = await market(OK);
    const poison = await market(OK);
    const pass0 = Date.UTC(2026, 2, 2, 12);
    await setClock(pass0 + SETTLE);
    await scanner.runScan({
      userId,
      timeframes: ["H1"],
      markets: [good] as never[],
      maxConcurrency: 1,
      triggeredBy: "SCHEDULE",
      now: Date.now(),
    });
    const successAt = (await scanner.lastSuccessfulPassStartedAt())?.toISOString();
    await observer.$executeRawUnsafe(
      `ALTER TABLE "TrackedSetup" ADD CONSTRAINT test_poison CHECK ("tradingPairId" <> '${poison.pairId}') NOT VALID`,
    );

    const TF: ("H1" | "H4")[] = ["H1", "H4"];
    let state = retry.startSchedule({ timeframes: TF, now: pass0 + SETTLE });
    const passes: unknown[] = [];
    for (let i = 0; i < 6; i += 1) {
      if (i === 3) {
        await observer.$executeRawUnsafe('ALTER TABLE "TrackedSetup" DROP CONSTRAINT test_poison');
      }
      const wake = retry.nextWake({ state, timeframes: TF });
      await setClock(wake.at);
      const due = schedule.scanOnWake({
        timeframes: TF,
        scannedThrough: state.covered,
        plannedAt: wake.at,
        now: wake.at,
      });
      const summary = await scanner.runScan({
        userId,
        timeframes: due.timeframes,
        markets: [good, poison] as never[],
        maxConcurrency: 1,
        triggeredBy: "SCHEDULE",
        now: wake.at,
      });
      const outcome = retry.classifyPass(summary);
      state = retry.recordPass(state, {
        timeframes: TF,
        scanned: due.timeframes,
        decidedAt: wake.at,
        finishedAt: wake.at + 1000,
        outcome,
      });
      const shortlist = await scanner.getShortlist({ now: wake.at });
      // What the freshness rule reads. While blocked, the last good read stands and no
      // newer one appears, so setups go stale by themselves rather than look re-confirmed.
      const okResults = summary.results.filter((r) => r.ok);
      const reads = await setups.lastScanReads(okResults.map((r) => r.setupId!));
      const newest = Math.max(...okResults.map((r) => r.analysedAtCandle!));
      const readAdvanced = [...reads.values()].some((read) => read.analysedAtCandle === newest);
      const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 19);
      passes.push({
        at: hhmm(wake.at),
        timeframes: due.timeframes.join("+"),
        status: summary.status,
        outcome,
        codes: [
          ...new Set(summary.results.filter((r) => r.failure).map((r) => r.failure!.message)),
        ],
        ok: summary.results.filter((r) => r.ok).length,
        failed: summary.failed,
        retry: state.retry !== null,
        notBefore: state.notBefore ? hhmm(state.notBefore) : null,
        shortlistIsThisPass: shortlist?.run.id === summary.runId,
        lastSuccessUnchanged:
          (await scanner.lastSuccessfulPassStartedAt())?.toISOString() === successAt,
        readAdvanced,
      });
    }

    const blocked = (at: string, notBefore: string) => ({
      at,
      timeframes: "H1",
      status: "FAILED",
      outcome: "FAILED_BLOCKED",
      // A check constraint on a model insert: Prisma gives it no code at all.
      codes: ["Database error PrismaClientUnknownRequestError"],
      ok: 1,
      failed: 1,
      retry: false,
      notBefore,
      shortlistIsThisPass: false,
      lastSuccessUnchanged: true,
      readAdvanced: false,
    });
    const healthy = (at: string, timeframes: string, ok: number) => ({
      at,
      timeframes,
      status: "COMPLETED",
      outcome: "SUCCEEDED",
      codes: [],
      ok,
      failed: 0,
      retry: false,
      notBefore: null,
      shortlistIsThisPass: true,
      lastSuccessUnchanged: false,
      readAdvanced: true,
    });
    expect(passes).toEqual([
      blocked("13:01:30", "14:01:30"),
      blocked("14:01:30", "15:01:30"),
      blocked("15:01:30", "16:01:30"),
      healthy("16:01:30", "H1+H4", 4),
      healthy("17:01:30", "H1", 2),
      healthy("18:01:30", "H1", 2),
    ]);
  }, 60_000);

  // --- the lifecycle at each point a commit can go wrong ------------------------

  const T = Date.UTC(2026, 5, 1, 12);
  const endingAt = <C extends { openTime: number; closeTime: number }>(
    candles: C[],
    lastOpen: number,
  ) => {
    const shift = lastOpen - candles.at(-1)!.openTime;
    return candles.map((c) => ({
      ...c,
      openTime: c.openTime + shift,
      closeTime: c.closeTime + shift,
    }));
  };

  async function analysis(
    candles: ReturnType<typeof pullbackIntoSupport>,
    lastOpen: number,
    higher = pullbackIntoSupport(),
  ) {
    const { analyzeMultiTimeframe, runAnalysis } = await import("@/lib/analysis");
    const lower = endingAt(candles, lastOpen);
    return runAnalysis(lower, {
      mtf: analyzeMultiTimeframe({
        lowerCandles: lower,
        higherCandles: higher,
        lowerTimeframe: "H1",
        higherTimeframe: "H4",
      }),
    });
  }
  const bullish = (at: number) => analysis(pullbackIntoSupport(), at);
  const elsewhere = (at: number) => analysis(extendedAboveSupport(), at);
  const noSetup = (at: number) => analysis(downtrend(), at, downtrend());
  type Result = Awaited<ReturnType<typeof bullish>>;

  const track = async (pair: { pairId: string }, result: Result) => {
    await observer.$executeRawUnsafe(
      `UPDATE test_clock SET at = '${new Date(Date.now()).toISOString()}'::timestamp`,
    );
    return setups.trackSetup({ userId, tradingPairId: pair.pairId, timeframe: "H1", result });
  };
  const brief = (o: Awaited<ReturnType<typeof track>>) => ({
    action: o.action,
    cause: o.cause,
    events: o.events.length,
    tracked: o.setupId !== null,
    failure: o.failure?.kind ?? null,
  });
  const counts = async (pair: { pairId: string }) => {
    const rows = await observer.trackedSetup.findMany({
      where: { tradingPairId: pair.pairId },
      include: { events: { select: { id: true } } },
    });
    return {
      setups: rows.length,
      open: rows.filter((s) => s.status !== "INVALIDATED").length,
      events: rows.reduce((total, s) => total + s.events.length, 0),
    };
  };
  const quietMarket = () => market({ status: 500 });
  const FIRST = T + H + SETTLE;
  const SECOND = T + 2 * H + SETTLE;
  const NOTHING = { action: "NONE", cause: null, events: 0, tracked: false };
  const UNCHANGED = { action: "NONE", cause: "UNCHANGED", events: 0, tracked: true, failure: null };

  it.each([
    ["BODY", "NOT_WRITTEN", { setups: 0, open: 0, events: 0 }],
    ["BEFORE_COMMIT", "UNCERTAIN", { setups: 0, open: 0, events: 0 }],
  ] as const)(
    "a first write cut at %s: nothing stored, and the retry creates it",
    async (mode, kind, stored) => {
      const pair = await quietMarket();
      await setClock(SECOND);
      const result = await bullish(T + H);
      proxy.planNext(mode);

      expect(brief(await track(pair, result))).toEqual({ ...NOTHING, failure: kind });
      expect(await counts(pair)).toEqual(stored);
      expect(brief(await track(pair, result))).toEqual({
        action: "CREATE",
        cause: null,
        events: 1,
        tracked: true,
        failure: null,
      });
      expect(brief(await track(pair, result))).toEqual(UNCHANGED);
      expect(await counts(pair)).toEqual({ setups: 1, open: 1, events: 1 });
      expect(proxy.fired.at(-1)?.mode).toBe(mode);
    },
    30_000,
  );

  it.each([
    ["CREATE", null, { setups: 1, open: 1, events: 1 }, UNCHANGED],
    ["REPLACE", "elsewhere", { setups: 2, open: 1, events: 3 }, UNCHANGED],
    [
      "INVALIDATE",
      "noSetup",
      { setups: 1, open: 0, events: 2 },
      { action: "NONE", cause: "NO_SETUP", events: 0, tracked: false, failure: null },
    ],
  ] as const)(
    "%s, commit landed and its answer lost: stored, and the repeats change nothing",
    async (_name, next, stored, repeat) => {
      const pair = await quietMarket();
      if (next) {
        await setClock(FIRST);
        await track(pair, await bullish(T));
      }
      await setClock(SECOND);
      const result = await (next === null
        ? bullish(T + H)
        : next === "elsewhere"
          ? elsewhere(T + H)
          : noSetup(T + H));
      proxy.planNext("AFTER_COMMIT");

      // The event committed and nothing names it, so its notification is lost: accepted.
      expect(brief(await track(pair, result))).toEqual({ ...NOTHING, failure: "UNCERTAIN" });
      expect(await counts(pair)).toEqual(stored);
      await setClock(SECOND + 60_000);
      expect(brief(await track(pair, result))).toEqual(repeat);
      await setClock(SECOND + 180_000);
      expect(brief(await track(pair, result))).toEqual(repeat);
      expect(await counts(pair)).toEqual(stored);
    },
    30_000,
  );

  it.each([
    [
      "REPLACE",
      "elsewhere",
      { setups: 1, open: 1, events: 1 },
      "REPLACE",
      2,
      { setups: 2, open: 1, events: 3 },
    ],
    [
      "INVALIDATE",
      "noSetup",
      { setups: 1, open: 1, events: 1 },
      "TRANSITION",
      1,
      { setups: 1, open: 0, events: 2 },
    ],
  ] as const)(
    "%s cut before its commit: the old setup is untouched, and the retry does it once",
    async (_name, next, stored, action, events, final) => {
      const pair = await quietMarket();
      await setClock(FIRST);
      await track(pair, await bullish(T));
      await setClock(SECOND);
      const result = await (next === "elsewhere" ? elsewhere(T + H) : noSetup(T + H));
      proxy.planNext("BEFORE_COMMIT");

      expect(brief(await track(pair, result))).toEqual({ ...NOTHING, failure: "UNCERTAIN" });
      expect(await counts(pair)).toEqual(stored);
      const retried = await track(pair, result);
      expect(retried.action).toBe(action);
      expect(retried.events).toHaveLength(events);
      expect(await counts(pair)).toEqual(final);
    },
    30_000,
  );

  it("a commit that lands 3 s late: the retry waits on the lock, then sees it and writes nothing", async () => {
    const pair = await quietMarket();
    await setClock(SECOND);
    const result = await bullish(T + H);
    proxy.holdMs = 3000;
    proxy.planNext("HOLD_COMMIT");

    const started = performance.now();
    expect(brief(await track(pair, result))).toEqual({ ...NOTHING, failure: "UNCERTAIN" });
    expect(brief(await track(pair, result))).toEqual(UNCHANGED);
    expect(performance.now() - started).toBeGreaterThan(2000);
    expect(await counts(pair)).toEqual({ setups: 1, open: 1, events: 1 });
  }, 30_000);

  it("a commit that lands 15 s late: the retry gives up on the lock, and the next one sees it", async () => {
    const pair = await quietMarket();
    await setClock(SECOND);
    const result = await bullish(T + H);
    proxy.holdMs = 15_000;
    proxy.planNext("HOLD_COMMIT");

    const started = performance.now();
    expect(brief(await track(pair, result))).toEqual({ ...NOTHING, failure: "UNCERTAIN" });
    const early = await track(pair, result);
    expect(brief(early)).toEqual({ ...NOTHING, failure: "RETRY" });
    expect(early.failure?.code).toBe("55P03");
    expect(early.failure?.class).toBe("TRANSIENT");
    expect(await counts(pair)).toEqual({ setups: 0, open: 0, events: 0 });

    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 16_500 - (performance.now() - started))),
    );
    expect(brief(await track(pair, result))).toEqual(UNCHANGED);
    expect(await counts(pair)).toEqual({ setups: 1, open: 1, events: 1 });
  }, 40_000);

  it("a client that vanished with its transaction open: the server ends it, and the retry creates", async () => {
    const pair = await quietMarket();
    await setClock(SECOND);
    const result = await bullish(T + H);
    proxy.planNext("BLACKHOLE");

    const started = performance.now();
    expect(brief(await track(pair, result))).toEqual({ ...NOTHING, failure: "UNCERTAIN" });
    const early = await track(pair, result);
    expect(early.failure?.code).toBe("55P03");
    expect(await counts(pair)).toEqual({ setups: 0, open: 0, events: 0 });

    const idle = () =>
      observer.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) n FROM pg_stat_activity WHERE datname = 'faults_test' AND state = 'idle in transaction'`;
    expect(Number((await idle())[0].n)).toBeGreaterThan(0);
    while (Number((await idle())[0].n) > 0 && performance.now() - started < 62_000) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(Number((await idle())[0].n)).toBe(0);

    expect(brief(await track(pair, result))).toEqual({
      action: "CREATE",
      cause: null,
      events: 1,
      tracked: true,
      failure: null,
    });
    expect(await counts(pair)).toEqual({ setups: 1, open: 1, events: 1 });
  }, 90_000);

  // --- a commit that worked, then delivery -------------------------------------

  const notifyLike = async (outcome: Awaited<ReturnType<typeof track>>) => {
    const { eventsForOutcome } = await import("@/lib/scanner/events");
    const { eventsFromScan } = await import("@/services/notification-events");
    const { deliverEvents } = await import("@/services/notifications");
    return deliverEvents(
      await eventsFromScan({
        userId,
        scannerEvents: eventsForOutcome({ outcome, symbol: "X", timeframe: "H1", detail: "d" }),
      }),
    );
  };

  it("the store down at delivery: the event is committed, its notification lost, and a retry cannot recover it", async () => {
    const pair = await quietMarket();
    await setClock(SECOND);
    const result = await bullish(T + H);
    const first = await track(pair, result);
    expect(first.action).toBe("CREATE");

    await proxy.stop();
    await expect(notifyLike(first)).rejects.toMatchObject({
      name: "PrismaClientKnownRequestError",
    });
    await proxy.start();

    const retried = await track(pair, result);
    expect(brief(retried)).toEqual(UNCHANGED);
    expect((await notifyLike(retried)).created).toBe(0);
    expect(await counts(pair)).toEqual({ setups: 1, open: 1, events: 1 });
  }, 30_000);

  it("the same event delivered twice: the unique index keeps it to one", async () => {
    const pair = await quietMarket();
    await setClock(SECOND);
    const first = await track(pair, await bullish(T + H));

    expect((await notifyLike(first)).created).toBeGreaterThan(0);
    const again = await notifyLike(first);
    expect(again.created).toBe(0);
    expect(again.duplicates).toBeGreaterThan(0);
  }, 30_000);

  // --- RUNNING rows ------------------------------------------------------------

  it("a stuck RUNNING row, a run beside it, the sweep, and a close that cannot overwrite a save", async () => {
    const base = Date.UTC(2026, 7, 1, 12);
    await setClock(base);
    const row = (over: object) =>
      observer.scannerRun.create({
        data: { timeframes: ["H1"], marketCount: 1, triggeredBy: "SCHEDULE", ...over },
      });
    const stamp = async (id: string, startedAt: number) =>
      observer.$executeRawUnsafe(
        `UPDATE "ScannerRun" SET "startedAt" = '${new Date(startedAt).toISOString()}'::timestamp WHERE id = '${id}'`,
      );

    const done = await row({ status: "COMPLETED", completedAt: new Date(base - 2 * H + 60_000) });
    await stamp(done.id, base - 2 * H);
    const stuck = await row({ status: "RUNNING" });
    await stamp(stuck.id, base - 60_000);

    const fresh = await scanner.getShortlist({ now: base });
    expect(fresh?.run.id).toBe(done.id);
    expect(Boolean(fresh?.passInProgress)).toBe(true);

    const old = await scanner.getShortlist({ now: base + scanner.PASS_IN_PROGRESS_MAX_AGE_MS + 1 });
    expect(old?.run.id).toBe(done.id);
    expect(Boolean(old?.passInProgress)).toBe(false);

    // Younger than the sweep's age, so nothing is closed: it may be someone's live pass.
    expect(await scanner.closeAbandonedRuns(base + scanner.ABANDONED_RUN_AFTER_MS - 120_000)).toBe(
      0,
    );
    expect((await scanner.lastSuccessfulPassStartedAt())?.getTime()).toBe(base - 2 * H);

    const beside = await row({ status: "RUNNING" });
    await stamp(beside.id, base);
    expect(await observer.scannerRun.count({ where: { status: "RUNNING" } })).toBe(2);
    await observer.scannerRun.update({
      where: { id: beside.id },
      data: { status: "COMPLETED", completedAt: new Date(base + 30_000) },
    });
    const after = await scanner.getShortlist({ now: base + 60_000 });
    expect(after?.run.id).toBe(beside.id);
    expect(Boolean(after?.passInProgress)).toBe(false);

    // Closing a run whose save did land moves nothing.
    expect(await scanner.closeUnfinishedRun(beside.id)).toBe("ALREADY_FINAL");
    expect(
      (await observer.scannerRun.findUnique({ where: { id: beside.id }, select: { status: true } }))
        ?.status,
    ).toBe("COMPLETED");

    // A run this process could not finish closes as FAILED, and only once.
    const mine = await row({ status: "RUNNING" });
    await stamp(mine.id, base + 100);
    expect(await scanner.closeUnfinishedRun(mine.id)).toBe("CLOSED");
    expect(await scanner.closeUnfinishedRun(mine.id)).toBe("ALREADY_FINAL");

    expect(await scanner.closeAbandonedRuns(base + scanner.ABANDONED_RUN_AFTER_MS + 1000)).toBe(1);
    expect(
      (await observer.scannerRun.findUnique({ where: { id: stuck.id }, select: { status: true } }))
        ?.status,
    ).toBe("FAILED");
  }, 30_000);

  // --- what everything above said on the way ------------------------------------

  it("no log line carried a password or a connection string, and nothing left this machine", () => {
    expect(logged.filter((line) => /postgres(ql)?:\/\/|throwaway:throwaway/.test(line))).toEqual(
      [],
    );
    expect(network.blocked).toEqual([]);
    expect(network.sends).toEqual([]);
  });
});
