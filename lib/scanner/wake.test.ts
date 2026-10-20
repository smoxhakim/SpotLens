import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_CLOSE_DELAY_MS,
  LATE_WAKE_TOLERANCE_MS,
  latestScanWindow,
  markScanned,
  nextScanWindow,
  planScan,
  scanOnWake,
  scannedThroughAt,
  sleep,
  type ScannedThrough,
} from "@/lib/scanner";
import type { Timeframe } from "@/lib/market-data/provider";

/**
 * The scheduled scanner's loop — plan, wait, wake, scan — driven by a fake
 * clock. Every step is the pure function the real loop calls, in the order it
 * calls them, so a sleep of any length is a number rather than a wait.
 */

const DELAY = DEFAULT_CLOSE_DELAY_MS;
const at = (h: number, m = 0, s = 0) => Date.UTC(2026, 9, 19, h, m, s);
const BOTH: Timeframe[] = ["H1", "H4"];

/** The scanner's loop state, stepped by hand. */
function loop(startedAt: number, timeframes: Timeframe[] = BOTH) {
  let covered: ScannedThrough = scannedThroughAt(timeframes, startedAt, DELAY);
  return {
    plan: () => planScan({ timeframes, scannedThrough: covered, delayMs: DELAY }),
    /** Wakes at `now` for the current plan; records and returns what is scanned. */
    wake(now: number) {
      const window = planScan({ timeframes, scannedThrough: covered, delayMs: DELAY });
      const result = scanOnWake({
        timeframes,
        scannedThrough: covered,
        plannedAt: window.at,
        now,
        delayMs: DELAY,
      });
      if (result.timeframes.length > 0) {
        covered = markScanned(covered, result.timeframes, now, DELAY);
      }
      return result;
    },
  };
}

describe("on schedule, nothing changes", () => {
  it("plans the same windows the old clock-only planner did, outside a settle period", () => {
    // Every minute of two days, from points a loop actually plans at.
    for (let t = at(0, 3); t < at(0, 3) + 48 * 60 * 60_000; t += 60_000) {
      const minute = new Date(t).getUTCMinutes();
      if (minute < 2) continue; // inside the 90 s settle period: see below
      expect(
        planScan({ timeframes: BOTH, scannedThrough: scannedThroughAt(BOTH, t, DELAY) }),
      ).toEqual(nextScanWindow(BOTH, t, DELAY));
    }
  });

  it("hour by hour: H1, then H1 + H4 at an H4 close, each exactly once", () => {
    const l = loop(at(10, 2, 41));
    expect(l.plan()).toEqual({ at: at(11) + DELAY, timeframes: ["H1"] });
    expect(l.wake(at(11) + DELAY + 5)).toMatchObject({ timeframes: ["H1"], late: false });
    expect(l.plan()).toEqual({ at: at(12) + DELAY, timeframes: ["H1", "H4"] });
    expect(l.wake(at(12) + DELAY)).toMatchObject({ timeframes: ["H1", "H4"], late: false });
    expect(l.plan()).toEqual({ at: at(13) + DELAY, timeframes: ["H1"] });
  });
});

describe("after macOS sleep", () => {
  it("lid shut at 17:10, opened at 22:10: H4 closed at 20:00, so H4 is scanned too", () => {
    const l = loop(at(17, 10));
    expect(l.plan()).toEqual({ at: at(18) + DELAY, timeframes: ["H1"] }); // all the old loop scanned

    const woke = l.wake(at(22, 10));

    expect(woke.timeframes).toEqual(["H1", "H4"]);
    expect(woke.late).toBe(true);
    expect(woke.lateByMs).toBe(at(22, 10) - (at(18) + DELAY));
    expect(l.plan()).toEqual({ at: at(23) + DELAY, timeframes: ["H1"] });
  });

  it("slept, but no H4 close passed meanwhile: H1 only, still reported late", () => {
    const l = loop(at(13, 10));
    expect(l.wake(at(15, 20))).toMatchObject({ timeframes: ["H1"], late: true });
  });

  it("woke inside the settle period of a fresh H4 close: H1 now, then H4 at its own window", () => {
    const l = loop(at(17, 10));
    // 20:00:30 — H4 closed at 20:00 and settles at 20:01:30.
    expect(l.wake(at(20, 0, 30)).timeframes).toEqual(["H1"]);
    // The old planner went straight to 21:01:30 here, skipping the 20:00 close.
    expect(l.plan()).toEqual({ at: at(20) + DELAY, timeframes: ["H1", "H4"] });
    expect(l.wake(at(20) + DELAY).timeframes).toEqual(["H1", "H4"]);
  });

  it("a pass that runs past the next window: that window is due at once, not skipped", () => {
    const l = loop(at(17, 10));
    l.wake(at(20, 0, 30)); // scans H1 for 19:01:30 …
    const passEnds = at(20, 1, 40); // … and finishes after 20:01:30
    const next = l.plan();
    expect(next.at).toBeLessThan(passEnds); // the loop waits zero
    expect(l.wake(passEnds).timeframes).toEqual(["H1", "H4"]);
  });

  it("a sleep spanning days scans each timeframe once, then resumes the hour", () => {
    const l = loop(at(17, 10));
    expect(l.wake(at(17, 10) + 3 * 24 * 60 * 60_000).timeframes).toEqual(["H1", "H4"]);
    expect(l.plan().at).toBe(at(18) + DELAY + 3 * 24 * 60 * 60_000);
  });
});

