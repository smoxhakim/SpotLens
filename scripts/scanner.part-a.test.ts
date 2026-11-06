// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Timeframe } from "@/lib/market-data/provider";
import { latestScanWindow } from "@/lib/scanner/schedule";

/**
 * The scanner *script* — `scripts/scanner.ts` itself, imported and run — on a
 * fake clock.
 *
 * Every wait the script makes goes through `sleep`, which is replaced by one
 * that records the wait instead of setting a timer; the test decides when it
 * ends, and can move the clock past it first to stand in for a laptop asleep.
 * The real `sleepUntil` runs on top of it, so its steps are waits like any other.
 * `runScan` is scripted per pass. The real schedule, retry, catch-up, signal
 * and shutdown code runs unchanged. No exchange, no database, no Telegram, no
 * lock files: those are the services the script calls, and they are faked at
 * that boundary.
 */

// --- the clock, and every wait -----------------------------------------------

interface Wait {
  due: number;
  ms: number;
  end: () => void;
}
const waits: Wait[] = [];

function fakeSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const wait: Wait = {
      due: Date.now() + Math.max(0, ms),
      ms,
      end: () => {
        const i = waits.indexOf(wait);
        if (i === -1) return;
        waits.splice(i, 1);
        resolve();
      },
    };
    waits.push(wait);
    signal?.addEventListener("abort", () => wait.end(), { once: true });
  });
}

// --- the services the script calls -------------------------------------------

type Kind =
  | "COMPLETED"
  | "PARTIAL"
  | "TRANSIENT"
  | "PERMANENT"
  | "THROW_DB"
  | "DB_TRANSIENT"
  | "DB_PERMANENT"
  | "DB_MIXED"
  | "SAVE_TRANSIENT"
  | "SAVE_PERMANENT"
  | "EMPTY"
  | "THROW_DB_PERMANENT"
  | "THROW_BUG";
const order: string[] = [];
const closeResults = new Map<string, "CLOSED" | "ALREADY_FINAL" | "FAILED">();
const closeUnfinishedRun = vi.fn(async (id: string) => {
  order.push(`close:${id}`);
  return closeResults.get(id) ?? ("CLOSED" as const);
});

interface Pass {
  at: number;
  timeframes: Timeframe[];
  triggeredBy: string;
}

const passes: Pass[] = [];
/** A delivery step that throws, for the log lines that report it. */
const failDelivery: { notify?: Error; confirm?: Error; report?: Error; daily?: Error } = {};
let inFlight = 0;
let maxInFlight = 0;
let passMs = 60_000;
let kindOf: (index: number) => Kind = () => "COMPLETED";
let extraObservations: unknown[] = [];

const MARKETS = ["BTCUSDT", "ETHUSDT"];

function dbFailed(symbol: string, timeframe: string, cls: "TRANSIENT" | "PERMANENT", code: string) {
  return {
    symbol,
    timeframe,
    ok: false,
    failure: {
      category: "DATABASE_ERROR",
      code,
      message: `Database error ${code}`,
      retryable: cls === "TRANSIENT",
      database: cls,
    },
  };
}

