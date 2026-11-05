import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_WAIT_STEP_MS, sleep, sleepUntil } from "@/lib/scanner";

/**
 * The scanner's wait for a window, on a fake clock.
 *
 * `vi.setSystemTime` moves the wall clock and leaves pending timers with the time
 * they had left, which is what a Mac does while it sleeps: Node's timers stop
 * counting and the clock does not. `advanceTimersByTimeAsync` is time awake, when
 * both move together. Nothing here waits for real.
 */

const T0 = Date.UTC(2026, 10, 5, 10, 0, 0);
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Starts a wait and reports when it ended, by the clock it was reading. */
function waitFor(wakeAt: number, signal?: AbortSignal) {
  const state = { done: false, endedAt: null as number | null };
  const finished = sleepUntil(wakeAt, signal).then(() => {
    state.done = true;
    state.endedAt = Date.now();
  });
  return { state, finished };
}

/** Records the length of each step, then waits it out as the real thing does. */
function recordingPause() {
  const steps: number[] = [];
  const pause = (ms: number, signal?: AbortSignal) => {
    steps.push(ms);
    return sleep(ms, signal);
  };
  return { steps, pause };
}

const awake = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => vi.useRealTimers());

describe("on time, nothing changes", () => {
  it("ends exactly at the target and not a moment before", async () => {
    const wakeAt = T0 + 3 * HOUR;
    const { state } = waitFor(wakeAt);

    await awake(3 * HOUR - 1);
    expect(state.done).toBe(false);

    await awake(1);
    expect(state.done).toBe(true);
    expect(state.endedAt).toBe(wakeAt);
  });

  it("waits in steps of 30 s, and the last is only what is left", async () => {
    const { steps, pause } = recordingPause();
    const wait = sleepUntil(T0 + 61 * SEC, undefined, pause);

    await awake(61 * SEC);
    await wait;

    expect(MAX_WAIT_STEP_MS).toBe(30 * SEC);
    expect(steps).toEqual([30 * SEC, 30 * SEC, 1 * SEC]);
  });

  it("a target under one step is one wait of exactly that length", async () => {
    const { steps, pause } = recordingPause();
    const wait = sleepUntil(T0 + 12_345, undefined, pause);

    await awake(12_345);
    await wait;

    expect(steps).toEqual([12_345]);
  });

  it("an hour's wait costs 120 wake-ups, not a busy loop", async () => {
    const { steps, pause } = recordingPause();
    const wait = sleepUntil(T0 + HOUR, undefined, pause);

    await awake(HOUR);
    await wait;

    expect(steps).toHaveLength(120);
  });

  it("a target already reached sets no timer", async () => {
    await sleepUntil(T0);
    await sleepUntil(T0 - HOUR);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a target that is not a number ends the wait rather than spinning", async () => {
    await sleepUntil(Number.NaN);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a target months away is still steps of 30 s, past what one timer can hold", async () => {
    const { steps, pause } = recordingPause();
    const controller = new AbortController();
    const wait = sleepUntil(T0 + 60 * 24 * HOUR, controller.signal, pause);

    await awake(30 * SEC);
    controller.abort();
    await wait;

    expect(steps.slice(0, 2)).toEqual([30 * SEC, 30 * SEC]);
  });
});

describe("a clock that jumps forward, as after a lid opened", () => {
  it("is noticed within one step, where one long sleep would still be waiting", async () => {
    const wakeAt = T0 + HOUR;
    const bounded = waitFor(wakeAt);
    let oneLongSleepDone = false;
    void sleep(HOUR).then(() => (oneLongSleepDone = true));

    await awake(10 * SEC);
    vi.setSystemTime(T0 + 5 * HOUR);
    expect(bounded.state.done).toBe(false);

    await awake(MAX_WAIT_STEP_MS);

    expect(bounded.state.done).toBe(true);
    expect(oneLongSleepDone).toBe(false);
  });

  it("takes only what the pending step had left", async () => {
    const { state } = waitFor(T0 + HOUR);

    await awake(10 * SEC); // the first step has 20 s to go
    vi.setSystemTime(T0 + 2 * HOUR);

    await awake(20 * SEC - 1);
    expect(state.done).toBe(false);
    await awake(1);
    expect(state.done).toBe(true);
  });

  it("a jump landing exactly on the target counts as reached", async () => {
    const wakeAt = T0 + HOUR;
    const { state } = waitFor(wakeAt);

    vi.setSystemTime(wakeAt);
    await awake(MAX_WAIT_STEP_MS);

    expect(state.done).toBe(true);
  });

  it("a jump that stops short keeps waiting for the rest, and ends on the target", async () => {
    const wakeAt = T0 + HOUR;
    const { state } = waitFor(wakeAt);

    vi.setSystemTime(T0 + 59 * MIN);
    await awake(MAX_WAIT_STEP_MS);
    expect(state.done).toBe(false);

    await awake(MIN - 1);
    expect(state.done).toBe(true);
    expect(state.endedAt).toBe(wakeAt);
  });
});

