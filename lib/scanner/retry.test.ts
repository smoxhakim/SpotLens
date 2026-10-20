import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLOSE_DELAY_MS,
  FAILED_PASS_RETRY_DELAYS_MS,
  classifyPass,
  classifyPassError,
  nextWake,
  recordPass,
  scanOnWake,
  scannedThroughAt,
  startSchedule,
  startupRetryDelay,
  type PassOutcome,
  type ScheduleState,
} from "@/lib/scanner";
import type { Timeframe } from "@/lib/market-data/provider";
import { MarketDataError } from "@/lib/market-data/provider";

/**
 * Retrying a scheduled pass in which every market failed, on a fake clock.
 * Every step is the pure function the scanner loop calls, in its order.
 */

const DELAY = DEFAULT_CLOSE_DELAY_MS;
const MIN = 60_000;
const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 20, h, m, s);
const BOTH: Timeframe[] = ["H1", "H4"];

interface Pass {
  at: number;
  scanned: Timeframe[];
  retryAttempt: number | null;
  outcome: PassOutcome;
}

/**
 * Runs the loop from `start` until `until`. `outcomeOf` decides each pass;
 * each pass takes `passMs`.
 */
function simulate(input: {
  start: number;
  until: number;
  outcomeOf: (pass: { at: number; scanned: Timeframe[]; index: number }) => PassOutcome;
  passMs?: number;
  state?: ScheduleState;
  timeframes?: Timeframe[];
}): { passes: Pass[]; state: ScheduleState } {
  const timeframes = input.timeframes ?? BOTH;
  const passMs = input.passMs ?? 60_000;
  let state = input.state ?? startSchedule({ timeframes, now: input.start, delayMs: DELAY });
  let clock = input.start;
  const passes: Pass[] = [];

  for (let guard = 0; guard < 100_000; guard += 1) {
    const wakeAt = nextWake({ state, timeframes, delayMs: DELAY });
    const now = Math.max(clock, wakeAt.at);
    if (now > input.until) break;
    const wake = scanOnWake({
      timeframes,
      scannedThrough: state.covered,
      plannedAt: wakeAt.at,
      now,
      delayMs: DELAY,
    });
    if (wake.timeframes.length === 0) throw new Error(`woke with nothing due at ${now}`);
    const outcome = input.outcomeOf({ at: now, scanned: wake.timeframes, index: passes.length });
    passes.push({ at: now, scanned: wake.timeframes, retryAttempt: wakeAt.retryAttempt, outcome });
    const finishedAt = now + passMs;
    state = recordPass(state, {
      timeframes,
      scanned: wake.timeframes,
      decidedAt: now,
      finishedAt,
      outcome,
      delayMs: DELAY,
    });
    clock = finishedAt + 1_000; // the loop's one-second pause
  }
  return { passes, state };
}

const minutesAfter = (passes: Pass[], from: number) => passes.map((p) => (p.at - from) / MIN);

describe("classifying a pass", () => {
  const ok = { ok: true };
  const transient = { ok: false, failure: { retryable: true } };
  const permanent = { ok: false, failure: { retryable: false } };

  it("COMPLETED and PARTIAL succeeded; their failures were the markets' own", () => {
    expect(classifyPass({ status: "COMPLETED", interrupted: false, results: [ok] })).toBe(
      "SUCCEEDED",
    );
    expect(classifyPass({ status: "PARTIAL", interrupted: false, results: [ok, transient] })).toBe(
      "SUCCEEDED",
    );
  });

  it("every market failed, at least one transiently: retry", () => {
    expect(
      classifyPass({ status: "FAILED", interrupted: false, results: [permanent, transient] }),
    ).toBe("FAILED_TRANSIENT");
  });

  it("every market failed, none transiently: not retried", () => {
    expect(
      classifyPass({ status: "FAILED", interrupted: false, results: [permanent, permanent] }),
    ).toBe("FAILED_PERMANENT");
    expect(classifyPass({ status: "FAILED", interrupted: false, results: [] })).toBe(
      "FAILED_PERMANENT",
    );
  });

  it("stopped on purpose is never a failure to retry, whatever else happened", () => {
    expect(
      classifyPass({ status: "FAILED", interrupted: true, results: [transient, transient] }),
    ).toBe("INTERRUPTED");
  });

  it("a pass that threw: an unreachable database or network is transient", () => {
    const unreachable = Object.assign(new Error("Can't reach database server at `x:5432`"), {
      errorCode: "P1001",
    });
    expect(classifyPassError(unreachable, false)).toBe("FAILED_TRANSIENT");
    expect(classifyPassError(Object.assign(new Error("x"), { code: "P1017" }), false)).toBe(
      "FAILED_TRANSIENT",
    );
    expect(classifyPassError(new Error("fetch failed"), false)).toBe("FAILED_TRANSIENT");
    expect(
      classifyPassError(
        new MarketDataError("UPSTREAM_ERROR", "502 from the exchange", { retryable: true }),
        false,
      ),
    ).toBe("FAILED_TRANSIENT");
  });

  it("a pass that threw for a reason that will not change is not retried", () => {
    expect(classifyPassError(new Error("Cannot read properties of undefined"), false)).toBe(
      "FAILED_PERMANENT",
    );
    expect(classifyPassError(Object.assign(new Error("x"), { code: "P2002" }), false)).toBe(
      "FAILED_PERMANENT",
    );
  });

  it("a pass that threw because it was stopped is interrupted", () => {
    expect(classifyPassError(new Error("fetch failed"), true)).toBe("INTERRUPTED");
  });
});

