// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { analyzeMultiTimeframe, runAnalysis } from "@/lib/analysis";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/market-data/provider";
import { currentCandleOpen } from "@/lib/scanner/schedule";
import { lifecycleLockKey } from "@/lib/setups";
import { downtrend, extendedAboveSupport, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

/**
 * `trackSetup` against a real PostgreSQL: the advisory lock, the transaction,
 * the guarded writes, the timeouts and the failure paths, as Postgres itself
 * behaves — which no mock can show.
 *
 * Opt-in. It runs only when `SETUPS_TEST_DATABASE_URL` names a database on this
 * machine whose name ends in `_test`, and that is not the application's own
 * `DATABASE_URL` or `DIRECT_URL`; anything else is refused outright. It creates
 * rows, triggers and tables, terminates a backend and holds locks.
 *
 *   docker run -d --rm --name spotlens-setups-test -e POSTGRES_USER=setups \
 *     -e POSTGRES_PASSWORD=setups -e POSTGRES_DB=setups_test \
 *     -p 127.0.0.1:55433:5432 postgres:16-alpine
 *   DATABASE_URL=… DIRECT_URL=… npx prisma migrate deploy         # the same local URL
 *   SETUPS_TEST_DATABASE_URL=postgresql://setups:setups@127.0.0.1:55433/setups_test \
 *     npx vitest run services/setups.db.test.ts
 *
 * About 70 seconds: three cases wait out a real timeout (the lock's 5 s twice,
 * the transaction's 10 s, and the 30 s idle limit).
 *
 * Give it a database of its own. The files run in parallel, and the entry-zone
 * monitor's database test counts every open setup in the database it is given
 * — so pointing `ENTRY_ZONE_TEST_DATABASE_URL` at this same database makes that
 * count race the setups this file creates. (Its own `pg_locks` reads assume no
 * other advisory-lock user, which holds today.)
 */

const url = process.env.SETUPS_TEST_DATABASE_URL;
// Read before anything below changes the environment.
const APP_URLS = [process.env.DATABASE_URL, process.env.DIRECT_URL].filter(Boolean);
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];

function refusal(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "is not a URL";
  }
  if (!LOCAL_HOSTS.includes(parsed.hostname)) return "must point at this machine";
  if (APP_URLS.includes(raw)) return "must not be the application's database";
  if (!parsed.pathname.replace(/^\//, "").endsWith("_test")) {
    return "must name a database ending in _test";
  }
  return null;
}

if (url) {
  const why = refusal(url);
  if (why) throw new Error(`SETUPS_TEST_DATABASE_URL ${why}.`);
}

const H = TIMEFRAME_MS.H1;
/** A closed H1 candle boundary every fixture is placed against. */
const T = Date.UTC(2026, 0, 5, 12);

function endingAt(candles: Candle[], lastOpen: number): Candle[] {
  const shift = lastOpen - candles.at(-1)!.openTime;
  return candles.map((c) => ({
    ...c,
    openTime: c.openTime + shift,
    closeTime: c.closeTime + shift,
  }));
}

/** An analysis ending on `lastOpen`, read against the timeframe's canonical higher one. */
function analysis(
  candles: Candle[],
  lastOpen: number,
  timeframe: Timeframe = "H1",
  higher: Candle[] = pullbackIntoSupport(),
) {
  const lower = endingAt(candles, lastOpen);
  return runAnalysis(lower, {
    mtf: analyzeMultiTimeframe({
      lowerCandles: lower,
      higherCandles: higher,
      lowerTimeframe: timeframe,
      higherTimeframe: timeframe === "H1" ? "H4" : "D1",
    }),
  });
}

/** POTENTIAL_SETUP on the 189–192 level. */
const bullish = (at: number, timeframe: Timeframe = "H1") =>
  analysis(pullbackIntoSupport(), at, timeframe);