function special(kind: string, timeframes: Timeframe[]) {
  const runId = `run-${passes.length}`;
  const ok = (symbol: string, tf: string) => ({ symbol, timeframe: tf, ok: true, failure: null });
  const base = {
    runId,
    status: "FAILED",
    interrupted: false,
    potentialSetups: 0,
    waiting: 0,
    highRisk: 0,
    avoided: 0,
    setupsCreated: 0,
    stateChanges: 0,
    invalidations: 0,
    events: [],
    observations: [],
    breakdown: [],
    shortlist: {
      totalEligible: 0,
      totalAnalysed: 0,
      excluded: {
        AVOID: 0,
        HIGH_RISK: 0,
        NO_LEVELS: 0,
        BELOW_QUALITY_BAR: 0,
        REWARD_NOT_MEASURED: 0,
        FAILED: 0,
      },
      top5: [],
    },
    timeframes,
  };
  const counts = (results: { ok: boolean }[]) => ({
    results,
    analysed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
  const each = (fn: (tf: string) => unknown[]) =>
    timeframes.flatMap((tf) => fn(tf)) as { ok: boolean }[];
  if (kind === "DB_TRANSIENT")
    return {
      ...base,
      ...counts(each((tf) => [ok("BTCUSDT", tf), dbFailed("ETHUSDT", tf, "TRANSIENT", "P1017")])),
    };
  if (kind === "DB_PERMANENT")
    return {
      ...base,
      ...counts(each((tf) => [ok("BTCUSDT", tf), dbFailed("ETHUSDT", tf, "PERMANENT", "P2003")])),
    };
  if (kind === "DB_MIXED")
    return {
      ...base,
      ...counts(
        each((tf) => [
          dbFailed("BTCUSDT", tf, "TRANSIENT", "P1017"),
          dbFailed("ETHUSDT", tf, "PERMANENT", "P2003"),
        ]),
      ),
    };
  if (kind === "SAVE_TRANSIENT" || kind === "SAVE_PERMANENT") {
    return {
      ...base,
      ...counts(each((tf) => [ok("BTCUSDT", tf), ok("ETHUSDT", tf)])),
      runId: null,
      unfinishedRunId: runId,
      saveFailure: {
        code: kind === "SAVE_TRANSIENT" ? "P1017" : "P2022",
        class: kind === "SAVE_TRANSIENT" ? "TRANSIENT" : "PERMANENT",
      },
    };
  }
  if (kind === "DB_PERMANENT_PARTIAL")
    return {
      ...base,
      status: "PARTIAL",
      ...counts(each((tf) => [ok("BTCUSDT", tf), dbFailed("ETHUSDT", tf, "PERMANENT", "P2003")])),
    };
  return { ...base, ...counts([]), emptyUniverse: true };
}

function summary(kind: Exclude<Kind, "THROW_DB">, interrupted = false) {
  const failed = (retryable: boolean) => ({
    ok: false,
    failure: { category: "MARKET_DATA_ERROR", message: "timeout", retryable },
  });
  const results = MARKETS.map((symbol, i) => ({
    symbol,
    timeframe: "H1",
    ...(interrupted
      ? failed(false)
      : kind === "COMPLETED" || (kind === "PARTIAL" && i === 0)
        ? { ok: true, failure: null }
        : failed(kind !== "PERMANENT")),
  }));
  const status = interrupted
    ? "FAILED"
    : kind === "COMPLETED"
      ? "COMPLETED"
      : kind === "PARTIAL"
        ? "PARTIAL"
        : "FAILED";
  return {
    runId: `run-${passes.length}`,
    status,
    interrupted,
    results,
    analysed: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    potentialSetups: 0,
    waiting: 0,
    highRisk: 0,
    avoided: 0,
    setupsCreated: 0,
    stateChanges: 0,
    invalidations: 0,
    // What the real pass emits for each failed market: one ANALYSIS_FAILED.
    events: results
      .filter((r) => !r.ok)
      .map((r) => ({
        type: "ANALYSIS_FAILED",
        symbol: r.symbol,
        timeframe: "H1",
        setupId: null,
        lifecycleStatus: null,
        failureCategory: "MARKET_DATA_ERROR",
        detail: "timeout",
      })),
    observations: extraObservations,
    breakdown: [],
    shortlist: {
      totalEligible: 0,
      totalAnalysed: results.length,
      excluded: {
        AVOID: 0,
        HIGH_RISK: 0,
        NO_LEVELS: 0,
        BELOW_QUALITY_BAR: 0,
        REWARD_NOT_MEASURED: 0,
        FAILED: 0,
      },
      top5: [],
    },
  };
}

const runScan = vi.fn(
  async (opts: { timeframes: Timeframe[]; triggeredBy: string; signal: AbortSignal }) => {
    const index = passes.length;
    passes.push({ at: Date.now(), timeframes: opts.timeframes, triggeredBy: opts.triggeredBy });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const kind = kindOf(index);
      order.push(`pass:${index}`);
      if (kind === "THROW_DB") {
        throw Object.assign(new Error("Can't reach database server at `db:5432`"), {
          errorCode: "P1001",
        });
      }
      if (kind === "THROW_DB_PERMANENT") {
        throw Object.assign(
          new Error("postgresql://user:hunter2@db.internal:5432/x failed at /Users/me/app"),
          { name: "PrismaClientInitializationError" },
        );
      }
      if (kind === "THROW_BUG")
        throw new TypeError(
          "Cannot read properties of undefined (postgresql://user:hunter2@db.internal)",
        );
      await fakeSleep(passMs, opts.signal); // the pass takes time, unless stopped
      if (
        [
          "DB_TRANSIENT",
          "DB_PERMANENT",
          "DB_MIXED",
          "SAVE_TRANSIENT",
          "SAVE_PERMANENT",
          "EMPTY",
          "DB_PERMANENT_PARTIAL",
        ].includes(kind) &&
        !opts.signal.aborted
      )
        return special(kind, opts.timeframes);
      return summary(kind as never, opts.signal.aborted);
    } finally {
      inFlight -= 1;
    }
  },
);

const lastSuccessfulPassStartedAt = vi.fn(async (): Promise<Date | null> => null);
const closeAbandonedRuns = vi.fn(async () => 0);
const resolveScannerUser = vi.fn(async () => ({ ok: true as const, userId: "user-1" }));

vi.mock("@/services/scanner", () => ({
  DEFAULT_MAX_CONCURRENCY: 4,
  runScan: (o: never) => runScan(o),
  lastSuccessfulPassStartedAt: () => lastSuccessfulPassStartedAt(),
  closeAbandonedRuns: () => closeAbandonedRuns(),
  closeUnfinishedRun: (id: string) => closeUnfinishedRun(id),
  resolveScannerUser: () => resolveScannerUser(),
  describeScannerUserFailure: () => "no owner",
}));

/** The notification table's unique index, as far as delivery is concerned. */
const delivered = new Set<string>();
const deliveries = { created: 0, duplicates: 0 };
vi.mock("@/services/notifications", () => ({
  deliverEvents: async (events: { dedupeKey: string }[]) => {
    let created = 0;
    let duplicates = 0;
    for (const e of events) {
      if (delivered.has(e.dedupeKey)) duplicates += 1;
      else {
        delivered.add(e.dedupeKey);
        created += 1;
      }
    }
    deliveries.created += created;
    deliveries.duplicates += duplicates;
    return { created, sent: created, failed: 0, suppressed: 0, duplicates, telegramWithheld: 0 };
  },
}));
// The real event mapping — failures become SYSTEM_ERROR with their real dedupe
// keys — but no daily summary, which would read the database.
vi.mock("@/services/notification-events", async () => {
  const actual = await vi.importActual<typeof import("@/services/notification-events")>(
    "@/services/notification-events",
  );
  return {
    ...actual,
    eventsFromScan: (input: never) => {
      if (failDelivery.notify) throw failDelivery.notify;
      return actual.eventsFromScan(input);
    },
    buildDailySummary: async () => {
      if (failDelivery.daily) throw failDelivery.daily;
      return null;
    },
  };
});
vi.mock("@/services/confirmation-alerts", () => ({
  deliverConfirmationAlerts: vi.fn(async () => {
    if (failDelivery.confirm) throw failDelivery.confirm;
    return {};
  }),
}));
vi.mock("@/services/scan-report", () => ({
  deliverScanReport: vi.fn(async () => {
    if (failDelivery.report) throw failDelivery.report;
    return { status: "SKIPPED", reason: "REPORT_OFF" };
  }),
}));

const disconnect = vi.fn(async () => undefined);
vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: { $disconnect: () => disconnect() },
}));

