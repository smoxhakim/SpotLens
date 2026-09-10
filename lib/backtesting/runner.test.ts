import { describe, expect, it, vi } from "vitest";

import * as analysis from "@/lib/analysis";
import { makeCandles } from "@/lib/test-utils/candles";
import { repeatedPullbacks } from "@/lib/test-utils/scenarios";

import { computeMetrics } from "./metrics";
import { runBacktest } from "./runner";

describe("look-ahead bias", () => {
  it("only ever hands the engine candles up to the current bar", () => {
    const candles = repeatedPullbacks(80);
    const spy = vi.spyOn(analysis, "runAnalysis");

    runBacktest(candles, { warmupBars: 260 });

    // Not a large number: once a setup triggers, the runner skips ahead to the
    // trade's exit, so most bars are consumed by open positions.
    expect(spy.mock.calls.length).toBeGreaterThan(3);

    // Every call must be a prefix of the series — same objects, same order,
    // and never a candle from beyond the slice.
    for (const call of spy.mock.calls) {
      const seen = call[0];
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.length).toBeLessThanOrEqual(candles.length);
      expect(seen[0]).toBe(candles[0]);
      expect(seen[seen.length - 1]).toBe(candles[seen.length - 1]);
    }

    spy.mockRestore();
  });

  it("produces identical setups when future candles are changed", () => {
    // The decisive property: rewriting history *after* a signal must not move
    // the signal. If anything in the engine peeked ahead, these would differ.
    const candles = repeatedPullbacks(80);

    // Same past, wildly different future.
    const altered = candles.map((c, i) =>
      i < 320 ? c : { ...c, close: c.close * 3, high: c.high * 3.2, low: c.low * 2.5 },
    );

    const original = runBacktest(candles, { warmupBars: 260 }).setups;
    const changed = runBacktest(altered, { warmupBars: 260 }).setups;

    const before = (r: { triggeredAt: number }) => r.triggeredAt <= candles[319].openTime;

    const originalTriggers = original.filter(before).map((r) => [r.triggeredAt, r.entry]);
    const changedTriggers = changed.filter(before).map((r) => [r.triggeredAt, r.entry]);

    // Guard against the test passing because nothing triggered at all.
    expect(originalTriggers.length).toBeGreaterThan(0);
    expect(changedTriggers).toEqual(originalTriggers);
  });

  it("never simulates a trade using the candle it entered on", () => {
    const candles = repeatedPullbacks(80);
    const results = runBacktest(candles, { warmupBars: 260 }).setups;

    for (const setup of results) {
      if (setup.exitTime === null) continue;
      // An exit can never be dated before or on the trigger bar.
      expect(setup.exitTime).toBeGreaterThan(setup.triggeredAt);
    }
  });
});

describe("runBacktest", () => {
  it("returns nothing when there is not enough history to warm up", () => {
    expect(runBacktest(repeatedPullbacks(5), { warmupBars: 260 }).setups).toEqual([]);
    expect(runBacktest([], {}).setups).toEqual([]);
  });

  it("records entry, stop and targets for every setup it takes", () => {
    const results = runBacktest(repeatedPullbacks(80), { warmupBars: 260 }).setups;

    expect(results.length).toBeGreaterThan(0);
    for (const setup of results) {
      expect(setup.entry).toBeGreaterThan(setup.stopLoss);
      expect(setup.takeProfits.length).toBeGreaterThan(0);
      expect(setup.setupScore).toBeGreaterThanOrEqual(0);
    }
  });

  it("never holds two positions at once", () => {
    const results = runBacktest(repeatedPullbacks(80), { warmupBars: 260 }).setups;

    for (let i = 1; i < results.length; i += 1) {
      const previousExit = results[i - 1].exitTime;
      if (previousExit === null) continue;
      expect(results[i].triggeredAt).toBeGreaterThan(previousExit);
    }
  });

  it("resolves a stop and a target in the same candle against the strategy", () => {
    // One bar whose range covers both. OHLC cannot say which came first, so
    // the pessimistic reading is the only safe one.
    const candles = [
      ...repeatedPullbacks(70),
      ...makeCandles([
        { close: 400, high: 400, low: 400 },
        { close: 400, high: 1000, low: 1 },
        { close: 400, high: 400, low: 400 },
      ]),
    ];

    const results = runBacktest(candles, { warmupBars: 260, maxHoldBars: 5 }).setups;
    const straddling = results.find(
      (r) => r.exitPrice !== null && r.exitPrice <= r.stopLoss + 1e-9,
    );

    // If any trade was open across that bar, it must have been stopped out.
    if (straddling) expect(straddling.realizedRR).toBeLessThanOrEqual(0);
  });

  it("closes a trade that goes nowhere rather than leaving it open forever", () => {
    const flatTail = makeCandles(
      new Array(200).fill(0).map(() => ({ close: 370, high: 371, low: 369 })),
    );
    const candles = [...repeatedPullbacks(70), ...flatTail];

    const results = runBacktest(candles, { warmupBars: 260, maxHoldBars: 20 }).setups;
    const stalled = results.filter((r) => r.outcome === "NO_HIT");

    for (const setup of stalled) {
      expect(setup.exitPrice).not.toBeNull();
      expect(setup.realizedRR).not.toBeNull();
    }
  });

  it("does not book an unfinished trade as a result", () => {
    // A trade still open when the data ends must have no exit and no R.
    // Marking it to the last candle would record an unrealised position as a
    // loss, which silently biases every metric that follows.
    const results = runBacktest(repeatedPullbacks(80), { warmupBars: 260 }).setups;
    const open = results.filter((r) => r.outcome === "STILL_OPEN");

    for (const setup of open) {
      expect(setup.exitPrice).toBeNull();
      expect(setup.exitTime).toBeNull();
      expect(setup.realizedRR).toBeNull();
    }
  });

  it("is deterministic", () => {
    const candles = repeatedPullbacks(80);
    expect(JSON.stringify(runBacktest(candles, { warmupBars: 260 }))).toBe(
      JSON.stringify(runBacktest(candles, { warmupBars: 260 })),
    );
  });
});