describe("startup", () => {
  it("started inside a settle period, the close that is settling is the first window", () => {
    const l = loop(at(10, 0, 30));
    expect(l.plan()).toEqual({ at: at(10) + DELAY, timeframes: ["H1"] });
    // The old planner: the next close, an hour away.
    expect(nextScanWindow(BOTH, at(10, 0, 30), DELAY).at).toBe(at(11) + DELAY);
  });

  it("windows already passed at startup count as covered — the catch-up's job, as before", () => {
    const l = loop(at(10, 30));
    expect(l.plan()).toEqual({ at: at(11) + DELAY, timeframes: ["H1"] });
  });
});

describe("edges", () => {
  it("the tolerance: a minute late is on time, a moment more is late", () => {
    const window = at(11) + DELAY;
    expect(loop(at(10, 2, 41)).wake(window + LATE_WAKE_TOLERANCE_MS).late).toBe(false);
    expect(loop(at(10, 2, 41)).wake(window + LATE_WAKE_TOLERANCE_MS + 1).late).toBe(true);
  });

  it("a clock set backwards finds nothing due: no scan, and no busy loop", () => {
    const l = loop(at(10, 2, 41));
    const woke = l.wake(at(9, 30));
    expect(woke.timeframes).toEqual([]);
    expect(woke.lateByMs).toBe(0);
    expect(l.plan().at).toBe(at(11) + DELAY); // unchanged, still in the future
  });

  it("markScanned never moves a timeframe backwards", () => {
    const covered = { H1: at(12) + DELAY };
    expect(markScanned(covered, ["H1"], at(9), DELAY).H1).toBe(at(12) + DELAY);
  });

  it("a single configured timeframe is never widened", () => {
    expect(loop(at(17, 10), ["H4"]).wake(at(22, 10)).timeframes).toEqual(["H4"]);
    expect(loop(at(17, 10), ["H1"]).wake(at(22, 10)).timeframes).toEqual(["H1"]);
  });

  it("reports timeframes shortest first, whatever order they were configured in", () => {
    expect(loop(at(17, 10), ["H4", "H1"]).wake(at(22, 10)).timeframes).toEqual(["H1", "H4"]);
  });

  it("latestScanWindow: the close's window once it has settled, the previous one until then", () => {
    expect(latestScanWindow("H1", at(10, 1, 30), DELAY)).toBe(at(10) + DELAY);
    expect(latestScanWindow("H1", at(10, 1, 29), DELAY)).toBe(at(9) + DELAY);
  });
});

describe("startup at the settle boundary", () => {
  it("a second before a close settles, that close is the first window", () => {
    expect(loop(at(10, 1, 29)).plan()).toEqual({ at: at(10) + DELAY, timeframes: ["H1"] });
  });

  it("at the moment it settles or after, it counts as covered — the catch-up's job, as before", () => {
    expect(loop(at(10, 1, 30)).plan()).toEqual({ at: at(11) + DELAY, timeframes: ["H1"] });
    expect(loop(at(10, 1, 31)).plan()).toEqual({ at: at(11) + DELAY, timeframes: ["H1"] });
  });

  it("a catch-up pass covers what had settled when it started, not when it finished", () => {
    // Catch-up decided at 10:59:10, finished at 11:01:40 — the 11:00 close settled
    // (11:01:30) while it ran, so it is still due when the loop starts.
    const covered = scannedThroughAt(BOTH, at(10, 59, 10), DELAY);
    expect(planScan({ timeframes: BOTH, scannedThrough: covered, delayMs: DELAY })).toEqual({
      at: at(11) + DELAY,
      timeframes: ["H1"],
    });
    // Starting from the finish time instead would have skipped it to 12:01:30.
    expect(
      planScan({ timeframes: BOTH, scannedThrough: scannedThroughAt(BOTH, at(11, 1, 40), DELAY) })
        .at,
    ).toBe(at(12) + DELAY);
  });
});

