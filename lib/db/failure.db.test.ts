// @vitest-environment node
import net from "node:net";

import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { databaseFailureOf } from "@/lib/db/failure";
import { classifyFailure } from "@/lib/scanner/failures";
import { classifyPassError } from "@/lib/scanner/retry";
import { classifyLifecycleError, LifecycleConflictError } from "@/lib/setups";
import { FaultProxy } from "@/lib/test-utils/fault-proxy";
import { downtrend, pullbackIntoSupport } from "@/lib/test-utils/scenarios";
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
 * The real error objects, from a real Prisma client on a real PostgreSQL. If an upgrade
 * changes a shape the classifier reads, this file is what says so.
 *
 * Reproduced for real: P2034, P1008, P2010 with a SQLSTATE, P2010 without one, a real
 * model-query deadlock and lock timeout, first-connect failures, LIFECYCLE_CONFLICT
 * through the real trackSetup. Simulated: P1002, which no client route here produces
 * (each route tried is pinned below as the code it really gives). Its class and code
 * are tested in failure.test.ts on the real class with the code set by the test.
 *
 * A real model-query deadlock or lock timeout carries no code and no meta. The SQLSTATE
 * is only in the message, which is deliberately not read. They are PERMANENT: the pass
 * is blocked for one window, never a success. Pinned below.
 *
 * Opt-in: SPOTLENS_FAULT_TESTS=1. It starts its own server and takes no URL.
 */

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const capture = async (fn: () => Promise<unknown>): Promise<unknown> => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
function rejected(results: PromiseSettledResult<unknown>[]): unknown {
  const r = results.find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
  if (!r) throw new Error("expected one of these transactions to fail");
  return r.reason;
}
/** The same error with another message: the classifier must not care. */
function withMessage(err: unknown, message: string) {
  const copy = Object.create(Object.getPrototypeOf(err));
  for (const k of Object.getOwnPropertyNames(err)) {
    Object.defineProperty(copy, k, Object.getOwnPropertyDescriptor(err, k)!);
  }
  Object.defineProperty(copy, "message", { value: message, configurable: true });
  return copy;
}
function structureOnly(err: unknown, expected: { code: string; class: string }) {
  expect(databaseFailureOf(err)).toEqual(expected);
  expect(databaseFailureOf(withMessage(err, ""))).toEqual(expected);
  expect(
    databaseFailureOf(withMessage(err, "Authentication failed, can't reach, timed out")),
  ).toEqual(expected);
}