describe("retrying a pass that failed transiently", () => {
  it("retries after 1, 2, 5 and 10 minutes, then waits for the next window, which rescans it", () => {
    const { passes } = simulate({
      start: at(10, 2, 41),
      until: at(12, 2),
      outcomeOf: ({ at: t }) => (t < at(12) ? "FAILED_TRANSIENT" : "SUCCEEDED"),
    });

    // 11:01:30 fails; each retry is measured from when the previous pass ended.
    expect(minutesAfter(passes, at(11) + DELAY)).toEqual([0, 2, 5, 11, 22, 60]);
    expect(passes.map((p) => p.retryAttempt)).toEqual([null, 1, 2, 3, 4, null]);
    expect(FAILED_PASS_RETRY_DELAYS_MS).toEqual([1 * MIN, 2 * MIN, 5 * MIN, 10 * MIN]);
    // The 12:01:30 pass covers the H1 window that never succeeded, and H4's close.
    expect(passes.at(-1)).toMatchObject({ scanned: ["H1", "H4"], retryAttempt: null });
  });

  it("a retry that succeeds covers the window; the schedule then resumes", () => {
    const { passes, state } = simulate({
      start: at(10, 2, 41),
      until: at(12, 2),
      outcomeOf: ({ index }) => (index === 0 ? "FAILED_TRANSIENT" : "SUCCEEDED"),
    });
    expect(minutesAfter(passes, at(11) + DELAY)).toEqual([0, 2, 60]);
    expect(state.covered.H1).toBe(at(12) + DELAY);
    expect(state.retry).toBeNull();
  });

  it("stops before the next scheduled window: no retry is scheduled past it", () => {
    // A pass that fails at 11:52 has room for 1 and 2 minutes, not for 5.
    const state = startSchedule({ timeframes: BOTH, now: at(10, 30), delayMs: DELAY });
    const late = { ...state, covered: { H1: at(10) + DELAY, H4: at(8) + DELAY } };
    const { passes } = simulate({
      start: at(11, 52),
      until: at(12, 2),
      state: late,
      outcomeOf: ({ at: t }) => (t < at(12) ? "FAILED_TRANSIENT" : "SUCCEEDED"),
    });
    expect(passes.filter((p) => p.at < at(12) + DELAY).map((p) => p.retryAttempt)).toEqual([
      null,
      1,
      2,
    ]);
    expect(passes.at(-1)!.at).toBe(at(12) + DELAY);
  });

  it("a permanent failure is not retried: covered, and the schedule moves on", () => {
    const { passes, state } = simulate({
      start: at(10, 2, 41),
      until: at(12, 2),
      outcomeOf: () => "FAILED_PERMANENT",
    });
    expect(minutesAfter(passes, at(11) + DELAY)).toEqual([0, 60]);
    expect(passes.every((p) => p.retryAttempt === null)).toBe(true);
    expect(state.covered.H1).toBe(at(12) + DELAY);
  });

  it("an interrupted pass changes nothing and schedules nothing", () => {
    const state = startSchedule({ timeframes: BOTH, now: at(10, 2, 41), delayMs: DELAY });
    const after = recordPass(state, {
      timeframes: BOTH,
      scanned: ["H1"],
      decidedAt: at(11) + DELAY,
      finishedAt: at(11, 2),
      outcome: "INTERRUPTED",
    });
    expect(after).toBe(state);
  });

  it("partial passes are never retried", () => {
    const { passes } = simulate({
      start: at(10, 2, 41),
      until: at(14, 2),
      outcomeOf: () => "SUCCEEDED",
    });
    expect(passes.every((p) => p.retryAttempt === null)).toBe(true);
    expect(passes).toHaveLength(4);
  });
});

describe("bounded, even through a long outage", () => {
  it("24 hours of every pass failing: at most five passes per scheduled window, never back to back", () => {
    const start = at(0, 2, 41);
    const { passes } = simulate({
      start,
      until: start + 24 * 60 * MIN,
      outcomeOf: () => "FAILED_TRANSIENT",
    });

    const perHour = new Map<number, number>();
    for (const p of passes) {
      const hour = Math.floor((p.at - DELAY) / (60 * MIN));
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }
    expect(Math.max(...perHour.values())).toBeLessThanOrEqual(5);
    expect(passes.length).toBeLessThanOrEqual(24 * 5);
    for (let i = 1; i < passes.length; i += 1) {
      expect(passes[i].at - passes[i - 1].at).toBeGreaterThanOrEqual(MIN); // pass + 1 min at least
    }
    // H4's first window in the outage (04:01:30) never succeeds, so every
    // scheduled pass from then on still includes it.
    expect(
      passes
        .filter((p) => p.retryAttempt === null && p.at >= at(4) + DELAY)
        .every((p) => p.scanned.includes("H4")),
    ).toBe(true);
  });

  it("the attempt count starts again at each scheduled window", () => {
    const { passes } = simulate({
      start: at(10, 2, 41),
      until: at(13, 2),
      outcomeOf: () => "FAILED_TRANSIENT",
    });
    const attempts = passes.map((p) => p.retryAttempt);
    expect(attempts).toEqual([null, 1, 2, 3, 4, null, 1, 2, 3, 4, null]);
  });
});

