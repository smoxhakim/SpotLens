// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiTimeframe, defaultHigherTimeframe, runAnalysis } from "@/lib/analysis";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/market-data/provider";
import { lifecycleLockKey, LifecycleConflictError } from "@/lib/setups";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

/**
 * `trackSetup` as a transaction: one per call, the lock taken before anything
 * is read, every write on the transaction client and guarded on the state it
 * was planned from, and a retry only when the rollback is certain.
 *
 * The real-Postgres half — concurrency, crashes, timeouts — is in
 * `setups.db.test.ts`. This half pins the order of statements and the outcome
 * shape, which a database cannot show and a mock can.
 */

const log: string[] = [];
const findFirst = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const eventCreate = vi.fn();
const recorded = vi.fn();
const rawStatements: { sql: string; values: unknown[] }[] = [];
const options: unknown[] = [];
const faults: { begin: unknown[]; commit: unknown[] } = { begin: [], commit: [] };
const globalCalls: string[] = [];
let attempts = 0;

const refuse = (name: string) => () => {
  globalCalls.push(name);
  throw new Error(`${name} called on the global client`);
};

vi.mock("@/lib/db/prisma", () => {
  const tx = {
    trackedSetup: {
      findFirst: (a: unknown) => (log.push("read"), findFirst(a)),
      create: (a: unknown) => (log.push("create"), create(a)),
      updateMany: (a: unknown) => (log.push("updateMany"), updateMany(a)),
    },
    setupEvent: { create: (a: unknown) => (log.push("event"), eventCreate(a)) },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      log.push(sql.includes("pg_advisory_xact_lock") ? "lock" : "timeouts");
      rawStatements.push({ sql, values });
      return 1;
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push("recorded");
      return recorded(strings.join("?"), values);
    },
  };

  return {
    isDatabaseConfigured: true,
    prisma: {
      trackedSetup: {
        findFirst: refuse("trackedSetup.findFirst"),
        create: refuse("trackedSetup.create"),
        update: refuse("trackedSetup.update"),
        updateMany: refuse("trackedSetup.updateMany"),
      },
      setupEvent: { create: refuse("setupEvent.create") },
      $executeRaw: refuse("$executeRaw"),
      $queryRaw: refuse("$queryRaw"),
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>, opts: unknown) => {
        attempts += 1;
        options.push(opts);
        if (faults.begin.length > 0) throw faults.begin.shift();
        const value = await fn(tx);
        if (faults.commit.length > 0) throw faults.commit.shift();
        return value;
      },
    },
  };
});

const { trackSetup } = await import("./setups");

const H = TIMEFRAME_MS.H1;

/** Read as the scanner reads this timeframe: against its canonical higher one. */
function asScanned(timeframe: Timeframe, candles: Candle[] = pullbackIntoSupport()) {
  return runAnalysis(candles, {
    mtf: analyzeMultiTimeframe({
      lowerCandles: candles,
      higherCandles: pullbackIntoSupport(),
      lowerTimeframe: timeframe,
      higherTimeframe: defaultHigherTimeframe(timeframe)!,
    }),
  });
}

const BULLISH = asScanned("H1");
const CANDLE = BULLISH.read.lastCandleTime;
const base = { userId: "user-1", tradingPairId: "pair-1", timeframe: "H1" as const };

/** An open setup on a level the analysis does not overlap. */
const elsewhere = (status = "SETUP_FORMING") => ({
  id: "setup-old",
  status,
  originZoneLow: 200,
  originZoneHigh: 204,
  confirmedAt: null,
});

/** An open setup on the analysis's own level. */
const here = (status: string, confirmedAt: Date | null = null) => ({
  id: "setup-1",
  status,
  originZoneLow: BULLISH.setup!.entry.sourceZone.low,
  originZoneHigh: BULLISH.setup!.entry.sourceZone.high,
  confirmedAt,
});

const prismaError = (code: string, message = "provider text: postgresql://u:secret@h/db") =>
  Object.assign(new Error(message), { code });