const holdLockOrExit = vi.fn();
vi.mock("@/lib/engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/engine")>("@/lib/engine");
  return {
    ...actual,
    holdLockOrExit: (...a: unknown[]) => holdLockOrExit(...a),
    stopWhenEngineGone: () => false,
  };
});
vi.mock("@/lib/scanner", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scanner")>("@/lib/scanner");
  return {
    ...actual,
    sleep: (ms: number, signal?: AbortSignal) => fakeSleep(ms, signal),
    sleepUntil: (wakeAt: number, signal?: AbortSignal) =>
      actual.sleepUntil(wakeAt, signal, fakeSleep),
  };
});

// --- driving the script ------------------------------------------------------

const DELAY = 90_000;
const MIN = 60_000;
const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 20, h, m, s);
const logs: string[] = [];
let originalArgv: string[];
let signalListeners: Record<"SIGINT" | "SIGTERM", Function[]>;
let originalExitCode: typeof process.exitCode;

async function flush() {
  for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
}

/** Starts the real script at `now`. */
async function start(now: number, flags: string[] = []) {
  vi.setSystemTime(now);
  process.argv = [...originalArgv.slice(0, 2), "scripts/scanner.ts", ...flags];
  vi.resetModules();
  await import("./scanner");
  process.argv = originalArgv;
  await flush();
}

/**
 * Lets the script run until `t`: each wait that falls due by then ends at its
 * due time, in order. Fails on two waits at once (overlapping work) or on a
 * wake storm (a busy loop).
 */
async function runUntil(t: number) {
  for (let wakes = 0; wakes < 5_000; wakes += 1) {
    await flush();
    expect(waits.length).toBeLessThanOrEqual(1);
    const next = waits[0];
    if (!next || next.due > t) {
      vi.setSystemTime(Math.max(Date.now(), t));
      await flush();
      return;
    }
    vi.setSystemTime(Math.max(Date.now(), next.due));
    next.end();
  }
  throw new Error("busy loop: thousands of wakes");
}