describe("after a wake, and at startup", () => {
  it("a wake whose pass fails (Wi-Fi not back yet) retries H1 and H4, not just H1", () => {
    let state = startSchedule({ timeframes: BOTH, now: at(17, 10), delayMs: DELAY });
    const scanned: Timeframe[][] = [];
    const step = (now: number, outcome: PassOutcome) => {
      const planned = nextWake({ state, timeframes: BOTH, delayMs: DELAY });
      const wake = scanOnWake({
        timeframes: BOTH,
        scannedThrough: state.covered,
        plannedAt: planned.at,
        now,
        delayMs: DELAY,
      });
      scanned.push(wake.timeframes);
      state = recordPass(state, {
        timeframes: BOTH,
        scanned: wake.timeframes,
        decidedAt: now,
        finishedAt: now + 30_000,
        outcome,
        delayMs: DELAY,
      });
      return planned;
    };

    step(at(18) + DELAY, "SUCCEEDED"); // on time; then the lid shuts
    step(at(22, 10), "FAILED_TRANSIENT"); // lid opens, the network is not back
    expect(state.retry).toEqual({ at: at(22, 10, 30) + MIN, attempt: 1, until: at(23) + DELAY });
    const retry = step(state.retry!.at, "SUCCEEDED");

    expect(retry.retryAttempt).toBe(1);
    expect(scanned).toEqual([["H1"], ["H1", "H4"], ["H1", "H4"]]);
    expect(state.covered).toEqual(scannedThroughAt(BOTH, at(22, 11, 30), DELAY));
  });

  it("a catch-up that failed transiently is retried like any other pass", () => {
    const state = startSchedule({
      timeframes: BOTH,
      now: at(9, 31),
      delayMs: DELAY,
      catchUp: { decidedAt: at(9, 30), finishedAt: at(9, 31), outcome: "FAILED_TRANSIENT" },
    });
    expect(state.retry).toEqual({ at: at(9, 32), attempt: 1, until: at(10) + DELAY });
    const wake = scanOnWake({
      timeframes: BOTH,
      scannedThrough: state.covered,
      plannedAt: state.retry!.at,
      now: state.retry!.at,
      delayMs: DELAY,
    });
    expect(wake.timeframes).toEqual(["H1", "H4"]);
  });

  it("a catch-up that succeeded, or failed for good, covers what it was for", () => {
    for (const outcome of ["SUCCEEDED", "FAILED_PERMANENT"] as const) {
      const state = startSchedule({
        timeframes: BOTH,
        now: at(9, 31),
        delayMs: DELAY,
        catchUp: { decidedAt: at(9, 30), finishedAt: at(9, 31), outcome },
      });
      expect(state).toEqual({
        covered: scannedThroughAt(BOTH, at(9, 30), DELAY),
        retry: null,
        notBefore: null,
      });
    }
  });
});

describe("normal cadence is unchanged", () => {
  it("a week of passes that succeed: H1 168 times, H4 42, no retries", () => {
    const start = at(0, 17);
    const { passes } = simulate({
      start,
      until: start + 7 * 24 * 60 * MIN,
      outcomeOf: () => "SUCCEEDED",
    });
    expect(passes.filter((p) => p.scanned.includes("H1"))).toHaveLength(168);
    expect(passes.filter((p) => p.scanned.includes("H4"))).toHaveLength(42);
    expect(passes.every((p) => p.retryAttempt === null)).toBe(true);
    expect(passes.every((p) => (p.at - DELAY) % (60 * MIN) === 0)).toBe(true);
  });
});

describe("startupRetryDelay", () => {
  const unreachable = Object.assign(new Error("Can't reach database server at `db:5432`"), {
    errorCode: "P1001",
  });

  it("a transient error waits 1, 2, 5, then 10 minutes, then gives up", () => {
    expect([1, 2, 3, 4, 5].map((n) => startupRetryDelay(unreachable, n))).toEqual([
      1 * MIN,
      2 * MIN,
      5 * MIN,
      10 * MIN,
      null,
    ]);
    expect(startupRetryDelay(new Error("fetch failed"), 1)).toBe(MIN);
  });

  it.each([
    ["bad credentials", Object.assign(new Error("Authentication failed"), { errorCode: "P1000" })],
    [
      "no such database",
      Object.assign(new Error("Database does not exist"), { errorCode: "P1003" }),
    ],
    ["a query error", Object.assign(new Error("x"), { code: "P2002" })],
    ["a bug", new TypeError("Cannot read properties of undefined")],
  ])("%s is not retried", (_, error) => {
    expect(startupRetryDelay(error, 1)).toBeNull();
  });
});