const writes = () => log.filter((step) => ["create", "updateMany", "event"].includes(step));

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const mock of [findFirst, create, updateMany, eventCreate, recorded]) mock.mockReset();
  log.length = 0;
  rawStatements.length = 0;
  options.length = 0;
  faults.begin.length = 0;
  faults.commit.length = 0;
  globalCalls.length = 0;
  attempts = 0;

  findFirst.mockResolvedValue(null);
  create.mockResolvedValue({ id: "setup-new", events: [{ id: "event-created" }] });
  updateMany.mockResolvedValue({ count: 1 });
  eventCreate.mockResolvedValue({ id: "event-moved" });
  recorded.mockResolvedValue([{ evaluated: null, unstamped: null }]);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  expect(globalCalls, "a statement escaped the transaction").toEqual([]);
  warn.mockRestore();
});

describe("one transaction, the lock first", () => {
  it("runs as one READ COMMITTED transaction with bounded waits", async () => {
    await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(1);
    expect(options).toEqual([{ isolationLevel: "ReadCommitted", maxWait: 5_000, timeout: 10_000 }]);
  });

  it("sets this transaction's timeouts, then locks, before reading anything", async () => {
    await trackSetup({ ...base, result: BULLISH });

    expect(log.slice(0, 4)).toEqual(["timeouts", "lock", "read", "recorded"]);

    const [timeouts, lock] = rawStatements;
    expect(timeouts.sql).toContain("set_config('lock_timeout'");
    expect(timeouts.sql).toContain("set_config('idle_in_transaction_session_timeout'");
    expect(timeouts.sql.match(/, true\)/g)).toHaveLength(2); // transaction-local, both
    expect(timeouts.values).toEqual(["5s", "30s"]);
    expect(lock.sql).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(lock.sql).toContain(", 0))");
  });

  it("keys the lock on exactly the identity it reads the open setup by", async () => {
    await trackSetup({ ...base, result: BULLISH });

    const where = findFirst.mock.calls[0][0].where;
    const lock = rawStatements.find((s) => s.sql.includes("pg_advisory_xact_lock"))!;
    expect(lock.values).toEqual([
      lifecycleLockKey({
        userId: where.userId,
        tradingPairId: where.tradingPairId,
        timeframe: where.timeframe,
      }),
    ]);
    expect(where).toMatchObject({ ...base, status: { not: "INVALIDATED" } });
  });

  it("H1 and H4 on one market take different locks", async () => {
    await trackSetup({ ...base, result: BULLISH });
    await trackSetup({ ...base, timeframe: "H4", result: asScanned("H4") });

    const locks = rawStatements.filter((s) => s.sql.includes("pg_advisory_xact_lock"));
    expect(locks).toHaveLength(2);
    expect(locks[0].values[0]).not.toBe(locks[1].values[0]);
  });
});