/** The lid is shut: the clock moves to `t` and the pending wait has not ended. */
function lidShutUntil(t: number) {
  vi.setSystemTime(t);
}

async function stop() {
  process.emit("SIGINT");
  await flush();
}

const passTimes = () => passes.map((p) => new Date(p.at).toISOString().slice(11, 19));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  signalListeners = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM"),
  };
  waits.length = 0;
  passes.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  passMs = 60_000;
  kindOf = () => "COMPLETED";
  extraObservations = [];
  delivered.clear();
  deliveries.created = 0;
  deliveries.duplicates = 0;
  logs.length = 0;
  order.length = 0;
  closeResults.clear();
  for (const key of Object.keys(failDelivery))
    delete failDelivery[key as keyof typeof failDelivery];
  vi.clearAllMocks();
  lastSuccessfulPassStartedAt.mockResolvedValue(new Date(Date.UTC(2099, 0, 1))); // no catch-up
  resolveScannerUser.mockReset().mockResolvedValue({ ok: true as const, userId: "user-1" });
  vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  if (process.send) vi.spyOn(process, "send").mockImplementation(() => true);
});

afterEach(async () => {
  // Whatever a test left running is stopped, and the script's signal handlers go.
  if (disconnect.mock.calls.length === 0) await stop();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const l of process.listeners(signal)) {
      if (!signalListeners[signal].includes(l)) process.removeListener(signal, l as never);
    }
  }
  process.exitCode = originalExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- Part A, against the real script --------------------------------------------

/** Stops the running script and removes it, so the next `start` is a new process. */
async function restart() {
  if (disconnect.mock.calls.length === 0) await stop();
  await runUntil(Date.now() + 2 * 3_600_000);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const l of process.listeners(signal)) {
      if (!signalListeners[signal].includes(l)) process.removeListener(signal, l as never);
    }
  }
  passes.length = 0;
  order.length = 0;
  logs.length = 0;
  waits.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  disconnect.mockClear();
  closeUnfinishedRun.mockClear();
}
const HMS = (t: number) => new Date(t).toISOString().slice(11, 19);
const FAILING: Kind[] = ["DB_TRANSIENT", "SAVE_TRANSIENT", "TRANSIENT"];

describe("retry delays through the real loop", () => {
  for (const kind of FAILING) {
    it(`${kind}: 1, 2, 5 and 10 min after each failure ends, then the next window`, async () => {
      kindOf = () => kind;
      passMs = 10_000;
      await start(at(11, 30));
      await runUntil(at(13, 30));
      expect(passTimes()).toEqual([
        "12:01:30",
        "12:02:40",
        "12:04:50",
        "12:10:00",
        "12:20:10",
        "13:01:30",
        "13:02:40",
        "13:04:50",
        "13:10:00",
        "13:20:10",
      ]);
      expect(maxInFlight).toBe(1);
    });
  }

  it("THROW_DB: the same delays, measured from the throw", async () => {
    kindOf = () => "THROW_DB";
    await start(at(11, 30));
    await runUntil(at(12, 30));
    expect(passTimes()).toEqual(["12:01:30", "12:02:30", "12:04:30", "12:09:30", "12:19:30"]);
  });

  it("a retry that succeeds ends the series; attempts start again at the next failure", async () => {
    kindOf = (i) => (i === 0 || i === 2 ? "DB_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(13, 30));
    expect(passTimes()).toEqual(["12:01:30", "12:02:40", "13:01:30", "13:02:40"]);
  });

  it("blocked: no retry at all, one attempt each window", async () => {
    for (const kind of [
      "DB_PERMANENT",
      "DB_MIXED",
      "SAVE_PERMANENT",
      "EMPTY",
      "THROW_DB_PERMANENT",
      "THROW_BUG",
    ] as Kind[]) {
      await start(at(11, 30));
      await restart();
      kindOf = () => kind;
      passMs = 10_000;
      await start(at(11, 30));
      await runUntil(at(14, 30));
      expect([kind, passTimes()]).toEqual([kind, ["12:01:30", "13:01:30", "14:01:30"]]);
    }
  });
});

describe("permanent is checked before the status", () => {
  it("even a summary saying PARTIAL is blocked when a market has a permanent database failure", async () => {
    kindOf = () => "DB_PERMANENT_PARTIAL" as Kind;
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(13, 30));
    expect(passTimes()).toEqual(["12:01:30", "13:01:30"]);
    expect(passes.every((p) => p.timeframes.join("+") === "H1+H4")).toBe(true);
    expect(logs.join("\n")).toContain("PASS BLOCKED");
  });
});

