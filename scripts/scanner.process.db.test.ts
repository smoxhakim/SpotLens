// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { FaultProxy } from "@/lib/test-utils/fault-proxy";
import { startFixtureExchange } from "@/lib/test-utils/fixture-exchange";
import { hermeticEnv } from "@/lib/test-utils/hermetic-env";
import { downtrend, pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import {
  FAULT_TESTS_ENABLED,
  registerCleanup,
  startThrowawayPostgres,
  throwawayDir,
  type ThrowawayPostgres,
} from "@/lib/test-utils/throwaway-postgres";

await vi.hoisted(async () => {
  const { applyHermeticEnv } = await import("@/lib/test-utils/hermetic-env");
  applyHermeticEnv({});
});

/**
 * The real scripts/scanner.ts as a real process, against a throwaway PostgreSQL this
 * file started, a fixture exchange on this machine, and real connection faults. Each
 * case has the exit code the operator would see, and what the run rows then say.
 *
 * Opt-in: SPOTLENS_FAULT_TESTS=1, Docker and a local postgres:16-alpine. No database
 * URL can be given to it. About 85 seconds, 60 of them the real one-minute retry. The
 * no-database case needs none of this and is in `scanner.process.test.ts`.
 */

const GUARD = "lib/test-utils/network-guard.mjs";
const VIA_PROXY =
  "sslmode=disable&statement_cache_size=0&connection_limit=4&connect_timeout=2&pool_timeout=4";
const LEAK = /postgres(ql)?:\/\/|throwaway:throwaway/;

interface Case {
  name: string;
  series: Record<string, unknown>;
  prepare?: (db: PrismaClient, pairs: Record<string, string>) => Promise<void>;
  plan?: (proxy: FaultProxy) => void;
  stopProxyOn?: RegExp;
  stranger?: boolean;
  /** The outage outlasts the process, so nothing can close its row: the 3 h sweep will. */
  leavesOwnRunRunning?: boolean;
  exit: number;
  summary?: RegExp[];
}

const bull = pullbackIntoSupport();
const ok = { H1: bull, H4: bull };
const quiet = { H1: downtrend(), H4: downtrend() };

const CASES: Case[] = [
  { name: "all markets OK", series: { A1USDT: ok, B1USDT: ok }, exit: 0 },
  { name: "analysed, no setups", series: { A2USDT: quiet }, exit: 0 },
  {
    name: "exchange fails on one market (PARTIAL)",
    series: { A3USDT: ok, B3USDT: { status: 500 } },
    exit: 0,
  },
  {
    name: "exchange fails on every market, retryable",
    series: { A4USDT: { status: 500 }, B4USDT: { status: 500 } },
    exit: 1,
    summary: [/^PASS FAILED, TRANSIENT/m],
  },
  {
    name: "exchange refuses every symbol",
    series: { A5USDT: { status: 400 }, B5USDT: { status: 400 } },
    exit: 1,
    summary: [/^PASS FAILED/m],
  },
  {
    name: "permanent failure on one market (real check constraint)",
    series: { A6USDT: ok, B6USDT: ok },
    prepare: async (db, pairs) => {
      await db.$executeRawUnsafe(
        `ALTER TABLE "TrackedSetup" ADD CONSTRAINT test_poison CHECK ("tradingPairId" <> '${pairs.B6USDT}') NOT VALID`,
      );
    },
    exit: 1,
    summary: [
      /^PASS BLOCKED: H1: 1 succeeded, 1 failed, of 2\./m,
      /DATABASE_ERROR .* permanent: B6USDT/,
      /will not retry/,
    ],
  },
  {
    name: "transient failure on one market (connection cut)",
    series: { A7USDT: ok, B7USDT: ok },
    plan: (p) => void p.plan.set(2, "BODY"),
    exit: 1,
    summary: [/^PASS FAILED, TRANSIENT/m, /transient: B7USDT/],
  },
  {
    name: "commit landed, confirmation lost",
    series: { A8USDT: ok, B8USDT: ok },
    plan: (p) => void p.plan.set(2, "AFTER_COMMIT"),
    exit: 1,
  },
  {
    name: "results save refused, another process's RUNNING row present",
    series: { A9USDT: ok },
    stranger: true,
    prepare: async (db) => {
      await db.$executeRawUnsafe(
        `CREATE FUNCTION test_refuse_all() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused' USING ERRCODE = '23514'; END $$ LANGUAGE plpgsql`,
      );
      await db.$executeRawUnsafe(
        `CREATE TRIGGER test_refuse_all BEFORE INSERT ON "ScannerResult" FOR EACH ROW EXECUTE FUNCTION test_refuse_all()`,
      );
    },
    exit: 1,
    summary: [/results not saved/],
  },
  {
    name: "results save cut, transient",
    series: { A10USDT: ok },
    plan: (p) => void (p.finishFault = "BEFORE_COMMIT"),
    exit: 1,
  },
  { name: "zero active markets", series: {}, exit: 1, summary: [/no active markets/] },
  {
    name: "database lost after startup",
    series: { A12USDT: ok },
    stopProxyOn: /Universe:/,
    exit: 1,
  },
  {
    name: "schema drift: a column is gone (P2022 on every market)",
    series: { A13USDT: ok, B13USDT: ok },
    prepare: async (db) => {
      await db.$executeRawUnsafe(
        `ALTER TABLE "TrackedSetup" RENAME COLUMN "riskRewardIsSynthetic" TO "test_gone"`,
      );
    },
    exit: 1,
    summary: [/P2022 permanent: A13USDT, B13USDT/, /pending migration/],
  },
  {
    name: "cut at the first lifecycle statement, outage through delivery",
    series: { A15USDT: ok, B15USDT: ok },
    plan: (p) => void (p.outageAt = 2),
    leavesOwnRunRunning: true,
    exit: 1,
  },
];

describe.skipIf(!FAULT_TESTS_ENABLED)("the real scanner process, real faults", () => {
  let pg: ThrowawayPostgres;
  let exchange: Awaited<ReturnType<typeof startFixtureExchange>>;
  const liveLocks = join(process.cwd(), ".spotlens", "locks");
  const liveLocksBefore = existsSync(liveLocks) ? readdirSync(liveLocks).sort() : null;

  beforeAll(async () => {
    pg = await startThrowawayPostgres();
    exchange = await startFixtureExchange({
      get now() {
        return Date.now();
      },
    });
  }, 120_000);

  afterAll(async () => {
    await exchange?.close();
    await pg?.stop();
    const after = existsSync(liveLocks) ? readdirSync(liveLocks).sort() : null;
    expect(after).toEqual(liveLocksBefore);
  });

  it.each(CASES.map((c, i) => [c.name, c, i] as const))(
    "%s",
    async (_name, c, i) => {
      const dbName = `proc${i}_test`;
      const direct = await pg.createDatabase(dbName);
      const db = new PrismaClient({ datasourceUrl: direct, log: [] });
      await db.user.create({ data: { email: "proc@example.test" } });
      const pairs: Record<string, string> = {};
      for (const [symbol, series] of Object.entries(c.series)) {
        const pair = await db.tradingPair.create({
          data: {
            quoteCurrency: "USDT",
            exchangeSymbol: symbol,
            asset: {
              create: {
                symbol: symbol.replace("USDT", ""),
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
        pairs[symbol] = pair.id;
        exchange.series.set(symbol, series as never);
      }
      await c.prepare?.(db, pairs);
      const stranger = c.stranger
        ? await db.scannerRun.create({
            data: {
              timeframes: ["H1"],
              marketCount: 1,
              triggeredBy: "SCHEDULE",
              status: "RUNNING",
              startedAt: new Date(Date.now() - 5 * 60_000),
            },
          })
        : null;

      const proxy = new FaultProxy(pg.port);
      await proxy.start();
      c.plan?.(proxy);
      const lockDir = throwawayDir();
      const viaProxy = pg.urlVia(proxy, dbName, VIA_PROXY);

      const child = spawn(
        "node",
        ["--import", `./${GUARD}`, "--import", "tsx", "scripts/scanner.ts", "--once"],
        {
          env: hermeticEnv({
            DATABASE_URL: viaProxy,
            DIRECT_URL: direct,
            BINANCE_API_BASE_URL: `http://127.0.0.1:${exchange.port}`,
            SCANNER_TIMEFRAMES: "H1",
            SCANNER_CLOSE_DELAY_MS: "1",
            SCANNER_MAX_CONCURRENCY: "1",
            SPOTLENS_LOCK_DIR: lockDir,
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      let stopOn = c.stopProxyOn;
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stopOn?.test(stdout)) {
          stopOn = undefined;
          void proxy.stop();
        }
      });
      child.stderr.on("data", (d) => void (stderr += d));
      const watchdog = setTimeout(() => child.kill("SIGKILL"), 50_000);
      const code = await new Promise<number | null>((resolve) =>
        child.on("exit", (x) => resolve(x)),
      );
      clearTimeout(watchdog);
      await proxy.stop();

      const text = stdout.replace(/^\[scanner [^\]]+\] /gm, "");
      expect(code).toBe(c.exit);
      for (const line of c.summary ?? []) expect(text).toMatch(line);
      // No password or connection string, ever. Prisma's own host:port lines are Part B.
      expect(stdout + stderr).not.toMatch(LEAK);
      if (c.plan && !c.stopProxyOn) expect(proxy.fired.length).toBeGreaterThan(0);

      const runs = await db.scannerRun.findMany({ select: { id: true, status: true } });
      if (stranger) {
        expect(runs.find((r) => r.id === stranger.id)?.status).toBe("RUNNING");
        expect(runs.filter((r) => r.id !== stranger.id).map((r) => r.status)).toEqual(["FAILED"]);
      } else if (c.leavesOwnRunRunning) {
        expect(runs.map((r) => r.status)).toEqual(["RUNNING"]);
      } else {
        expect(runs.filter((r) => r.status === "RUNNING")).toEqual([]);
      }
      await db.$disconnect();
    },
    60_000,
  );

  it("the real loop on the real clock: a lost save, one real 1 min retry, its own row closed, another's not", async () => {
    const dbName = "loop_test";
    const direct = await pg.createDatabase(dbName);
    const db = new PrismaClient({ datasourceUrl: direct, log: [] });
    await db.user.create({ data: { email: "loop@example.test" } });
    for (const symbol of ["L1USDT", "L2USDT"]) {
      await db.tradingPair.create({
        data: {
          quoteCurrency: "USDT",
          exchangeSymbol: symbol,
          asset: {
            create: {
              symbol: symbol.replace("USDT", ""),
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
      exchange.series.set(symbol, ok as never);
    }
    const stranger = await db.scannerRun.create({
      data: {
        timeframes: ["H1"],
        marketCount: 1,
        triggeredBy: "SCHEDULE",
        status: "RUNNING",
        startedAt: new Date(Date.now() - 5 * 60_000),
      },
    });
    const proxy = new FaultProxy(pg.port);
    await proxy.start();
    proxy.finishFault = "BEFORE_COMMIT";
    const lockDir = throwawayDir();
    const child = spawn(
      "node",
      ["--import", `./${GUARD}`, "--import", "tsx", "scripts/scanner.ts", "--catch-up"],
      {
        env: hermeticEnv({
          DATABASE_URL: pg.urlVia(proxy, dbName, VIA_PROXY),
          DIRECT_URL: direct,
          BINANCE_API_BASE_URL: `http://127.0.0.1:${exchange.port}`,
          SCANNER_CLOSE_DELAY_MS: "1",
          SCANNER_MAX_CONCURRENCY: "2",
          SPOTLENS_LOCK_DIR: lockDir,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (d) => void (stdout += d));
    child.stderr.on("data", () => undefined);
    const unregister = registerCleanup(() => child.kill("SIGKILL"));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (x) => resolve(x)));

    const deadline = Date.now() + 120_000;
    let completed = 0;
    while (completed === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      completed = await db.scannerRun.count({ where: { status: "COMPLETED" } });
    }
    child.kill("SIGINT");
    expect(await exited).toBe(0);
    unregister();
    await proxy.stop();
    rmSync(lockDir, { recursive: true, force: true });

    expect(proxy.fired.map((f) => f.mode)).toContain("FINISH_BEFORE_COMMIT");
    expect(stdout).toMatch(/PASS FAILED, TRANSIENT/);
    expect(stdout).toMatch(/will retry in 1 min \(retry 1 of 4\)/);
    expect(stdout).toMatch(/Closed this scanner's unfinished run/);
    const runs = await db.scannerRun.findMany({ select: { id: true, status: true } });
    expect(runs.find((r) => r.id === stranger.id)?.status).toBe("RUNNING");
    expect(
      runs
        .filter((r) => r.id !== stranger.id)
        .map((r) => r.status)
        .sort(),
    ).toEqual(["COMPLETED", "FAILED"]);
    await db.$disconnect();
  }, 180_000);
});