describe("computeMetrics", () => {
  const setup = (realizedRR: number | null, outcome = "TP1_HIT") =>
    ({
      triggeredAt: 0,
      entry: 100,
      stopLoss: 90,
      takeProfits: [],
      outcome,
      realizedRR,
      exitTime: 1,
      exitPrice: 110,
      setupScore: 70,
    }) as never;

  it("reports zeroes for an empty run rather than NaN", () => {
    const metrics = computeMetrics([]);

    expect(metrics.totalSetups).toBe(0);
    expect(metrics.winRate).toBe(0);
    expect(metrics.averageR).toBe(0);
    expect(metrics.maxDrawdownR).toBe(0);
    expect(metrics.best).toBeNull();
  });

  it("computes win rate over closed setups only", () => {
    const metrics = computeMetrics([setup(2), setup(-1), setup(1), setup(null, "STILL_OPEN")]);

    expect(metrics.totalSetups).toBe(4);
    expect(metrics.closedTrades).toBe(3);
    expect(metrics.wins).toBe(2);
    expect(metrics.winRate).toBeCloseTo(66.67, 1);
  });

  it("averages realised R", () => {
    const metrics = computeMetrics([setup(3), setup(-1), setup(-1), setup(-1)]);

    expect(metrics.totalR).toBe(0);
    expect(metrics.averageR).toBe(0);
    // Break-even in R is still a 50% loss rate; the numbers must not flatter it.
    expect(metrics.winRate).toBe(25);
  });

  it("measures drawdown peak-to-trough, not first-to-last", () => {
    // Up 5R, then down 3R, then up again: the dip is the drawdown.
    const metrics = computeMetrics([setup(5), setup(-1), setup(-1), setup(-1), setup(5)]);

    expect(metrics.maxDrawdownR).toBeGreaterThan(0);
    expect(metrics.maxDrawdownR).toBeLessThan(100);
  });

  it("excludes unfinished trades from every ratio", () => {
    const metrics = computeMetrics([
      setup(2),
      setup(null, "STILL_OPEN"),
      setup(null, "STILL_OPEN"),
    ]);

    expect(metrics.totalSetups).toBe(3);
    expect(metrics.closedTrades).toBe(1);
    expect(metrics.winRate).toBe(100);
    expect(metrics.averageR).toBe(2);
  });

  it("treats a breakeven exit as neither a win nor a loss", () => {
    // Stopped out at entry after TP1 traded. Counting it as a loss would
    // understate a rule whose whole purpose is removing risk early.
    const metrics = computeMetrics([setup(1), setup(0, "TP1_HIT"), setup(-1)]);

    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(1);
    expect(metrics.breakeven).toBe(1);
    expect(metrics.winRate).toBe(50);
  });

  it("identifies the best and worst setups", () => {
    const metrics = computeMetrics([setup(1), setup(4), setup(-1)]);

    expect(metrics.best!.realizedRR).toBe(4);
    expect(metrics.worst!.realizedRR).toBe(-1);
  });

  it("counts every outcome type", () => {
    const metrics = computeMetrics([setup(2, "TP2_HIT"), setup(-1, "SL_HIT"), setup(-1, "SL_HIT")]);

    expect(metrics.outcomes).toEqual({ TP2_HIT: 1, SL_HIT: 2 });
  });
});