describe("the candle settle delay before a retry", () => {
  /** Catch-up at `t`, instant passes: retries land at t+1, t+3, t+8 and t+18 min. */
  async function catchUpFailingFrom(t: number, kind: Kind, succeedAt: number) {
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    kindOf = (i) => (i >= succeedAt ? "COMPLETED" : kind);
    passMs = 0;
    await start(t, ["--catch-up"]);
  }

  it("a retry due 30 s after a close waits for the settle window, never reading the unsettled candle", async () => {
    await catchUpFailingFrom(at(12, 42, 30), "DB_TRANSIENT", 4);
    await runUntil(at(14, 30));
    expect(passTimes()).toEqual([
      "12:42:30",
      "12:43:30",
      "12:45:30",
      "12:50:30",
      "13:01:30",
      "14:01:30",
    ]);
    expect(logs.some((l) => l.includes("Waiting 60s for it to settle"))).toBe(true);
  });

  it("a retry due exactly on a close waits the whole settle delay", async () => {
    await catchUpFailingFrom(at(12, 42), "DB_TRANSIENT", 4);
    await runUntil(at(13, 30));
    expect(passTimes().at(-1)).toBe("13:01:30");
    expect(logs.some((l) => l.includes("Waiting 90s for it to settle"))).toBe(true);
  });

  it("the settled retry covers the new window once: it is not repeated at the window", async () => {
    await catchUpFailingFrom(at(12, 42, 30), "DB_TRANSIENT", 4);
    await runUntil(at(13, 30));
    expect(passTimes().filter((t) => t.startsWith("13:"))).toEqual(["13:01:30"]);
  });

  it("a retry outside any settle period does not wait", async () => {
    kindOf = (i) => (i === 0 ? "DB_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 30));
    expect(passTimes()[1]).toBe("12:02:40");
    expect(logs.some((l) => l.includes("for it to settle"))).toBe(false);
  });

  it("a late wake inside a settle period waits too", async () => {
    kindOf = () => "COMPLETED";
    await start(at(10, 2));
    lidShutUntil(at(13, 0, 30));
    await runUntil(at(13, 30));
    // H4's 12:00 close was slept through, so it comes too.
    expect(passTimes()).toEqual(["13:01:30"]);
    expect(passes[0].timeframes).toEqual(["H1", "H4"]);
  });

  it("Ctrl-C during the settle wait: no pass", async () => {
    await catchUpFailingFrom(at(12, 42, 30), "DB_TRANSIENT", 4);
    await runUntil(at(13, 0, 40));
    expect(passes.length).toBe(4);
    await stop();
    await runUntil(at(13, 30));
    expect(passes.length).toBe(4);
  });
});

describe("no overlapping passes", () => {
  it("failing passes that run past their retry and past the next window never overlap", async () => {
    kindOf = (i) => (i < 3 ? "DB_TRANSIENT" : "COMPLETED");
    passMs = 70 * MIN;
    await start(at(11, 30));
    await runUntil(at(17, 30));
    expect(maxInFlight).toBe(1);
    for (let i = 1; i < passes.length; i += 1)
      expect(passes[i].at).toBeGreaterThanOrEqual(passes[i - 1].at + 70 * MIN);
  });

  it("over seeded outcome and duration sequences: never two at once", async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      await seededRun(seed);
      expect(maxInFlight).toBe(1);
    }
  }, 180_000);
});