/** SETUP_FORMING on the 200–204 level, which does not overlap it. */
const elsewhere = (at: number) => analysis(extendedAboveSupport(), at);
/** AVOID: no levels and no confirmation — the invalidation that records no candle. */
const noSetup = (at: number) => analysis(downtrend(), at, "H1", downtrend());

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)("trackSetup on a real database", () => {
  const RUN = `setups-${Date.now()}`;
  let prisma: PrismaClient;
  /** A second pool, for holding locks and reading `pg_locks` as another session. */
  let observer: PrismaClient;
  let makeClient: (datasourceUrl: string) => PrismaClient;
  let trackSetup: typeof import("./setups").trackSetup;
  let userId: string;
  let assetId: string;
  let pairs = 0;

  const keyFor = (tradingPairId: string, timeframe: Timeframe = "H1") =>
    lifecycleLockKey({ userId, tradingPairId, timeframe });

  const track = (
    tradingPairId: string,
    result: ReturnType<typeof analysis>,
    timeframe: Timeframe = "H1",
  ) => trackSetup({ userId, tradingPairId, timeframe, result });

  async function newPair(): Promise<string> {
    pairs += 1;
    const pair = await observer.tradingPair.create({
      data: { assetId, quoteCurrency: `Q${pairs}`, exchangeSymbol: `${RUN}-${pairs}` },
    });
    return pair.id;
  }

  const setupsOf = (tradingPairId: string) =>
    observer.trackedSetup.findMany({
      where: { tradingPairId },
      orderBy: { createdAt: "asc" },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });

  const openCount = (tradingPairId: string) =>
    observer.trackedSetup.count({ where: { tradingPairId, status: { not: "INVALIDATED" } } });

  /** Holds `key`'s lock from another session until released. */
  async function holdLock(key: string, client: PrismaClient = observer) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => (acquired = resolve));
    const done = client.$transaction(
      async (t) => {
        await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await ready;
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }

  /** The backend waiting on an advisory lock, once one is. */
  async function waiter(): Promise<number> {
    for (let i = 0; i < 100; i += 1) {
      const rows = await observer.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      if (rows.length > 0) return rows[0].pid;
      await pause(50);
    }
    throw new Error("No writer started waiting on the lock.");
  }

  /** What the event trigger saw inside the transaction that wrote each event. */
  const probes = (setupIds: string[]) =>
    observer.$queryRaw<
      {
        setup_id: string;
        event_type: string;
        lock_timeout: string;
        idle_timeout: string;
        txid: bigint;
      }[]
    >`SELECT setup_id, event_type, lock_timeout, idle_timeout, txid
        FROM setups_test_probe WHERE setup_id = ANY(${setupIds}) ORDER BY at`;

  const fault = (target: string) =>
    observer.$executeRaw`INSERT INTO setups_test_faults (target) VALUES (${target})`;
  const clearFault = (target: string) =>
    observer.$executeRaw`DELETE FROM setups_test_faults WHERE target = ${target}`;

  const FROZEN = [
    "entryLow",
    "entryHigh",
    "stopLoss",
    "takeProfit1",
    "takeProfit2",
    "takeProfit3",
    "riskReward",
    "riskRewardIsSynthetic",
    "score",
    "scoreGrade",
    "analysisStatus",
    "snapshot",
    "originZoneLow",
    "originZoneHigh",
    "createdAt",
  ] as const;
  const frozen = (row: Record<string, unknown>) =>
    JSON.stringify(FROZEN.map((column) => [column, String(JSON.stringify(row[column]))]));

  beforeAll(async () => {
    // Set before the singleton is constructed: it reads the URL once.
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/db/prisma"));
    ({ trackSetup } = await import("./setups"));
    const { PrismaClient: Client } = await import("@prisma/client");
    makeClient = (datasourceUrl) => new Client({ datasourceUrl });
    observer = makeClient(url!);

    const user = await observer.user.create({ data: { email: `${RUN}@example.test` } });
    userId = user.id;
    const asset = await observer.asset.create({
      data: {
        symbol: `SETUPS${Date.now()}`,
        name: "Setup lifecycle test asset",
        category: "OTHER",
        officialWebsite: "https://example.test",
        description: "Test fixture.",
        utilityExplanation: "Test fixture.",
        riskLevel: "LOW",
      },
    });
    assetId = asset.id;

    // Faults, injected per pair, and a probe recording what each event's own
    // transaction saw. The probe row is written inside that transaction, so it
    // exists only for events that committed.
    for (const statement of [
      `CREATE TABLE IF NOT EXISTS setups_test_faults (target text PRIMARY KEY)`,
      `CREATE TABLE IF NOT EXISTS setups_test_probe (
         setup_id text, event_type text, lock_timeout text, idle_timeout text,
         txid bigint, at timestamptz DEFAULT clock_timestamp())`,
      `CREATE OR REPLACE FUNCTION setups_test_setup_insert() RETURNS trigger AS $$
       BEGIN
         IF EXISTS (SELECT 1 FROM setups_test_faults WHERE target = 'sleep:' || NEW."tradingPairId") THEN
           PERFORM pg_sleep(11);
         END IF;
         IF EXISTS (SELECT 1 FROM setups_test_faults WHERE target = 'create:' || NEW."tradingPairId") THEN
           RAISE EXCEPTION 'injected: setup insert refused';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS setups_test_setup_insert ON "TrackedSetup"`,
      `CREATE TRIGGER setups_test_setup_insert BEFORE INSERT ON "TrackedSetup"
         FOR EACH ROW EXECUTE FUNCTION setups_test_setup_insert()`,
      `CREATE OR REPLACE FUNCTION setups_test_event_insert() RETURNS trigger AS $$
       DECLARE pair text;
       BEGIN
         SELECT "tradingPairId" INTO pair FROM "TrackedSetup" WHERE id = NEW."setupId";
         INSERT INTO setups_test_probe (setup_id, event_type, lock_timeout, idle_timeout, txid)
           VALUES (NEW."setupId", NEW."type"::text, current_setting('lock_timeout'),
                   current_setting('idle_in_transaction_session_timeout'), txid_current());
         IF NEW."type" <> 'CREATED'
            AND EXISTS (SELECT 1 FROM setups_test_faults WHERE target = 'event:' || pair) THEN
           RAISE EXCEPTION 'injected: event insert refused';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
      `DROP TRIGGER IF EXISTS setups_test_event_insert ON "SetupEvent"`,
      `CREATE TRIGGER setups_test_event_insert BEFORE INSERT ON "SetupEvent"
         FOR EACH ROW EXECUTE FUNCTION setups_test_event_insert()`,
    ]) {
      await observer.$executeRawUnsafe(statement);
    }
  });

  afterAll(async () => {
    if (!observer) return;
    await observer.user.deleteMany({ where: { email: `${RUN}@example.test` } });
    await observer.asset.deleteMany({ where: { id: assetId } });
    for (const statement of [
      `DROP TRIGGER IF EXISTS setups_test_event_insert ON "SetupEvent"`,
      `DROP TRIGGER IF EXISTS setups_test_setup_insert ON "TrackedSetup"`,
      `DROP FUNCTION IF EXISTS setups_test_event_insert()`,
      `DROP FUNCTION IF EXISTS setups_test_setup_insert()`,
      `DROP TABLE IF EXISTS setups_test_probe`,
      `DROP TABLE IF EXISTS setups_test_faults`,
    ]) {
      await observer.$executeRawUnsafe(statement);
    }
    await observer.$disconnect();
    await prisma?.$disconnect();
  });

  it("a replacement closes the old setup and creates the new one in one transaction", async () => {
    const pair = await newPair();
    const first = await track(pair, elsewhere(T));
    expect(first.action).toBe("CREATE");
    const before = await observer.trackedSetup.findUniqueOrThrow({ where: { id: first.setupId! } });

    const outcome = await track(pair, bullish(T + H));

    expect(outcome).toMatchObject({ action: "REPLACE", replacedSetupId: first.setupId });
    const [old, fresh] = await setupsOf(pair);
    expect(old.id).toBe(first.setupId);
    expect(old.status).toBe("INVALIDATED");
    expect(old.invalidatedAt).not.toBeNull();
    // 200–204 is above the new analysis's close, so the level failed.
    expect(old.invalidationReason).toMatch(/^Price closed at .*, below this setup's zone /);
    expect(old.events.map((e) => e.type)).toEqual(["CREATED", "INVALIDATED"]);
    // Why it closed, stored beside what confirmation said, which stays readable.
    const payload = old.events[1].payload as { closure?: { cause?: string }; evaluatedAt?: number };
    expect(payload.closure?.cause).toBe("SUPPORT_LOST");
    expect(payload.evaluatedAt).toBeGreaterThan(0);
    expect(frozen(old)).toBe(frozen(before));
    expect(old.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(fresh).toMatchObject({ id: outcome.setupId, status: "POTENTIAL_SETUP" });
    expect(fresh.events.map((e) => e.type)).toEqual(["CREATED"]);
    expect(await openCount(pair)).toBe(1);

    // The outcome names the rows that were written, exactly.
    expect(outcome.events.map((e) => e.eventId)).toEqual([old.events[1].id, fresh.events[0].id]);

    // Both events were written by one transaction, which had its own limits.
    const seen = await probes([old.id, fresh.id]);
    const replacement = seen.filter((p) => p.event_type !== "CREATED" || p.setup_id === fresh.id);
    expect(replacement).toHaveLength(2);
    expect(new Set(replacement.map((p) => String(p.txid))).size).toBe(1);
    for (const probe of seen) {
      expect(probe).toMatchObject({ lock_timeout: "5s", idle_timeout: "30s" });
    }
  });

  it("a nearer support forming above keeps its ordinary reason, and records why", async () => {
    const pair = await newPair();
    const first = await track(pair, bullish(T));

    const outcome = await track(pair, elsewhere(T + H));

    expect(outcome).toMatchObject({ action: "REPLACE", replacedSetupId: first.setupId });
    const [old] = await setupsOf(pair);
    expect(old.invalidationReason).toMatch(/different support zone/);
    const payload = old.events.at(-1)!.payload as { closure?: { cause?: string } };
    expect(payload.closure?.cause).toBe("SUPERSEDED");
  });

  it("a stored closure does not disturb the stale-analysis guard", async () => {
    const pair = await newPair();
    await track(pair, elsewhere(T));
    await track(pair, bullish(T + H));

    // Older than the candle the closing event names, so it may not write.
    const older = await track(pair, elsewhere(T));

    expect(older).toMatchObject({ action: "NONE", cause: "STALE_ANALYSIS" });
    expect(await openCount(pair)).toBe(1);
  });

  it("a creation that fails mid-replacement leaves the old setup exactly as it was", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = await newPair();
    const first = await track(pair, elsewhere(T));
    const before = await setupsOf(pair);

    await fault(`create:${pair}`);
    const outcome = await track(pair, bullish(T + H));
    await clearFault(`create:${pair}`);

    expect(outcome).toMatchObject({ action: "NONE", setupId: null, events: [] });
    expect(await setupsOf(pair)).toEqual(before);
    expect(before[0]).toMatchObject({
      id: first.setupId,
      status: "SETUP_FORMING",
      invalidatedAt: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("nothing was written");
    warn.mockRestore();
  });

  it("an event that fails mid-transition rolls the status back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = await newPair();
    const created = await track(pair, bullish(T));
    // As if it had been seen earlier at WAITING_CONFIRMATION.
    await observer.trackedSetup.update({
      where: { id: created.setupId! },
      data: { status: "WAITING_CONFIRMATION", confirmedAt: null },
    });

    await fault(`event:${pair}`);
    const outcome = await track(pair, bullish(T));
    await clearFault(`event:${pair}`);

    expect(outcome).toMatchObject({ action: "NONE", setupId: null });
    const [setup] = await setupsOf(pair);
    expect(setup).toMatchObject({ status: "WAITING_CONFIRMATION", confirmedAt: null });
    expect(setup.events.map((e) => e.type)).toEqual(["CREATED"]);
    warn.mockRestore();
  });

  it("two concurrent replacements, 50 times: one closes the old setup, the other sees it closed", async () => {
    for (let i = 0; i < 50; i += 1) {
      const pair = await newPair();
      const first = await track(pair, elsewhere(T));

      const outcomes = await Promise.all([
        track(pair, bullish(T + H)),
        track(pair, bullish(T + H)),
      ]);

      expect(outcomes.map((o) => o.action).sort(), `iteration ${i}`).toEqual(["NONE", "REPLACE"]);
      expect(await openCount(pair), `iteration ${i}`).toBe(1);
      const invalidations = await observer.setupEvent.count({
        where: { setupId: first.setupId!, type: "INVALIDATED" },
      });
      expect(invalidations, `iteration ${i}`).toBe(1);
    }
  }, 120_000);

  it("three concurrent creations, 50 times: one setup, one CREATED event", async () => {
    for (let i = 0; i < 50; i += 1) {
      const pair = await newPair();

      const outcomes = await Promise.all([
        track(pair, bullish(T)),
        track(pair, bullish(T)),
        track(pair, bullish(T)),
      ]);

      expect(outcomes.map((o) => o.action).sort(), `iteration ${i}`).toEqual([
        "CREATE",
        "NONE",
        "NONE",
      ]);
      const setups = await setupsOf(pair);
      expect(setups, `iteration ${i}`).toHaveLength(1);
      expect(setups[0].events, `iteration ${i}`).toHaveLength(1);
    }
  }, 120_000);

  it("one writer waits for another on the same key; H1 and H4 do not wait for each other", async () => {
    const pair = await newPair();
    const held = await holdLock(keyFor(pair, "H1"));

    const h1 = track(pair, bullish(T));
    await waiter(); // blocked on the H1 key

    const started = Date.now();
    const h4 = await track(pair, bullish(T, "H4"), "H4");
    expect(h4.action).toBe("CREATE");
    expect(Date.now() - started).toBeLessThan(2_000);

    await held.release();
    expect((await h1).action).toBe("CREATE");
    expect(await openCount(pair)).toBe(2); // one per timeframe
  });

  it("an older analysis can neither move a setup nor touch an invalidated one", async () => {
    const pair = await newPair();
    await track(pair, elsewhere(T + 5 * H));
    const before = await setupsOf(pair);

    const older = await track(pair, bullish(T)); // would have replaced it

    expect(older).toMatchObject({
      action: "NONE",
      setupId: null,
      cause: "STALE_ANALYSIS",
      events: [],
    });
    expect(await setupsOf(pair)).toEqual(before);

    // Replace it with a newer analysis, then bring the old level's candle back.
    await track(pair, bullish(T + 6 * H));
    const afterReplace = await setupsOf(pair);
    const again = await track(pair, elsewhere(T + 5 * H));

    expect(again.cause).toBe("STALE_ANALYSIS");
    expect(await setupsOf(pair)).toEqual(afterReplace);
    expect(afterReplace[0].status).toBe("INVALIDATED");
  });

  it("after an invalidation that recorded no candle, older analyses are refused and the current one admitted", async () => {
    const pair = await newPair();
    await track(pair, elsewhere(T));

    const gone = await track(pair, noSetup(T + H));
    expect(gone).toMatchObject({ action: "TRANSITION", status: "INVALIDATED" });
    const [closed] = await setupsOf(pair);
    expect(closed.events.at(-1)).toMatchObject({ type: "INVALIDATED", payload: null });

    // The newest event that names a candle is older than this one — only the
    // bound from the unstamped invalidation's write time refuses it.
    const stale = await track(pair, bullish(T + 2 * H));
    expect(stale).toMatchObject({ action: "NONE", cause: "STALE_ANALYSIS" });
    expect(await setupsOf(pair)).toHaveLength(1);

    const current = currentCandleOpen("H1", Date.now()) - H;
    expect((await track(pair, bullish(current))).action).toBe("CREATE");
  });

  it("confirmedAt keeps its first value under concurrent confirmations", async () => {
    const pair = await newPair();
    const created = await track(pair, bullish(T));
    await observer.trackedSetup.update({
      where: { id: created.setupId! },
      data: { status: "WAITING_CONFIRMATION", confirmedAt: null },
    });

    const outcomes = await Promise.all([
      track(pair, bullish(T)),
      track(pair, bullish(T)),
      track(pair, bullish(T)),
    ]);
    expect(outcomes.map((o) => o.action).sort()).toEqual(["NONE", "NONE", "TRANSITION"]);

    const [confirmed] = await setupsOf(pair);
    expect(confirmed.events.map((e) => e.type)).toEqual(["CREATED", "POTENTIAL_SETUP"]);
    const first = confirmed.confirmedAt;
    expect(first).not.toBeNull();

    // Loses it and regains it: the first time stands.
    await observer.trackedSetup.update({
      where: { id: created.setupId! },
      data: { status: "WAITING_CONFIRMATION" },
    });
    await pause(20);
    expect((await track(pair, bullish(T))).action).toBe("TRANSITION");
    const [again] = await setupsOf(pair);
    expect(again.confirmedAt).toEqual(first);
  });

  it("a backend terminated mid-transaction rolls back and frees the lock", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = await newPair();
    const held = await holdLock(keyFor(pair));

    const pending = track(pair, bullish(T));
    const pid = await waiter();
    await observer.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;

    const outcome = await pending;
    expect(outcome).toMatchObject({ action: "NONE", setupId: null });
    await held.release();
    expect(await setupsOf(pair)).toEqual([]);

    // The key is free again, and the pool has recovered the lost connection.
    expect((await track(pair, bullish(T))).action).toBe("CREATE");
    warn.mockRestore();
  });

  it("a lock held past its timeout: one retry, then nothing written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = await newPair();
    const held = await holdLock(keyFor(pair));

    const started = Date.now();
    const outcome = await track(pair, bullish(T));
    const elapsed = Date.now() - started;
    await held.release();

    expect(outcome).toMatchObject({ action: "NONE", setupId: null });
    expect(elapsed).toBeGreaterThanOrEqual(9_500); // two 5 s waits: the first try and its retry
    expect(elapsed).toBeLessThan(15_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("(55P03) — nothing was written");
    expect(await setupsOf(pair)).toEqual([]);
    warn.mockRestore();
  }, 30_000);

  it("a write outliving the transaction timeout leaves nothing, and the lock was held throughout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pair = await newPair();
    await fault(`sleep:${pair}`);

    const pending = track(pair, bullish(T));
    await pause(2_000);
    // Mid-write, inside the transaction: its advisory lock is held, not taken
    // and dropped by an autocommit statement.
    const [{ held }] = await observer.$queryRaw<{ held: number }[]>`
      SELECT count(*)::int AS held FROM pg_locks l JOIN pg_stat_activity a USING (pid)
      WHERE l.locktype = 'advisory' AND l.granted AND a.wait_event = 'PgSleep'`;
    expect(held).toBe(1);

    const outcome = await pending;
    await clearFault(`sleep:${pair}`);
    await pause(1_500); // let the sleeping statement finish and roll back

    expect(outcome).toMatchObject({ action: "NONE", setupId: null });
    expect(await setupsOf(pair)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("(P2028) — nothing was written");
    warn.mockRestore();
  }, 30_000);

  it("an idle transaction is ended within 30 s, and its lock with it", async () => {
    const pair = await newPair();
    const key = keyFor(pair);
    const client = makeClient(url!);

    const started = Date.now();
    let ended: unknown = null;
    const idle = client
      .$transaction(
        async (t) => {
          // The statement `trackSetup` issues, then the lock, then nothing.
          await t.$executeRaw`SELECT set_config('lock_timeout', ${"5s"}, true), set_config('idle_in_transaction_session_timeout', ${"30s"}, true)`;
          await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
          await pause(40_000);
          await t.$executeRaw`SELECT 1`;
        },
        { timeout: 60_000 },
      )
      .catch((err: unknown) => (ended = err));

    // Wait until the server has reaped the session and freed the lock.
    let freedAt = 0;
    for (let i = 0; i < 90 && !freedAt; i += 1) {
      await pause(500);
      const [{ held }] = await observer.$queryRaw<{ held: number }[]>`
        SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory' AND granted`;
      if (held === 0) freedAt = Date.now();
    }

    expect(freedAt - started).toBeGreaterThanOrEqual(29_000);
    expect(freedAt - started).toBeLessThan(36_000);
    expect((await track(pair, bullish(T))).action).toBe("CREATE");

    await idle;
    expect(ended).not.toBeNull();
    await client.$disconnect();
  }, 60_000);

  it("both limits are this transaction's only", async () => {
    const single = new URL(url!);
    single.searchParams.set("connection_limit", "1");
    const client = makeClient(single.toString());

    await client.$transaction(async (t) => {
      await t.$executeRaw`SELECT set_config('lock_timeout', ${"5s"}, true), set_config('idle_in_transaction_session_timeout', ${"30s"}, true)`;
      const [inside] = await t.$queryRaw<{ lock: string; idle: string }[]>`
        SELECT current_setting('lock_timeout') AS lock,
               current_setting('idle_in_transaction_session_timeout') AS idle`;
      expect(inside).toEqual({ lock: "5s", idle: "30s" });
    });
    // The same connection — the pool has one — back at the server's defaults.
    const [after] = await client.$queryRaw<{ lock: string; idle: string }[]>`
      SELECT current_setting('lock_timeout') AS lock,
             current_setting('idle_in_transaction_session_timeout') AS idle`;
    expect(after).toEqual({ lock: "0", idle: "0" });
    await client.$disconnect();

    // And every connection `trackSetup`'s own pool hands out afterwards.
    const reads = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          // The sleep holds each connection, so six reads need several of them.
          prisma.$queryRaw<
            { lock: string }[]
          >`SELECT current_setting('lock_timeout') AS lock FROM pg_sleep(0.05)`,
      ),
    );
    expect(new Set(reads.map(([row]) => row.lock))).toEqual(new Set(["0"]));
  });

  it("every setup written here has a coherent history", async () => {
    const setups = await observer.trackedSetup.findMany({
      where: { userId },
      include: { events: { orderBy: { createdAt: "asc" } } },
    });
    expect(setups.length).toBeGreaterThan(100);

    for (const setup of setups) {
      expect(setup.events[0]?.type, setup.id).toBe("CREATED");
      const invalidated = setup.events.findIndex((e) => e.type === "INVALIDATED");
      if (invalidated !== -1) expect(invalidated, setup.id).toBe(setup.events.length - 1);
      expect(setup.status === "INVALIDATED", setup.id).toBe(setup.invalidatedAt !== null);
    }

    const keys = await observer.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "TrackedSetup" WHERE "userId" = ${userId} AND status <> 'INVALIDATED'
        GROUP BY "tradingPairId", timeframe HAVING count(*) > 1) duplicated`;
    expect(keys[0].n).toBe(0);
  });
});