describe("a clock that jumps backward", () => {
  it("does not end early: it waits for the target, not for the time it first had left", async () => {
    const wakeAt = T0 + MIN;
    const { state } = waitFor(wakeAt);

    await awake(10 * SEC);
    vi.setSystemTime(T0 - HOUR);

    await awake(50 * SEC); // all the time that was left before the jump
    expect(state.done).toBe(false);

    await awake(HOUR + 10 * SEC - 1); // a millisecond short of the target
    expect(state.done).toBe(false);

    await awake(1);
    expect(state.done).toBe(true);
    expect(state.endedAt).toBe(wakeAt);
  });

  it("a small correction just before the target still ends on the target", async () => {
    const wakeAt = T0 + 30 * SEC;
    const { state } = waitFor(wakeAt);

    await awake(30 * SEC - 1);
    vi.setSystemTime(Date.now() - 5 * SEC);

    await awake(5 * SEC);
    expect(state.done).toBe(false);

    await awake(1);
    expect(state.done).toBe(true);
    expect(state.endedAt).toBe(wakeAt);
  });

  it("set back after passing the target but before the step ended, it waits again", async () => {
    const wakeAt = T0 + HOUR;
    const { state } = waitFor(wakeAt);

    vi.setSystemTime(wakeAt + MIN);
    vi.setSystemTime(wakeAt - MIN);
    await awake(MAX_WAIT_STEP_MS);

    expect(state.done).toBe(false);
    await awake(MIN);
    expect(state.done).toBe(true);
  });
});

describe("repeated sleeps and wakes", () => {
  it("maintenance wakes before the target end nothing; the first past it ends the wait", async () => {
    const wakeAt = T0 + HOUR;
    const { state } = waitFor(wakeAt);

    // Asleep 17 min, awake a few seconds: how a closed-lid Mac's maintenance wakes go.
    for (const minutes of [17, 34, 51]) {
      vi.setSystemTime(T0 + minutes * MIN);
      await awake(5 * SEC);
      expect(state.done).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
    }

    // Past the target: only the step's remaining awake time stands between.
    vi.setSystemTime(T0 + 68 * MIN);
    await awake(MAX_WAIT_STEP_MS);
    expect(state.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("awake time adds up across wakes too short to finish a step on their own", async () => {
    const { state } = waitFor(T0 + HOUR);

    vi.setSystemTime(T0 + 2 * HOUR);
    for (let i = 0; i < 2; i += 1) {
      await awake(10 * SEC);
      expect(state.done).toBe(false);
      vi.setSystemTime(Date.now() + 17 * MIN);
    }

    await awake(10 * SEC);
    expect(state.done).toBe(true);
  });

  it("over random sleeps, wakes and clock changes: never early, never long after, one timer", async () => {
    /** A small seeded PRNG, so the run is the same every time. */
    function rng(seed: number) {
      return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    for (let seed = 1; seed <= 200; seed += 1) {
      const random = rng(seed);
      vi.setSystemTime(T0);
      const wakeAt = T0 + 1 + Math.floor(random() * 6 * HOUR);
      const { state, finished } = waitFor(wakeAt);
      let awakePastTarget = 0;

      for (let turn = 0; !state.done; turn += 1) {
        expect(turn).toBeLessThan(20_000);
        const roll = random();

        if (roll < 0.25) {
          vi.setSystemTime(Date.now() + Math.floor(random() * 2 * HOUR));
        } else if (roll < 0.35) {
          vi.setSystemTime(Date.now() - Math.floor(random() * 10 * MIN));
        } else {
          const slice = 1 + Math.floor(random() * 40 * SEC);
          const wasPastTarget = Date.now() >= wakeAt;
          await awake(slice);
          if (wasPastTarget) awakePastTarget += slice;
        }
        if (Date.now() < wakeAt) awakePastTarget = 0;

        expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
        if (!state.done) expect(awakePastTarget).toBeLessThan(MAX_WAIT_STEP_MS);
      }

      await finished;
      expect(state.endedAt).toBeGreaterThanOrEqual(wakeAt);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

describe("stopping during the wait", () => {
  it("an abort ends a long wait at once and leaves no timer", async () => {
    const controller = new AbortController();
    const { state, finished } = waitFor(T0 + 4 * HOUR, controller.signal);

    await awake(MIN);
    expect(state.done).toBe(false);

    controller.abort();
    await finished;

    expect(state.endedAt).toBe(T0 + MIN);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort that came first means no wait at all", async () => {
    const controller = new AbortController();
    controller.abort();

    await sleepUntil(T0 + HOUR, controller.signal);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("an abort after a clock jump still ends it, without waiting out the step", async () => {
    const controller = new AbortController();
    const { state, finished } = waitFor(T0 + HOUR, controller.signal);

    vi.setSystemTime(T0 + 30 * MIN);
    controller.abort();
    await finished;

    expect(state.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("no abort listener is left behind by the steps it has finished", async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, "addEventListener");
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const wait = sleepUntil(T0 + HOUR, controller.signal);

    await awake(HOUR);
    await wait;

    expect(added).toHaveBeenCalledTimes(120);
    expect(removed).toHaveBeenCalledTimes(120);
  });
});