/** A small seeded PRNG, so the run is the same every time. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = 10;
const COVERS = new Set<Kind>(["COMPLETED", "PARTIAL", "PERMANENT"]);
const OPEN = new Set<Kind>([
  "DB_TRANSIENT",
  "SAVE_TRANSIENT",
  "TRANSIENT",
  "DB_PERMANENT",
  "DB_MIXED",
  "SAVE_PERMANENT",
  "EMPTY",
  "THROW_DB",
  "THROW_DB_PERMANENT",
  "THROW_BUG",
]);
let drawn: Kind[] = [];

async function seededRun(seed: number) {
  if (seed > 1) await restart();
  const random = rng(seed);
  const kinds: Kind[] = ["COMPLETED", "COMPLETED", "COMPLETED", "PARTIAL", "PERMANENT", ...OPEN];
  drawn = [];
  kindOf = (i) => {
    passMs = (1 + Math.floor(random() * 90)) * 1_000;
    drawn[i] = kinds[Math.floor(random() * kinds.length)];
    return drawn[i];
  };
  await start(at(11, 30));
  await runUntil(at(22, 30));
}

describe("no duplicate window coverage", () => {
  it("over seeded sequences: no covered window is scanned again, and no window is skipped", async () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      await seededRun(seed);
      const covered: Partial<Record<Timeframe, number>> = {
        H1: latestScanWindow("H1", at(11, 30)),
        H4: latestScanWindow("H4", at(11, 30)),
      };
      let lastCovering = -1;
      passes.forEach((p, i) => {
        for (const tf of p.timeframes) {
          const window = latestScanWindow(tf, p.at);
          // A pass on a timeframe always has a newer window than what is covered.
          expect(window, `seed ${seed} pass ${i} ${HMS(p.at)} ${tf}`).toBeGreaterThan(covered[tf]!);
        }
        for (const tf of ["H1", "H4"] as Timeframe[]) {
          // Every timeframe with a newer settled window is in the pass: none is skipped.
          if (latestScanWindow(tf, p.at) > covered[tf]!)
            expect(p.timeframes, `seed ${seed} pass ${i} missed ${tf}`).toContain(tf);
        }
        if (COVERS.has(drawn[i])) {
          for (const tf of p.timeframes) covered[tf] = latestScanWindow(tf, p.at);
          lastCovering = i;
        }
      });
      void lastCovering;
    }
  }, 180_000);

  it("over seeded sequences: after a blocked pass the next attempt is at a window; after a transient failure, at a delay", async () => {
    const BLOCKED = new Set<Kind>([
      "DB_PERMANENT",
      "DB_MIXED",
      "SAVE_PERMANENT",
      "EMPTY",
      "THROW_DB_PERMANENT",
      "THROW_BUG",
    ]);
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      await seededRun(seed);
      const perHour = new Map<number, number>();
      passes.forEach((p, i) => {
        const h = Math.floor(p.at / 3_600_000);
        perHour.set(h, (perHour.get(h) ?? 0) + 1);
        if (i === passes.length - 1) return;
        const next = passes[i + 1].at;
        if (BLOCKED.has(drawn[i]))
          expect(next % 3_600_000, `seed ${seed} after pass ${i} ${drawn[i]}`).toBe(DELAY);
      });
      expect(Math.max(...perHour.values())).toBeLessThanOrEqual(5);
    }
  }, 180_000);

  it("a success followed by nothing new: exactly one pass per window", async () => {
    await start(at(11, 30));
    await runUntil(at(17, 30));
    expect(passTimes()).toEqual([
      "12:01:30",
      "13:01:30",
      "14:01:30",
      "15:01:30",
      "16:01:30",
      "17:01:30",
    ]);
  });
});

describe("H4 catch-up", () => {
  const seq = () => passes.map((p) => [HMS(p.at), p.timeframes.join("+")]);

  it("blocked at an H4 close: H4 is rescanned with H1 each window until a pass succeeds, then not again until its next close", async () => {
    kindOf = (i) => (i < 2 ? "DB_PERMANENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(16, 30));
    expect(seq()).toEqual([
      ["12:01:30", "H1+H4"],
      ["13:01:30", "H1+H4"],
      ["14:01:30", "H1+H4"],
      ["15:01:30", "H1"],
      ["16:01:30", "H1+H4"],
    ]);
  });

  it("transient at an H4 close: the retry covers H1 and H4, and the next hour is H1 alone", async () => {
    kindOf = (i) => (i === 0 ? "SAVE_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(13, 30));
    expect(seq()).toEqual([
      ["12:01:30", "H1+H4"],
      ["12:02:40", "H1+H4"],
      ["13:01:30", "H1"],
    ]);
  });

  it("--catch-up blocked at startup: H1 and H4 stay uncovered and the next window takes both", async () => {
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    kindOf = (i) => (i === 0 ? "DB_PERMANENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(13, 20), ["--catch-up"]);
    await runUntil(at(15, 30));
    expect(seq()).toEqual([
      ["13:20:00", "H1+H4"],
      ["14:01:30", "H1+H4"],
      ["15:01:30", "H1"],
    ]);
  });

  it("--catch-up transient at startup: retried, covering both", async () => {
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    kindOf = (i) => (i === 0 ? "DB_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(13, 20), ["--catch-up"]);
    await runUntil(at(14, 30));
    expect(seq()).toEqual([
      ["13:20:00", "H1+H4"],
      ["13:21:10", "H1+H4"],
      ["14:01:30", "H1"],
    ]);
  });

  it("--catch-up that succeeds: the next window is H1 alone, as before", async () => {
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    passMs = 10_000;
    await start(at(13, 20), ["--catch-up"]);
    await runUntil(at(14, 30));
    expect(seq()).toEqual([
      ["13:20:00", "H1+H4"],
      ["14:01:30", "H1"],
    ]);
  });

  it("lid shut through an H4 close, blocked on waking: the next window still takes H4", async () => {
    kindOf = (i) => (i === 0 ? "DB_PERMANENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    lidShutUntil(at(12, 40));
    await runUntil(at(14, 30));
    expect(seq()).toEqual([
      ["12:40:00", "H1+H4"],
      ["13:01:30", "H1+H4"],
      ["14:01:30", "H1"],
    ]);
  });

  it("exchange-only permanent failure at an H4 close: covered, unchanged", async () => {
    kindOf = (i) => (i === 0 ? "PERMANENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(13, 30));
    expect(seq()).toEqual([
      ["12:01:30", "H1+H4"],
      ["13:01:30", "H1"],
    ]);
  });
});

describe("closing only this process's unfinished runs", () => {
  it("a run this process could not save is closed before its next pass, by that id", async () => {
    kindOf = (i) => (i === 0 ? "SAVE_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 30));
    expect(closeUnfinishedRun.mock.calls).toEqual([["run-1"]]);
    expect(order).toEqual(["pass:0", "close:run-1", "pass:1"]);
  });

  it("nothing else is ever passed to it: no pass of its own unsaved, no close at all", async () => {
    kindOf = (i) => (i % 2 === 0 ? "DB_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(15, 30));
    expect(closeUnfinishedRun).not.toHaveBeenCalled();
  });

  it("a stuck run from before this process started is not in its hands: only the age-gated sweep can close it", async () => {
    kindOf = () => "COMPLETED";
    await start(at(11, 30));
    await runUntil(at(13, 30));
    expect(closeUnfinishedRun).not.toHaveBeenCalled();
    expect(closeAbandonedRuns).toHaveBeenCalled();
  });

  it("several unsaved runs across an outage are each closed once, in order", async () => {
    kindOf = (i) => (i < 3 ? "SAVE_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 30));
    expect(order).toEqual([
      "pass:0",
      "close:run-1",
      "pass:1",
      "close:run-2",
      "pass:2",
      "close:run-3",
      "pass:3",
    ]);
  });

  it("a close that fails never blocks the pass, and is tried again before the next", async () => {
    kindOf = (i) => (i === 0 ? "SAVE_TRANSIENT" : "COMPLETED");
    closeResults.set("run-1", "FAILED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(13, 30));
    expect(order).toEqual(["pass:0", "close:run-1", "pass:1", "close:run-1", "pass:2"]);
  });

  it("a save that had landed (guard moved nothing) is forgotten, not retried", async () => {
    kindOf = (i) => (i === 0 ? "SAVE_TRANSIENT" : "COMPLETED");
    closeResults.set("run-1", "ALREADY_FINAL");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(13, 30));
    expect(closeUnfinishedRun).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.includes("Closed this scanner's unfinished run"))).toBe(false);
  });

  it("a stop during the retry wait closes it too, rather than leaving it for the 3-hour sweep", async () => {
    kindOf = () => "SAVE_TRANSIENT";
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 1, 50)); // the pass ended at 12:01:40; its retry is at 12:02:40
    expect(order).toEqual(["pass:0"]);

    await stop();
    await runUntil(at(12, 5));
    expect(order).toEqual(["pass:0", "close:run-1"]);
    expect(passes).toHaveLength(1);
  });

  it("--once closes its own before exiting", async () => {
    kindOf = () => "SAVE_PERMANENT";
    passMs = 10_000;
    await start(at(10, 20), ["--once"]);
    await runUntil(at(10, 25));
    expect(order).toEqual(["pass:0", "close:run-1"]);
  });
});

describe("the four delivery log lines, through the real script", () => {
  /** A real Prisma message names the host, and a URL may carry a password. */
  const hostile = () =>
    Object.assign(
      new Error(
        "Can't reach database server at `db.internal:5432` postgresql://user:hunter2@db.internal/x",
      ),
      { code: "P1001" },
    );

  it.each([
    ["notify", "notifications skipped"],
    ["confirm", "confirmation alerts skipped"],
    ["report", "1h scan report skipped"],
    ["daily", "daily summary skipped"],
  ] as const)(
    "%s failing: says what kind of failure, never the error's own text",
    async (step, line) => {
      failDelivery[step] = hostile();
      extraObservations = [{ trackedSetupId: "setup-1" }];
      passMs = 10_000;
      await start(at(10, 20), ["--once"]);
      await runUntil(at(10, 25));

      const text = logs.join("\n");
      expect(text).toContain(`${line}: Database error P1001`);
      expect(text).not.toMatch(/hunter2|db\.internal|postgresql:/);
      // A delivery failure is not a pass failure: this pass stored what it found.
      expect(process.exitCode).not.toBe(1);
    },
  );
});