describe("over many cycles: nothing repeated, nothing skipped, nothing early", () => {
  /** A small seeded PRNG, so the run is the same every time. */
  function rng(seed: number) {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("5,000 wake cycles with random passes, short delays and long sleeps", () => {
    const random = rng(46);
    let covered = scannedThroughAt(BOTH, at(0, 17), DELAY);
    let clock = at(0, 17);
    const scans: Partial<Record<Timeframe, number[]>> = { H1: [], H4: [] };

    for (let i = 0; i < 5_000; i += 1) {
      const plan = planScan({ timeframes: BOTH, scannedThrough: covered, delayMs: DELAY });
      // The loop sleeps until the plan, or wakes late: timer jitter, a settle-period
      // landing, or a lid shut for hours.
      const roll = random();
      const late =
        roll < 0.6
          ? random() * 50
          : roll < 0.8
            ? random() * 120_000
            : roll < 0.95
              ? random() * 4 * 60 * 60_000
              : random() * 3 * 24 * 60 * 60_000;
      const now = Math.max(clock, plan.at) + late;

      const due = scanOnWake({
        timeframes: BOTH,
        scannedThrough: covered,
        plannedAt: plan.at,
        now,
        delayMs: DELAY,
      }).timeframes;

      for (const tf of BOTH) {
        const latest = latestScanWindow(tf, now, DELAY);
        const prev = covered[tf]!;
        // Nothing early: only settled windows exist to be due.
        expect(latest).toBeLessThanOrEqual(now);
        // Nothing repeated, nothing skipped: due exactly when a newer window settled.
        expect(due.includes(tf)).toBe(latest > prev);
        if (due.includes(tf)) scans[tf]!.push(latest);
      }

      covered = markScanned(covered, due, now, DELAY);
      // After every wake, every settled window is covered — none left behind.
      for (const tf of BOTH) expect(covered[tf]).toBe(latestScanWindow(tf, now, DELAY));
      // The pass itself takes up to five minutes before the loop plans again.
      clock = now + random() * 5 * 60_000;
    }

    for (const tf of BOTH) {
      // Strictly increasing: no window was scanned twice.
      const list = scans[tf]!;
      expect(list.every((w, i) => i === 0 || w > list[i - 1])).toBe(true);
    }
    expect(scans.H1!.length).toBeGreaterThan(1_000);
  });

  it("on schedule for a week: H1 once an hour, H4 once every four, each at its settled window", () => {
    let covered = scannedThroughAt(BOTH, at(0, 17), DELAY);
    const scanned: string[] = [];
    for (let i = 0; i < 7 * 24; i += 1) {
      const plan = planScan({ timeframes: BOTH, scannedThrough: covered, delayMs: DELAY });
      const due = scanOnWake({
        timeframes: BOTH,
        scannedThrough: covered,
        plannedAt: plan.at,
        now: plan.at,
        delayMs: DELAY,
      }).timeframes;
      expect(due).toEqual(plan.timeframes);
      expect((plan.at - DELAY) % (60 * 60_000)).toBe(0); // exactly close + settle delay
      for (const tf of due) scanned.push(tf);
      covered = markScanned(covered, due, plan.at, DELAY);
    }
    expect(scanned.filter((t) => t === "H1")).toHaveLength(7 * 24);
    expect(scanned.filter((t) => t === "H4")).toHaveLength(7 * 6);
  });
});

describe("stopping during a wait", () => {
  // `sleep` is how the loop waits for a window and how the catch-up waits for a
  // close to settle; Ctrl-C, SIGTERM and the engine going away all abort it.
  afterEach(() => vi.useRealTimers());

  it("an abort ends a long wait at once", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let done = false;
    const wait = sleep(4 * 60 * 60_000, controller.signal).then(() => (done = true));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    controller.abort();
    await wait;
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // the timer is cleared, nothing keeps the process up
  });

  it("an abort that came first means no wait at all", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    await sleep(60_000, controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a plan already in the past waits zero, not a negative or NaN time", async () => {
    vi.useFakeTimers();
    let done = false;
    const wait = sleep(-5_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    await wait;
    expect(done).toBe(true);
  });
});