describe("the outcome names exactly what was written", () => {
  it("a creation reports its setup and its CREATED event", async () => {
    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(outcome).toMatchObject({
      action: "CREATE",
      setupId: "setup-new",
      replacedSetupId: null,
    });
    expect(outcome.events).toEqual([
      {
        setupId: "setup-new",
        eventId: "event-created",
        type: "CREATED",
        toStatus: "POTENTIAL_SETUP",
      },
    ]);
  });

  it("a replacement closes the old setup, then creates the new one, in one transaction", async () => {
    findFirst.mockResolvedValue(elsewhere());
    eventCreate.mockResolvedValue({ id: "event-invalidated" });

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(1);
    expect(writes()).toEqual(["updateMany", "event", "create"]);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "setup-old",
      userId: "user-1",
      status: "SETUP_FORMING",
    });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ status: "INVALIDATED" });
    expect(outcome).toMatchObject({
      action: "REPLACE",
      setupId: "setup-new",
      replacedSetupId: "setup-old",
    });
    expect(outcome.events).toEqual([
      {
        setupId: "setup-old",
        eventId: "event-invalidated",
        type: "INVALIDATED",
        toStatus: "INVALIDATED",
      },
      {
        setupId: "setup-new",
        eventId: "event-created",
        type: "CREATED",
        toStatus: "POTENTIAL_SETUP",
      },
    ]);
  });

  it("a moved anchor's event carries why, beside what confirmation said", async () => {
    findFirst.mockResolvedValue(elsewhere());

    await trackSetup({ ...base, result: BULLISH });

    // 200–204 is above the analysed close, so the level failed.
    const { payload, detail } = eventCreate.mock.calls[0][0].data;
    expect(payload.closure).toEqual({
      cause: "SUPPORT_LOST",
      close: BULLISH.read.price,
      originLow: 200,
      originHigh: 204,
      anchorLow: BULLISH.setup!.entry.sourceZone.low,
      anchorHigh: BULLISH.setup!.entry.sourceZone.high,
    });
    expect(detail).toMatch(/below this setup's zone/);
    expect(updateMany.mock.calls[0][0].data.invalidationReason).toBe(detail);
    // The stale-analysis guard reads this, so it has to stay where it was.
    expect(payload.evaluatedAt).toBe(BULLISH.confirmation!.evaluatedAt);
    expect(payload.status).toBe(BULLISH.confirmation!.status);
    expect(payload.signals).toHaveLength(BULLISH.confirmation!.signals.length);
  });

  it("no other transition's event carries a closure", async () => {
    findFirst.mockResolvedValue(here("SETUP_FORMING"));

    await trackSetup({ ...base, result: BULLISH });

    const { payload } = eventCreate.mock.calls[0][0].data;
    expect(payload).not.toHaveProperty("closure");
    expect(payload.evaluatedAt).toBe(BULLISH.confirmation!.evaluatedAt);
  });

  it("a transition is guarded on its owner and the state it was planned from", async () => {
    findFirst.mockResolvedValue(here("WAITING_CONFIRMATION"));

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "setup-1",
      userId: "user-1",
      status: "WAITING_CONFIRMATION",
    });
    expect(outcome.events).toEqual([
      {
        setupId: "setup-1",
        eventId: "event-moved",
        type: "POTENTIAL_SETUP",
        toStatus: "POTENTIAL_SETUP",
      },
    ]);
  });

  it("an unchanged analysis takes the lock, reads, and writes nothing", async () => {
    findFirst.mockResolvedValue(here("POTENTIAL_SETUP", new Date()));

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(log).toEqual(["timeouts", "lock", "read", "recorded"]);
    expect(outcome).toMatchObject({
      action: "NONE",
      cause: "UNCHANGED",
      setupId: "setup-1",
      events: [],
    });
  });
});