describe("scanner:once", () => {
  const CASES: [Kind, number | undefined][] = [
    ["COMPLETED", undefined],
    ["PARTIAL", undefined],
    ["TRANSIENT", 1],
    ["PERMANENT", 1],
    ["DB_TRANSIENT", 1],
    ["DB_PERMANENT", 1],
    ["DB_MIXED", 1],
    ["SAVE_TRANSIENT", 1],
    ["SAVE_PERMANENT", 1],
    ["EMPTY", 1],
    ["THROW_DB", 1],
    ["THROW_DB_PERMANENT", 1],
    ["THROW_BUG", 1],
  ];
  for (const [kind, code] of CASES) {
    it(`${kind}: one pass, no retry, exit code ${code ?? 0}`, async () => {
      kindOf = () => kind;
      process.exitCode = undefined;
      passMs = 10_000;
      await start(at(10, 20), ["--once"]);
      await runUntil(at(11, 30));
      expect(passes.length).toBe(1);
      expect(process.exitCode).toBe(code);
      expect(disconnect).toHaveBeenCalled();
    });
  }

  it("stopped mid-pass: exit code 1", async () => {
    passMs = 60_000;
    process.exitCode = undefined;
    await start(at(10, 20), ["--once"]);
    await stop();
    await flush();
    await runUntil(at(10, 25));
    expect(passes.length).toBe(1);
    expect(process.exitCode).toBe(1);
    expect(disconnect).toHaveBeenCalled();
  });
});

