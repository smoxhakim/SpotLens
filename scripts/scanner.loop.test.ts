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

type Kind = "COMPLETED" | "PARTIAL" | "TRANSIENT" | "PERMANENT" | "THROW_DB";

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
    shortlist: {
      totalEligible: 0,
      totalAnalysed: results.length,
      excluded: { AVOID: 0, HIGH_RISK: 0, BELOW_QUALITY_BAR: 0, REWARD_NOT_MEASURED: 0, FAILED: 0 },
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
  return { ...actual, buildDailySummary: async () => null };
});
vi.mock("@/services/confirmation-alerts", () => ({
  deliverConfirmationAlerts: vi.fn(async () => ({})),
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
  return { ...actual, sleep: (ms: number, signal?: AbortSignal) => fakeSleep(ms, signal) };
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
function sleepUntil(t: number) {
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

describe("startup", () => {
  it("takes the scanner lock before anything else, and scans on candle closes", async () => {
    await start(at(10, 2, 41));
    expect(holdLockOrExit).toHaveBeenCalledWith("scanner", expect.any(Function));
    expect(runScan).not.toHaveBeenCalled();

    await runUntil(at(13, 30));
    expect(passTimes()).toEqual(["11:01:30", "12:01:30", "13:01:30"]);
    expect(passes.map((p) => p.timeframes)).toEqual([["H1"], ["H1", "H4"], ["H1"]]);
    expect(passes.every((p) => p.triggeredBy === "SCHEDULE")).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("with --catch-up and no recent pass, scans every timeframe at once, then follows the schedule", async () => {
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    await start(at(10, 20), ["--catch-up"]);
    await runUntil(at(11, 30));
    expect(passTimes()).toEqual(["10:20:00", "11:01:30"]);
    expect(passes.map((p) => p.timeframes)).toEqual([["H1", "H4"], ["H1"]]);
  });

  it("with --catch-up and an up-to-date pass, waits for the next close", async () => {
    lastSuccessfulPassStartedAt.mockResolvedValue(new Date(at(10, 1, 31)));
    await start(at(10, 20), ["--catch-up"]);
    await runUntil(at(11, 30));
    expect(passTimes()).toEqual(["11:01:30"]);
  });

  it("an owner that cannot be resolved stops it before any pass, cleanly", async () => {
    resolveScannerUser.mockResolvedValueOnce({ ok: false, failure: "AMBIGUOUS" } as never);
    await start(at(10, 2, 41));
    await runUntil(at(12));
    expect(runScan).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(waits).toHaveLength(0);
  });
});

describe("a database that is down at startup", () => {
  const unreachable = () =>
    Object.assign(new Error("Can't reach database server at `db:5432`"), { errorCode: "P1001" });
  const badCredentials = () =>
    Object.assign(new Error("Authentication failed against database server"), {
      errorCode: "P1000",
    });

  /** Owner lookups, with when they ran and whether two ever overlapped. */
  function scriptLookups(outcomes: ("down" | "auth" | "ok")[]) {
    const times: number[] = [];
    let open = 0;
    let maxOpen = 0;
    resolveScannerUser.mockImplementation(async () => {
      times.push(Date.now());
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await flushOnce();
      open -= 1;
      const next = outcomes[times.length - 1] ?? "ok";
      if (next === "down") throw unreachable();
      if (next === "auth") throw badCredentials();
      return { ok: true as const, userId: "user-1" };
    });
    return { times, maxOverlap: () => maxOpen };
  }
  const flushOnce = () => new Promise((r) => setImmediate(r));
  const minutes = (times: number[], from: number) => times.map((t) => (t - from) / MIN);

  it("unreachable, then back: retried after 1 and 2 min, then startup and the schedule go on", async () => {
    const lookups = scriptLookups(["down", "down", "ok"]);
    await start(at(10, 2, 41));
    await runUntil(at(12, 30));

    expect(minutes(lookups.times, at(10, 2, 41))).toEqual([0, 1, 3]);
    expect(lookups.maxOverlap()).toBe(1);
    expect(logs.filter((l) => /retrying in \d+ min \(retry \d of 4\)/.test(l))).toHaveLength(2);
    expect(passTimes()).toEqual(["11:01:30", "12:01:30"]);
    expect(process.exitCode).toBeUndefined();
    // The lock was taken once, before the first lookup, and held throughout.
    expect(holdLockOrExit).toHaveBeenCalledTimes(1);
  });

  it("with --catch-up, the catch-up pass runs as soon as the database is back", async () => {
    scriptLookups(["down", "ok"]);
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    await start(at(10, 20), ["--catch-up"]);
    await runUntil(at(11, 30));

    expect(passTimes()).toEqual(["10:21:00", "11:01:30"]);
    expect(passes[0].timeframes).toEqual(["H1", "H4"]);
  });

  it("a permanent error (bad credentials) is not retried: exit 1, saying what to check", async () => {
    const lookups = scriptLookups(["auth"]);
    await start(at(10, 2, 41));
    await runUntil(at(12));

    expect(lookups.times).toHaveLength(1);
    expect(runScan).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logs.at(-1)).toMatch(
      /Fatal: .*retrying will not fix.*Check DATABASE_URL and the database credentials/,
    );
    expect(waits).toHaveLength(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("an outage past the limit: five lookups over 18 min, then exit 1 — no busy loop", async () => {
    const lookups = scriptLookups(["down", "down", "down", "down", "down", "down"]);
    await start(at(10, 2, 41));
    await runUntil(at(12));

    expect(minutes(lookups.times, at(10, 2, 41))).toEqual([0, 1, 3, 8, 18]);
    expect(lookups.maxOverlap()).toBe(1);
    expect(runScan).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(logs.at(-1)).toMatch(
      /Fatal: .*failed 5 times over 18 min; the database is still unreachable.*Check the network and DATABASE_URL/,
    );
    expect(waits).toHaveLength(0);
  });

  it("Ctrl-C while waiting to retry: stops at once, cleanly — no further lookup, no pass", async () => {
    const lookups = scriptLookups(["down", "down", "down"]);
    await start(at(10, 2, 41));
    await runUntil(at(10, 3, 10)); // in the one-minute wait
    await stop();
    await runUntil(at(12));

    expect(lookups.times).toHaveLength(1);
    expect(runScan).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(waits).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toMatch(/Stopped\./);
  });

  it("a connection string in the error never reaches the log", async () => {
    resolveScannerUser.mockRejectedValueOnce(
      Object.assign(new Error("Authentication failed for postgresql://user:hunter2@db:5432/x"), {
        errorCode: "P1000",
      }),
    );
    await start(at(10, 2, 41));
    await runUntil(at(11));
    expect(logs.join("\n")).not.toContain("hunter2");
  });

  it("a failed catch-up check catches up anyway — the missed window is not skipped", async () => {
    lastSuccessfulPassStartedAt.mockRejectedValueOnce(new Error("connection closed"));
    await start(at(10, 20), ["--catch-up"]);
    await runUntil(at(11, 30));

    expect(passTimes()).toEqual(["10:20:00", "11:01:30"]);
    expect(passes[0].timeframes).toEqual(["H1", "H4"]);
    expect(logs.some((l) => /catching up anyway, so no window is skipped/.test(l))).toBe(true);
  });

  it("…and if the database is still down for that pass, the pass is retried like any other", async () => {
    lastSuccessfulPassStartedAt.mockRejectedValueOnce(new Error("connection closed"));
    kindOf = (i) => (i === 0 ? "THROW_DB" : "COMPLETED");
    await start(at(10, 20), ["--catch-up"]);
    await runUntil(at(11, 30));

    expect(passTimes()).toEqual(["10:20:00", "10:21:00", "11:01:30"]);
    expect(passes[1].timeframes).toEqual(["H1", "H4"]);
  });
});

describe("after macOS sleep", () => {
  it("the lid shut through an H4 close: H1 and H4 on waking, then the hour resumes", async () => {
    await start(at(10, 2, 41));
    await runUntil(at(11, 10)); // the 11:01:30 pass is done
    sleepUntil(at(16, 10)); // asleep until 16:10; the wait for 12:01:30 is overdue
    await runUntil(at(17, 30));

    expect(passTimes()).toEqual(["11:01:30", "16:10:00", "17:01:30"]);
    expect(passes.map((p) => p.timeframes)).toEqual([["H1"], ["H1", "H4"], ["H1"]]);
    expect(logs.some((l) => /Woke \d+ min after the planned window/.test(l))).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it("woke with no network: the wake pass fails, the retry a minute later covers H1 and H4", async () => {
    kindOf = (i) => (i === 1 ? "TRANSIENT" : "COMPLETED");
    await start(at(10, 2, 41));
    await runUntil(at(11, 10));
    sleepUntil(at(16, 10));
    await runUntil(at(17, 30));

    expect(passTimes()).toEqual(["11:01:30", "16:10:00", "16:12:00", "17:01:30"]);
    expect(passes[2].timeframes).toEqual(["H1", "H4"]);
  });
});

describe("retrying a pass in which every market failed", () => {
  it("transient: retried 1, 2, 5 and 10 min after each failure ends, then the next window rescans", async () => {
    kindOf = (i) => (i < 5 ? "TRANSIENT" : "COMPLETED");
    await start(at(10, 2, 41));
    await runUntil(at(12, 30));

    expect(passTimes()).toEqual([
      "11:01:30", // fails, ends 11:02:30
      "11:03:30", // +1 min
      "11:06:30", // +2
      "11:12:30", // +5
      "11:23:30", // +10; then nothing before the window
      "12:01:30",
    ]);
    expect(passes.map((p) => p.timeframes)).toEqual([
      ["H1"],
      ["H1"],
      ["H1"],
      ["H1"],
      ["H1"],
      ["H1", "H4"],
    ]);
    expect(logs.filter((l) => /Retrying in \d+ min \(retry \d of 4\)/.test(l))).toHaveLength(4);
    expect(logs.some((l) => /no more retries before the next window/.test(l))).toBe(true);
  });

  it("a successful retry ends the series: the next pass is the next window", async () => {
    kindOf = (i) => (i === 0 ? "TRANSIENT" : "COMPLETED");
    await start(at(10, 2, 41));
    await runUntil(at(13, 30));
    expect(passTimes()).toEqual(["11:01:30", "11:03:30", "12:01:30", "13:01:30"]);
  });

  it("never retries past the next scheduled window", async () => {
    passMs = 10_000;
    kindOf = (i) => (i < 4 ? "TRANSIENT" : "COMPLETED");
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    await start(at(11, 45), ["--catch-up"]);
    await runUntil(at(12, 30));
    // 11:45 catch-up fails; retries at +1, +2, +5; +10 would pass 12:01:30.
    expect(passTimes()).toEqual(["11:45:00", "11:46:10", "11:48:20", "11:53:30", "12:01:30"]);
  });

  it.each([
    ["a permanent failure", "PERMANENT"],
    ["a partial pass", "PARTIAL"],
  ] as const)("%s is not retried", async (_, kind) => {
    kindOf = (i) => (i === 0 ? kind : "COMPLETED");
    await start(at(10, 2, 41));
    await runUntil(at(12, 30));
    expect(passTimes()).toEqual(["11:01:30", "12:01:30"]);
  });

  it("an unreachable database for hours: no busy loop — at most five passes a window, a minute apart", async () => {
    kindOf = () => "THROW_DB";
    await start(at(10, 2, 41));
    await runUntil(at(14));

    const perWindow = new Map<number, number>();
    for (const p of passes) {
      const w = Math.floor((p.at - DELAY) / (60 * MIN));
      perWindow.set(w, (perWindow.get(w) ?? 0) + 1);
    }
    expect(Math.max(...perWindow.values())).toBe(5);
    for (let i = 1; i < passes.length; i += 1) {
      expect(passes[i].at - passes[i - 1].at).toBeGreaterThanOrEqual(MIN);
    }
    expect(passes.length).toBe(3 * 5);
  });

  it("failing to close abandoned runs never stops the schedule", async () => {
    closeAbandonedRuns.mockRejectedValue(new Error("connection closed"));
    await start(at(10, 2, 41));
    await runUntil(at(12, 30));
    expect(passTimes()).toEqual(["11:01:30", "12:01:30"]);
  });
});

describe("duplicates and freshness", () => {
  it("a failed pass and its four retries in one hour notify each failure once — the dedupe key holds", async () => {
    kindOf = (i) => (i < 5 ? "TRANSIENT" : "COMPLETED");
    await start(at(10, 2, 41));
    await runUntil(at(11, 50));

    expect(passes).toHaveLength(5);
    // Two markets failed on each of the five passes: two notifications, eight
    // refused by the unique index.
    expect(deliveries).toEqual({ created: 2, duplicates: 8 });
  });

  it("every retry is the same kind of pass as any other — runScan decides what is stored", async () => {
    kindOf = (i) => (i === 0 ? "TRANSIENT" : "COMPLETED");
    await start(at(10, 2, 41));
    await runUntil(at(11, 10));
    // The script has no other way to record a pass: no database call of its own
    // marks one successful, so a retry cannot vouch for freshness except through
    // the run that runScan stores, with its own status.
    expect(runScan).toHaveBeenCalledTimes(2);
    expect(runScan.mock.calls.every(([o]) => o.triggeredBy === "SCHEDULE")).toBe(true);
  });
});

describe("stopping", () => {
  it("Ctrl-C while waiting for a window: no pass, no pending wait, no timer, the client disconnected", async () => {
    await start(at(10, 2, 41));
    await runUntil(at(10, 30));
    await stop();

    expect(runScan).not.toHaveBeenCalled();
    expect(waits).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toMatch(/Stopped\./);
  });

  it("Ctrl-C mid-pass: the pass unwinds, nothing is retried, nothing runs after", async () => {
    kindOf = () => "TRANSIENT"; // would be retried if it had failed by itself
    await start(at(10, 2, 41));
    await runUntil(at(11, 2)); // the 11:01:30 pass is in flight
    expect(inFlight).toBe(1);
    await stop();
    await runUntil(at(13));

    expect(passTimes()).toEqual(["11:01:30"]);
    expect(waits).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => /Retrying/.test(l))).toBe(false);
  });

  it("Ctrl-C while waiting to retry: the retry never happens", async () => {
    kindOf = () => "TRANSIENT";
    await start(at(10, 2, 41));
    await runUntil(at(11, 3)); // failed; the retry is due at 11:03:30
    await stop();
    await runUntil(at(13));

    expect(passTimes()).toEqual(["11:01:30"]);
    expect(waits).toHaveLength(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("Ctrl-C during the startup catch-up: it unwinds and the schedule never starts", async () => {
    lastSuccessfulPassStartedAt.mockResolvedValue(null);
    await start(at(10, 20), ["--catch-up"]);
    expect(inFlight).toBe(1);
    await stop();
    await runUntil(at(13));

    expect(passTimes()).toEqual(["10:20:00"]);
    expect(waits).toHaveLength(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