describe("a retry only after a certain rollback", () => {
  it("re-reads and re-plans after a guarded write finds the row moved", async () => {
    // Attempt 1 planned from SETUP_FORMING; the row had moved, so the guard
    // matched nothing. Attempt 2 reads it fresh and plans from there.
    findFirst
      .mockResolvedValueOnce(here("SETUP_FORMING"))
      .mockResolvedValueOnce(here("WAITING_CONFIRMATION"));
    updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(2);
    expect(findFirst).toHaveBeenCalledTimes(2);
    const statusWrites = updateMany.mock.calls.filter((call) => call[0].where.status !== undefined);
    expect(statusWrites.map((call) => call[0].where.status)).toEqual([
      "SETUP_FORMING",
      "WAITING_CONFIRMATION",
    ]);
    expect(outcome).toMatchObject({ action: "TRANSITION", status: "POTENTIAL_SETUP" });
  });

  it("never makes more than two attempts", async () => {
    findFirst.mockResolvedValue(here("SETUP_FORMING"));
    updateMany.mockResolvedValue({ count: 0 });

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(2);
    expect(outcome).toMatchObject({ action: "NONE", setupId: null, cause: null, events: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("(LIFECYCLE_CONFLICT) — nothing was written");
  });

  it.each([
    ["a lock timeout", Object.assign(new Error("x"), { code: "P2010", meta: { code: "55P03" } })],
    ["a write conflict or deadlock", prismaError("P2034")],
    ["a guard conflict thrown as such", new LifecycleConflictError("setup-1", "SETUP_FORMING")],
  ])("retries %s inside the transaction once", async (_label, error) => {
    findFirst.mockRejectedValueOnce(error).mockResolvedValue(null);

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(2);
    expect(outcome.action).toBe("CREATE");
    expect(warn).not.toHaveBeenCalled();
  });

  it("retries a transaction that could not start in time", async () => {
    faults.begin.push(
      prismaError(
        "P2028",
        "Transaction API error: Unable to start a transaction in the given time.",
      ),
    );

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(2);
    expect(outcome.action).toBe("CREATE");
  });

  it("does not retry Prisma's transaction timeout", async () => {
    findFirst.mockRejectedValue(prismaError("P2028"));

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(1);
    expect(outcome).toMatchObject({ action: "NONE", setupId: null, events: [] });
    expect(warn.mock.calls[0][0]).toContain("(P2028) — nothing was written");
  });

  it("does not retry, and says so, when the commit may have happened", async () => {
    // The callback finished; the connection dropped before COMMIT was
    // acknowledged. The change may exist — and would then go un-notified.
    faults.commit.push(prismaError("P1017"));

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(1);
    expect(outcome).toMatchObject({ action: "NONE", setupId: null, events: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain("lifecycle outcome unknown for pair-1 H1 (P1017)");
    expect(line).toContain("the change may have been committed; its notification will not be sent");
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(line).not.toContain("secret");
  });

  it("treats a commit refused on an expired transaction as not written", async () => {
    faults.commit.push(
      prismaError(
        "P2028",
        "Transaction already closed: A commit cannot be executed on an expired transaction.",
      ),
    );

    await trackSetup({ ...base, result: BULLISH });

    expect(attempts).toBe(1);
    expect(warn.mock.calls[0][0]).toContain("(P2028) — nothing was written");
  });

  it("never throws, and logs every occurrence rather than the first", async () => {
    findFirst.mockRejectedValue(new TypeError("boom"));

    await expect(trackSetup({ ...base, result: BULLISH })).resolves.toMatchObject({
      action: "NONE",
    });
    await expect(trackSetup({ ...base, result: BULLISH })).resolves.toMatchObject({
      action: "NONE",
    });

    expect(attempts).toBe(2); // one each, no retry
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("an older analysis cannot move a setup", () => {
  it("is refused when a newer candle is already recorded", async () => {
    findFirst.mockResolvedValue(here("CONFIRMATION_DETECTED", new Date()));
    recorded.mockResolvedValue([{ evaluated: BigInt(CANDLE + 2 * H - 1), unstamped: null }]);

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(outcome).toMatchObject({
      action: "NONE",
      setupId: null,
      cause: "STALE_ANALYSIS",
      events: [],
    });
    expect(writes()).toEqual([]);
  });

  it("is refused after a newer invalidation that recorded no candle", async () => {
    // The "engine offered no setup" invalidation writes no payload. Its candle
    // is bounded by when it was written — here after the next candle closed.
    recorded.mockResolvedValue([
      { evaluated: BigInt(CANDLE - 3 * H - 1), unstamped: new Date(CANDLE + 2 * H + 90_000) },
    ]);

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(outcome.cause).toBe("STALE_ANALYSIS");
    expect(writes()).toEqual([]);
  });

  it("still plans on the same candle — a repeated pass is not stale", async () => {
    recorded.mockResolvedValue([{ evaluated: BigInt(CANDLE + H - 1), unstamped: null }]);

    const outcome = await trackSetup({ ...base, result: BULLISH });

    expect(outcome.action).toBe("CREATE");
  });
});

describe("only the canonical context is written", () => {
  it("refuses an H1 analysis read against D1, before any transaction", async () => {
    const candles = pullbackIntoSupport();
    const againstD1 = runAnalysis(candles, {
      mtf: analyzeMultiTimeframe({
        lowerCandles: candles,
        higherCandles: pullbackIntoSupport(),
        lowerTimeframe: "H1",
        higherTimeframe: "D1",
      }),
    });

    const outcome = await trackSetup({ ...base, result: againstD1 });

    expect(outcome).toMatchObject({
      action: "NONE",
      setupId: null,
      cause: "NON_CANONICAL_CONTEXT",
      events: [],
    });
    expect(attempts).toBe(0);
    expect(log).toEqual([]);
  });

  it("refuses a single-timeframe H1 read, and admits one on W1, which has no higher timeframe", async () => {
    const single = runAnalysis(pullbackIntoSupport());

    expect((await trackSetup({ ...base, result: single })).cause).toBe("NON_CANONICAL_CONTEXT");
    expect(attempts).toBe(0);

    await trackSetup({ ...base, timeframe: "W1", result: single });
    expect(attempts).toBe(1);
  });

  it("admits what the scanner reads, on both of its timeframes", async () => {
    await trackSetup({ ...base, timeframe: "H1", result: asScanned("H1") });
    await trackSetup({ ...base, timeframe: "H4", result: asScanned("H4") });

    expect(attempts).toBe(2);
  });
});