describe.skipIf(!FAULT_TESTS_ENABLED)("what a real Prisma client really throws", () => {
  let pg: ThrowawayPostgres;
  let direct: string;
  let db: PrismaClient;
  let a: string;
  let b: string;

  beforeAll(async () => {
    pg = await startThrowawayPostgres();
    direct = await pg.createDatabase("shapes_test");
    db = new PrismaClient({ datasourceUrl: direct, log: [] });
    a = (await db.user.create({ data: { email: "a@example.test", name: "a" } })).id;
    b = (await db.user.create({ data: { email: "b@example.test", name: "b" } })).id;
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    await pg?.stop();
  });

  it("P2034: two RepeatableRead transactions updating one row", async () => {
    const tx = (name: string) =>
      db.$transaction(
        async (t) => {
          await t.user.findUnique({ where: { id: a } });
          await pause(300);
          await t.user.update({ where: { id: a }, data: { name } });
        },
        { isolationLevel: "RepeatableRead" },
      );
    const err = rejected(await Promise.allSettled([tx("x1"), tx("x2")]));
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as { code: string }).code).toBe("P2034");
    structureOnly(err, { code: "P2034", class: "TRANSIENT" });
    expect(classifyPassError(err, false)).toBe("FAILED_TRANSIENT");
  }, 30_000);

  it("P2034: Serializable write skew", async () => {
    const tx = (id: string, name: string) =>
      db.$transaction(
        async (t) => {
          await t.user.findMany();
          await pause(300);
          await t.user.update({ where: { id }, data: { name } });
        },
        { isolationLevel: "Serializable" },
      );
    const err = rejected(await Promise.allSettled([tx(a, "y1"), tx(b, "y2")]));
    expect((err as { code: string }).code).toBe("P2034");
    structureOnly(err, { code: "P2034", class: "TRANSIENT" });
  }, 30_000);

  it("a model-query deadlock has no code and no meta: permanent, blocked, never success", async () => {
    const tx = (first: string, second: string) =>
      db.$transaction(
        async (t) => {
          await t.user.update({ where: { id: first }, data: { name: "d" } });
          await pause(300);
          await t.user.update({ where: { id: second }, data: { name: "e" } });
        },
        { timeout: 15_000 },
      );
    const err = rejected(await Promise.allSettled([tx(a, b), tx(b, a)]));
    expect(err).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect((err as { code?: unknown }).code).toBeUndefined();
    expect((err as { meta?: unknown }).meta).toBeUndefined();
    structureOnly(err, { code: "PrismaClientUnknownRequestError", class: "PERMANENT" });
    expect(classifyPassError(err, false)).toBe("FAILED_BLOCKED");
  }, 30_000);

  it("a raw deadlock carries its SQLSTATE in meta.code: transient", async () => {
    const tx = (x: number, y: number) =>
      db.$transaction(
        async (t) => {
          await t.$executeRaw`SELECT pg_advisory_xact_lock(${x}::bigint)`;
          await pause(300);
          await t.$executeRaw`SELECT pg_advisory_xact_lock(${y}::bigint)`;
        },
        { timeout: 15_000 },
      );
    const err = rejected(await Promise.allSettled([tx(101, 102), tx(102, 101)]));
    expect((err as { code: string; meta: { code: string } }).code).toBe("P2010");
    expect((err as { meta: { code: string } }).meta.code).toBe("40P01");
    structureOnly(err, { code: "40P01", class: "TRANSIENT" });
  }, 30_000);

  it("a model-query lock timeout has no code and no meta: permanent, blocked", async () => {
    let release = () => undefined as void;
    const holder = db.$transaction(
      async (t) => {
        await t.user.update({ where: { id: a }, data: { name: "held" } });
        await new Promise<void>((resolve) => (release = resolve));
      },
      { timeout: 15_000 },
    );
    await pause(200);
    const err = await capture(() =>
      db.$transaction(async (t) => {
        await t.$executeRaw`SELECT set_config('lock_timeout', '300ms', true)`;
        await t.user.update({ where: { id: a }, data: { name: "blocked" } });
      }),
    );
    release();
    await holder;
    expect(err).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    structureOnly(err, { code: "PrismaClientUnknownRequestError", class: "PERMANENT" });
    expect(classifyPassError(err, false)).toBe("FAILED_BLOCKED");
  }, 30_000);

  it("the raw advisory lock trackSetup uses times out with 55P03 in meta.code: transient", async () => {
    let release = () => undefined as void;
    const holder = db.$transaction(
      async (t) => {
        await t.$executeRaw`SELECT pg_advisory_xact_lock(424242)`;
        await new Promise<void>((resolve) => (release = resolve));
      },
      { timeout: 15_000 },
    );
    await pause(200);
    const err = await capture(() =>
      db.$transaction(async (t) => {
        await t.$executeRaw`SELECT set_config('lock_timeout', '300ms', true)`;
        await t.$executeRaw`SELECT pg_advisory_xact_lock(424242)`;
      }),
    );
    release();
    await holder;
    expect((err as { meta: { code: string } }).meta.code).toBe("55P03");
    structureOnly(err, { code: "55P03", class: "TRANSIENT" });
  }, 30_000);

  it("P1008: a socket timeout on a model query", async () => {
    let release = () => undefined as void;
    const holder = db.$transaction(
      async (t) => {
        await t.user.update({ where: { id: b }, data: { name: "held" } });
        await new Promise<void>((resolve) => (release = resolve));
      },
      { timeout: 15_000 },
    );
    await pause(200);
    const c = new PrismaClient({ datasourceUrl: `${direct}&socket_timeout=1`, log: [] });
    const err = await capture(() => c.user.update({ where: { id: b }, data: { name: "late" } }));
    release();
    await holder;
    await c.$disconnect().catch(() => undefined);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as { code: string }).code).toBe("P1008");
    structureOnly(err, { code: "P1008", class: "TRANSIENT" });
  }, 30_000);

  it("a socket timeout on a raw query is P2010 with no SQLSTATE: transient, by structure", async () => {
    const c = new PrismaClient({ datasourceUrl: `${direct}&socket_timeout=1`, log: [] });
    const err = await capture(() => c.$queryRaw`SELECT pg_sleep(3)`);
    await c.$disconnect().catch(() => undefined);
    expect((err as { code: string }).code).toBe("P2010");
    expect((err as { meta: { code: string } }).meta.code).toBe("N/A");
    structureOnly(err, { code: "P2010_NO_SQLSTATE", class: "TRANSIENT" });
  }, 30_000);

  it("P1002 cannot be produced from here: each route tried gives something else", async () => {
    // Silent server, first connect: a first-connect error with no code at all.
    const silent = net.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const port = (silent.address() as net.AddressInfo).port;
    const first = new PrismaClient({
      datasourceUrl: `postgresql://x:x@127.0.0.1:${port}/none_test?sslmode=disable&connect_timeout=1`,
      log: [],
    });
    const e1 = await capture(() => first.user.count());
    await first.$disconnect().catch(() => undefined);
    silent.close();
    expect(e1).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect((e1 as { errorCode?: unknown }).errorCode ?? null).toBeNull();
    expect(databaseFailureOf(e1)).toEqual({ code: "INIT_UNREACHABLE", class: "TRANSIENT" });

    // A client that has connected, then a server gone silent: P1017.
    const proxy = new FaultProxy(pg.port);
    await proxy.start();
    const known = new PrismaClient({
      datasourceUrl: pg.urlVia(
        proxy,
        "shapes_test",
        "sslmode=disable&connect_timeout=1&connection_limit=1&statement_cache_size=0&socket_timeout=1",
      ),
      log: [],
    });
    await known.user.count();
    const samePort = proxy.port;
    await proxy.stop();
    const hold = net.createServer(() => undefined);
    await new Promise<void>((r) => hold.listen(samePort, "127.0.0.1", r));
    const e2 = await capture(() => known.user.count());
    hold.close();
    await known.$disconnect().catch(() => undefined);
    expect((e2 as { code: string }).code).toBe("P1017");
    structureOnly(e2, { code: "P1017", class: "TRANSIENT" });
  }, 30_000);

  it("LIFECYCLE_CONFLICT: through the real trackSetup, a guarded write that moves nothing", async () => {
    process.env.DATABASE_URL = direct;
    process.env.DIRECT_URL = direct;
    const { trackSetup } = await import("@/services/setups");
    const { analyzeMultiTimeframe, runAnalysis } = await import("@/lib/analysis");
    const asset = await db.asset.create({
      data: {
        symbol: "CF",
        name: "c",
        category: "OTHER",
        officialWebsite: "https://example.test",
        description: "x",
        utilityExplanation: "x",
        riskLevel: "LOW",
      },
    });
    const pair = await db.tradingPair.create({
      data: { assetId: asset.id, quoteCurrency: "USDT", exchangeSymbol: "CFUSDT" },
    });
    const T = Date.UTC(2026, 0, 5, 12);
    const H = 3_600_000;
    const endingAt = <C extends { openTime: number; closeTime: number }>(
      cs: C[],
      lastOpen: number,
    ) => {
      const shift = lastOpen - cs.at(-1)!.openTime;
      return cs.map((c) => ({
        ...c,
        openTime: c.openTime + shift,
        closeTime: c.closeTime + shift,
      }));
    };
    const analysis = (
      cs: ReturnType<typeof pullbackIntoSupport>,
      lastOpen: number,
      higher = pullbackIntoSupport(),
    ) => {
      const lower = endingAt(cs, lastOpen);
      return runAnalysis(lower, {
        mtf: analyzeMultiTimeframe({
          lowerCandles: lower,
          higherCandles: higher,
          lowerTimeframe: "H1",
          higherTimeframe: "H4",
        }),
      });
    };
    const input = { userId: a, tradingPairId: pair.id, timeframe: "H1" as const };
    const created = await trackSetup({ ...input, result: analysis(pullbackIntoSupport(), T) });
    await db.$executeRawUnsafe(
      `CREATE FUNCTION test_skip() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER test_skip BEFORE UPDATE ON "TrackedSetup" FOR EACH ROW EXECUTE FUNCTION test_skip()`,
    );
    const conflict = await trackSetup({
      ...input,
      result: analysis(downtrend(), T + H, downtrend()),
    });
    expect(conflict.action).toBe("NONE");
    expect(conflict.failure).toEqual({
      kind: "RETRY",
      code: "LIFECYCLE_CONFLICT",
      class: "TRANSIENT",
    });
    expect(await db.setupEvent.count({ where: { setupId: created.setupId! } })).toBe(1);
    await db.$executeRawUnsafe(`DROP TRIGGER test_skip ON "TrackedSetup"`);
    const after = await trackSetup({
      ...input,
      result: analysis(downtrend(), T + H, downtrend()),
    });
    expect(after).toMatchObject({ action: "TRANSITION", status: "INVALIDATED" });
    expect(after.failure ?? null).toBeNull();
    structureOnly(new LifecycleConflictError("id", "OPEN" as never), {
      code: "LIFECYCLE_CONFLICT",
      class: "TRANSIENT",
    });
  }, 60_000);

  // The rest of what a pass can meet, for the record: what the lifecycle's own rule says
  // about each (it decides the in-call retry, and is unchanged), what a market's failure
  // is filed as, and what a pass that threw it is called.
  const reading = (err: unknown, phase: "BEGIN" | "BODY" | "COMMIT") => {
    const market = classifyFailure(err);
    return {
      lifecycle: classifyLifecycleError(err, phase).kind,
      database: databaseFailureOf(err),
      category: market.category,
      leaked: /127\.0\.0\.1|throwaway|\/Users\/|postgres(ql)?:/.test(market.message),
      pass: classifyPassError(err, false),
    };
  };
  const TX = { isolationLevel: "ReadCommitted", maxWait: 5000, timeout: 10_000 } as const;

  it("a backend terminated mid-transaction is P1017: transient", async () => {
    const err = await capture(() =>
      db.$transaction(async (t) => {
        const [{ pid }] = await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() pid`;
        const killer = new PrismaClient({ datasourceUrl: direct, log: [] });
        await killer.$executeRaw`SELECT pg_terminate_backend(${pid}::int)`;
        await killer.$disconnect();
        await pause(100);
        await t.$queryRaw`SELECT 1`;
      }, TX),
    );
    expect(reading(err, "BODY")).toEqual({
      lifecycle: "NOT_WRITTEN",
      database: { code: "P1017", class: "TRANSIENT" },
      category: "DATABASE_ERROR",
      leaked: false,
      pass: "FAILED_TRANSIENT",
    });
  }, 30_000);

  it("the idle-in-transaction timeout firing is P1017: transient", async () => {
    const err = await capture(() =>
      db.$transaction(async (t) => {
        await t.$executeRaw`SELECT set_config('idle_in_transaction_session_timeout', '300ms', true)`;
        await pause(800);
        await t.$queryRaw`SELECT 1`;
      }, TX),
    );
    expect(reading(err, "BODY").database).toEqual({ code: "P1017", class: "TRANSIENT" });
  }, 30_000);

  it("Prisma's own transaction timeout in the body is P2028: transient, and never retried in the call", async () => {
    const err = await capture(() =>
      db.$transaction(
        async (t) => {
          await t.$queryRaw`SELECT pg_sleep(1.5)`;
        },
        { ...TX, timeout: 300 },
      ),
    );
    expect((err as { code: string }).code).toBe("P2028");
    expect(reading(err, "BODY")).toEqual({
      lifecycle: "NOT_WRITTEN",
      database: { code: "P2028", class: "TRANSIENT" },
      category: "DATABASE_ERROR",
      leaked: false,
      pass: "FAILED_TRANSIENT",
    });
  }, 30_000);

  it("the pool full: P2028 for a transaction that could not start, P2024 for a read: transient", async () => {
    const small = new PrismaClient({
      datasourceUrl: pg.url("shapes_test", "sslmode=disable&connection_limit=2&pool_timeout=1"),
      log: [],
    });
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holders = Array.from({ length: 2 }, () =>
      small.$transaction(
        async () => {
          await held;
        },
        { timeout: 15_000, maxWait: 5000 },
      ),
    );
    await pause(300);
    const blocked = await capture(() =>
      small.$transaction(async () => undefined, { ...TX, maxWait: 500 }),
    );
    const read = await capture(() => small.user.count());
    release();
    await Promise.all(holders);
    await small.$disconnect();

    expect((blocked as { code: string }).code).toBe("P2028");
    expect(reading(blocked, "BEGIN")).toEqual({
      lifecycle: "RETRY",
      database: { code: "P2028", class: "TRANSIENT" },
      category: "DATABASE_ERROR",
      leaked: false,
      pass: "FAILED_TRANSIENT",
    });
    expect((read as { code: string }).code).toBe("P2024");
    expect(reading(read, "BODY").database).toEqual({ code: "P2024", class: "TRANSIENT" });
  }, 30_000);

  it("a missing table: P2010 with 42P01 on a raw query, P2021 on a model query: permanent", async () => {
    const raw = await capture(() => db.$queryRaw`SELECT * FROM "NoSuchTable"`);
    expect(reading(raw, "BODY")).toEqual({
      lifecycle: "NOT_WRITTEN",
      database: { code: "42P01", class: "PERMANENT" },
      category: "DATABASE_ERROR",
      leaked: false,
      pass: "FAILED_BLOCKED",
    });

    const brokenUrl = await pg.createDatabase("broken_test");
    const broken = new PrismaClient({ datasourceUrl: brokenUrl, log: [] });
    await broken.$executeRawUnsafe('ALTER TABLE "TradingPair" RENAME TO "test_gone"');
    const model = await capture(() => broken.tradingPair.count());
    await broken.$disconnect();
    expect(reading(model, "BODY")).toEqual({
      lifecycle: "NOT_WRITTEN",
      database: { code: "P2021", class: "PERMANENT" },
      category: "DATABASE_ERROR",
      leaked: false,
      pass: "FAILED_BLOCKED",
    });
  }, 30_000);

  it("a foreign key refusal: P2003, permanent", async () => {
    const run = await db.scannerRun.create({
      data: { timeframes: ["H1"], marketCount: 1, triggeredBy: "SCHEDULE", status: "RUNNING" },
    });
    const err = await capture(() =>
      db.scannerResult.create({
        data: {
          scannerRunId: run.id,
          tradingPairId: "00000000-0000-0000-0000-000000000000",
          timeframe: "H1",
          status: "OK",
        },
      }),
    );
    expect(reading(err, "BODY").database).toEqual({ code: "P2003", class: "PERMANENT" });
  }, 30_000);

  it("too many connections on first connect has no code and is not the one phrase: permanent, one window", async () => {
    await db.$executeRawUnsafe(
      `CREATE ROLE test_limited LOGIN PASSWORD 'limited' CONNECTION LIMIT 0`,
    );
    const limited = new PrismaClient({
      datasourceUrl: `postgresql://test_limited:limited@127.0.0.1:${pg.port}/shapes_test?sslmode=disable`,
      log: [],
    });
    const err = await capture(() => limited.user.count());
    await limited.$disconnect().catch(() => undefined);
    expect(err).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect(databaseFailureOf(err)).toEqual({ code: "INIT_REFUSED", class: "PERMANENT" });
    expect(classifyPassError(err, false)).toBe("FAILED_BLOCKED");
  }, 30_000);

  it("first connect: port closed retries; bad credentials and a missing database do not", async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise((r) => closed.close(r));
    const attempt = async (url: string) => {
      const c = new PrismaClient({ datasourceUrl: url, log: [] });
      const e = await capture(() => c.user.count());
      await c.$disconnect().catch(() => undefined);
      expect(e).toBeInstanceOf(Prisma.PrismaClientInitializationError);
      expect((e as { errorCode?: unknown }).errorCode ?? null).toBeNull();
      return databaseFailureOf(e);
    };
    expect(await attempt(`postgresql://x:x@127.0.0.1:${port}/none_test?connect_timeout=1`)).toEqual(
      {
        code: "INIT_UNREACHABLE",
        class: "TRANSIENT",
      },
    );
    expect(
      await attempt(
        `postgresql://throwaway:wrong@127.0.0.1:${pg.port}/shapes_test?sslmode=disable`,
      ),
    ).toEqual({ code: "INIT_REFUSED", class: "PERMANENT" });
    expect(
      await attempt(
        `postgresql://throwaway:throwaway@127.0.0.1:${pg.port}/missing_test?sslmode=disable`,
      ),
    ).toEqual({ code: "INIT_REFUSED", class: "PERMANENT" });
  }, 30_000);
});