describe("the blocked-pass summary, through the real script", () => {
  const joined = () => logs.join("\n");

  it("permanent on one market: market, timeframe, code, counts, class and next step are all there", async () => {
    kindOf = () => "DB_PERMANENT";
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 10));
    const text = joined();
    expect(text).toContain("PASS BLOCKED: H1, H4: 2 succeeded, 2 failed, of 4.");
    expect(text).toContain("H1 DATABASE_ERROR P2003 permanent: ETHUSDT");
    expect(text).toContain("H4 DATABASE_ERROR P2003 permanent: ETHUSDT");
    expect(text).toContain(
      "Next: H1, H4 will not retry. They stay uncovered and wait for the next scheduled window at 2026-10-20T13:01:30.000Z.",
    );
    expect(text).toContain("Action: A write was refused.");
  });

  it("transient says it will retry, and when", async () => {
    kindOf = () => "DB_TRANSIENT";
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 2));
    expect(joined()).toContain("Next: H1, H4 will retry in 1 min (retry 1 of 4).");
  });

  it("a results save failure names every market in the pass and says the commits stand", async () => {
    kindOf = () => "SAVE_PERMANENT";
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 10));
    expect(joined()).toContain(
      "results not saved: DATABASE_ERROR P2022 permanent: every market in this pass.",
    );
    expect(joined()).toContain("pending migration");
  });

  it("zero markets says so, and what to check", async () => {
    kindOf = () => "EMPTY";
    await start(at(11, 30));
    await runUntil(at(12, 10));
    expect(joined()).toContain("no active markets to scan");
    expect(joined()).toContain("Check the seed");
  });

  it("no connection string, password, host or path reaches the log from a thrown error", async () => {
    for (const kind of ["THROW_DB_PERMANENT", "THROW_BUG"] as Kind[]) {
      kindOf = () => kind;
      await start(at(11, 30));
      await runUntil(at(12, 10));
      const text = joined();
      expect(text).toContain("PASS BLOCKED");
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("db.internal");
      expect(text).not.toContain("/Users/me");
      expect(text).not.toContain("postgresql://");
      await restart();
    }
  });

  it("a successful pass prints no summary, a PARTIAL one included", async () => {
    kindOf = (i) => (i === 0 ? "COMPLETED" : "PARTIAL");
    await start(at(11, 30));
    await runUntil(at(13, 10));
    expect(joined()).not.toContain("PASS ");
  });
});
