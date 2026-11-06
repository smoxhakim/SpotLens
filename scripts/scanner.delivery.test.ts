// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Timeframe } from "@/lib/market-data/provider";

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
  | "DB_PERMANENT";
let deliveryThrows = false;
const notified: unknown[][] = [];

interface Pass {
  at: number;
  timeframes: Timeframe[];
  triggeredBy: string;
}

const passes: Pass[] = [];
let inFlight = 0;
let maxInFlight = 0;
let passMs = 60_000;
let kindOf: (index: number) => Kind = () => "COMPLETED";

const MARKETS = ["BTCUSDT", "ETHUSDT"];

function summary(kind: Exclude<Kind, "THROW_DB">, interrupted = false) {
  if (kind === "DB_TRANSIENT" || kind === "DB_PERMANENT") {
    return {
      runId: `run-${passes.length}`,
      status: "FAILED",
      interrupted: false,
      results: [
        { symbol: "BTCUSDT", timeframe: "H1", ok: true, failure: null },
        {
          symbol: "ETHUSDT",
          timeframe: "H1",
          ok: false,
          failure: {
            category: "DATABASE_ERROR",
            message: "Database error",
            retryable: kind === "DB_TRANSIENT",
            database: kind === "DB_TRANSIENT" ? "TRANSIENT" : "PERMANENT",
          },
        },
      ],
      analysed: 2,
      succeeded: 1,
      failed: 1,
      potentialSetups: 0,
      waiting: 0,
      highRisk: 0,
      avoided: 0,
      setupsCreated: 0,
      stateChanges: 0,
      invalidations: 1,
      events: [
        {
          type: "SETUP_INVALIDATED",
          symbol: "BTCUSDT",
          timeframe: "H1",
          setupId: "s",
          lifecycleStatus: "INVALIDATED",
          failureCategory: null,
          detail: "d",
          eventId: `committed-${passes.length}`,
          closedSetupId: null,
        },
      ],
      observations: [],
      breakdown: [],
      shortlist: {
        totalEligible: 0,
        totalAnalysed: 2,
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
    observations: [],
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
      if (kind === "THROW_DB") {
        throw Object.assign(new Error("Can't reach database server at `db:5432`"), {
          errorCode: "P1001",
        });
      }
      await fakeSleep(passMs, opts.signal); // the pass takes time, unless stopped
      return summary(kind, opts.signal.aborted);
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
  resolveScannerUser: () => resolveScannerUser(),
  describeScannerUserFailure: () => "no owner",
}));

/** The notification table's unique index, as far as delivery is concerned. */
const delivered = new Set<string>();
const deliveries = { created: 0, duplicates: 0 };
vi.mock("@/services/notifications", () => ({
  deliverEvents: async (events: { dedupeKey: string }[]) => {
    if (deliveryThrows)
      throw Object.assign(new Error("notification store down"), { code: "P1017" });
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
    buildDailySummary: async () => null,
    eventsFromScan: async (
      input: { scannerEvents: unknown[] } & Parameters<typeof actual.eventsFromScan>[0],
    ) => {
      notified.push(input.scannerEvents);
      return actual.eventsFromScan({
        ...input,
        scannerEvents: (input.scannerEvents as { type: string }[]).filter(
          (e) => e.type === "ANALYSIS_FAILED",
        ) as never,
      });
    },
  };
});
vi.mock("@/services/confirmation-alerts", () => ({
  deliverConfirmationAlerts: vi.fn(async () => {
    if (deliveryThrows) throw new Error("confirmation store down");
    return {};
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
  delivered.clear();
  deliveries.created = 0;
  deliveries.duplicates = 0;
  logs.length = 0;
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

// --- the tests -------------------------------------------------------------------

describe("the corrected classification, through the real script", () => {
  afterEach(() => {
    deliveryThrows = false;
    notified.length = 0;
  });

  it("delivery throwing after a persisted pass: SUCCEEDED, covered, no retry", async () => {
    kindOf = () => "PARTIAL";
    deliveryThrows = true;
    await start(at(10, 30));
    await runUntil(at(12, 30));
    await stop();
    expect(passTimes()).toEqual(["11:01:30", "12:01:30"]);
    expect(logs.some((l) => l.includes("notifications skipped"))).toBe(true);
    expect(logs.some((l) => /retrying in/i.test(l))).toBe(false);
  });

  it("permanent database failure on one market: no retry, one attempt each window, H4 stays uncovered", async () => {
    kindOf = () => "DB_PERMANENT";
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(14, 30));
    await stop();
    expect(
      passes.map((p) => [new Date(p.at).toISOString().slice(11, 19), p.timeframes.join("+")]),
    ).toEqual([
      ["12:01:30", "H1+H4"],
      ["13:01:30", "H1+H4"],
      ["14:01:30", "H1+H4"],
    ]);
    // Committed events of the FAILED attempt still reached delivery, every time.
    expect(notified.map((n) => (n as { eventId?: string }[])[0].eventId)).toEqual([
      "committed-1",
      "committed-2",
      "committed-3",
    ]);
  });

  it("transient database failure: retried at 1 min; committed events go to delivery on each attempt; retry names no old event", async () => {
    kindOf = (i) => (i === 0 ? "DB_TRANSIENT" : "COMPLETED");
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 30));
    await stop();
    expect(passTimes()).toEqual(["12:01:30", "12:02:40"].map((t) => t));
    expect(notified.length).toBe(2);
    expect((notified[0] as { eventId?: string }[])[0].eventId).toBe("committed-1");
    expect(notified[1].length).toBe(0);
  });

  it("a failed FAILED-attempt delivery still leaves a transient retry scheduled, not a second reason", async () => {
    kindOf = (i) => (i === 0 ? "DB_TRANSIENT" : "COMPLETED");
    deliveryThrows = true;
    passMs = 10_000;
    await start(at(11, 30));
    await runUntil(at(12, 30));
    await stop();
    expect(passes.length).toBe(2);
  });
});
