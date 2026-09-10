import { describe, expect, it, vi } from "vitest";

import * as analysis from "@/lib/analysis";
import { makeCandles } from "@/lib/test-utils/candles";
import { downtrend, repeatedPullbacks } from "@/lib/test-utils/scenarios";
import { TIMEFRAME_MS, type Candle } from "@/lib/market-data/provider";

import { runBacktest } from "./runner";

/**
 * The two P0 defects this file covers are both about a backtest quietly
 * testing something other than what was asked for:
 *
 *  - the warmup being taken out of the requested range, so the first months of
 *    it were never evaluated;
 *  - the replay running single-timeframe while the live tool it claims to
 *    reproduce reads a higher timeframe as well.
 */

const WARMUP = 260;

/** Splits a series into pre-roll history and the range under test. */
function splitAt(candles: Candle[], index: number) {
  return { evaluateFrom: candles[index].openTime };
}

describe("warmup is history, not a bite out of the requested range", () => {
  it("reports warmup, evaluated and total separately", () => {
    const candles = repeatedPullbacks(80);
    const report = runBacktest(candles, { warmupBars: WARMUP, ...splitAt(candles, WARMUP) });

    expect(report.candlesUsed).toBe(candles.length);
    expect(report.warmupBars).toBe(WARMUP);
    expect(report.evaluatedBars).toBe(candles.length - 1 - WARMUP);
    // The three have to add up, or the report is describing a different run.
    expect(report.warmupBars + report.evaluatedBars).toBe(report.candlesUsed - 1);
  });

  it("can trigger a setup on the very first candle of the requested range", () => {
    // The defect in one assertion. With the pre-roll supplied as history, bar
    // `WARMUP` is the first bar of the requested range and must be evaluated —
    // previously it was consumed as warmup and could never report anything.
    const candles = repeatedPullbacks(80);
    const spy = vi.spyOn(analysis, "runAnalysis");

    const report = runBacktest(candles, { warmupBars: WARMUP, ...splitAt(candles, WARMUP) });

    const firstEvaluated = spy.mock.calls[0][0];
    expect(firstEvaluated.length).toBe(WARMUP + 1);
    expect(firstEvaluated.at(-1)).toBe(candles[WARMUP]);
    expect(report.evaluatedFrom).toBe(candles[WARMUP].openTime);

    spy.mockRestore();
  });

  it("starts at the requested range rather than at the warmup count when pre-roll is longer", () => {
    const candles = repeatedPullbacks(120);
    // Twice the warmup available as history before the range begins.
    const rangeStart = WARMUP * 2;
    const report = runBacktest(candles, {
      warmupBars: WARMUP,
      ...splitAt(candles, rangeStart),
    });

    expect(report.warmupBars).toBe(rangeStart);
    expect(report.evaluatedFrom).toBe(candles[rangeStart].openTime);
    // Nothing may be reported from inside the pre-roll.
    for (const setup of report.setups) {
      expect(setup.triggeredAt).toBeGreaterThanOrEqual(candles[rangeStart].openTime);
    }
  });

  it("still refuses to evaluate a range with too little history in front of it", () => {
    // Requested range starts at bar 10, far short of a warm engine. Evaluation
    // waits until the engine is warm rather than reporting from cold indicators.
    const candles = repeatedPullbacks(80);
    const report = runBacktest(candles, { warmupBars: WARMUP, ...splitAt(candles, 10) });

    expect(report.warmupBars).toBe(WARMUP);
    expect(report.evaluatedFrom).toBe(candles[WARMUP].openTime);
  });

  it("evaluates nothing when the range leaves no room after warmup", () => {
    const candles = repeatedPullbacks(53); // 265 candles
    const report = runBacktest(candles, { warmupBars: WARMUP });

    expect(report.evaluatedBars).toBeLessThanOrEqual(candles.length - 1 - WARMUP);
    expect(report.setups.length).toBe(0);
  });
});

/**
 * Builds a higher-timeframe series aligned to a lower-timeframe one.
 *
 * Each higher candle spans `ratio` lower candles and closes exactly when the
 * last of them does, which is what the exchange's own aggregation guarantees.
 */
function higherFrom(lower: Candle[], ratio: number, price: (i: number) => number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i + ratio <= lower.length; i += ratio) {
    const close = price(out.length);
    const prev = out.length === 0 ? close : out[out.length - 1].close;
    out.push({
      openTime: lower[i].openTime,
      open: prev,
      high: Math.max(prev, close),
      low: Math.min(prev, close),
      close,
      volume: 100,
      closeTime: lower[i + ratio - 1].closeTime,
    });
  }
  return out;
}

describe("backtest / live multi-timeframe parity", () => {
  const lower = repeatedPullbacks(80);
  const RATIO = 4;

  const bullishHigher = higherFrom(lower, RATIO, (i) => 100 + i * 2);
  const bearishHigher = higherFrom(lower, RATIO, (i) => 5000 - i * 12);

  it("hands the engine the same higher-timeframe read a live MTF run would build", () => {
    const spy = vi.spyOn(analysis, "runAnalysis");

    runBacktest(lower, {
      warmupBars: WARMUP,
      mtf: { candles: bullishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
    });

    const optionsSeen = spy.mock.calls.map((call) => call[1]);
    expect(optionsSeen.length).toBeGreaterThan(0);

    for (const [index, options] of optionsSeen.entries()) {
      const mtf = options?.mtf;
      expect(mtf, `call ${index} ran without higher-timeframe context`).toBeDefined();
      expect(mtf!.higherTimeframe).toBe("H4");
      expect(mtf!.lowerTimeframe).toBe("H1");
    }

    spy.mockRestore();
  });

  it("never reads a higher-timeframe candle that had not closed yet", () => {
    const spy = vi.spyOn(analysis, "analyzeMultiTimeframe");

    runBacktest(lower, {
      warmupBars: WARMUP,
      mtf: { candles: bullishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
    });

    expect(spy.mock.calls.length).toBeGreaterThan(0);

    for (const [input] of spy.mock.calls) {
      const currentLower = input.lowerCandles.at(-1)!;
      for (const higher of input.higherCandles) {
        // The rule, stated exactly: a higher-timeframe candle is only visible
        // once it has closed at or before the bar being judged.
        expect(higher.closeTime).toBeLessThanOrEqual(currentLower.closeTime);
      }
    }

    spy.mockRestore();
  });

  it("is unaffected by rewriting higher-timeframe candles that had not closed yet", () => {
    // The decisive property. If any future higher-timeframe bar leaked into a
    // decision, changing those bars would move the setups.
    // Chosen inside the evaluated window: a cutoff during warmup would compare
    // two empty lists and pass without proving anything.
    const cutoffIndex = Math.floor(bullishHigher.length * 0.8);
    const cutoff = bullishHigher[cutoffIndex].closeTime;

    const altered = bullishHigher.map((c, i) =>
      i <= cutoffIndex ? c : { ...c, close: c.close / 10, high: c.high / 10, low: c.low / 10 },
    );

    const options = { warmupBars: WARMUP, lowerTimeframe: "H1" as const };
    const original = runBacktest(lower, {
      ...options,
      mtf: { candles: bullishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
    }).setups;
    const changed = runBacktest(lower, {
      ...options,
      mtf: { candles: altered, lowerTimeframe: "H1", higherTimeframe: "H4" },
    }).setups;

    const upTo = (s: { triggeredAt: number }) => s.triggeredAt <= cutoff;
    const before = original.filter(upTo).map((s) => [s.triggeredAt, s.entry]);

    expect(before.length).toBeGreaterThan(0);
    expect(changed.filter(upTo).map((s) => [s.triggeredAt, s.entry])).toEqual(before);
  });

  it("applies the counter-trend veto, so a bearish higher timeframe removes the setups", () => {
    const withoutContext = runBacktest(lower, { warmupBars: WARMUP }).setups;
    const withBearishContext = runBacktest(lower, {
      warmupBars: WARMUP,
      mtf: { candles: bearishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
    }).setups;

    // Guard against the test passing because nothing triggered either way.
    expect(withoutContext.length).toBeGreaterThan(0);
    expect(withBearishContext.length).toBe(0);
  });

  it("does not veto when the higher timeframe agrees", () => {
    const aligned = runBacktest(lower, {
      warmupBars: WARMUP,
      mtf: { candles: bullishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
    }).setups;

    expect(aligned.length).toBeGreaterThan(0);
  });

  it("runs single-timeframe for bars before the first higher-timeframe candle closed", () => {
    const spy = vi.spyOn(analysis, "runAnalysis");

    // Higher-timeframe history that begins long after the replay does.
    const late = bullishHigher.filter((c) => c.openTime > lower[lower.length - 20].openTime);
    runBacktest(lower, {
      warmupBars: WARMUP,
      mtf: { candles: late, lowerTimeframe: "H1", higherTimeframe: "H4" },
    });

    // Bars with no closed higher candle behind them get no MTF rather than a
    // trend read taken from an empty series.
    expect(spy.mock.calls.some((call) => call[1]?.mtf === undefined)).toBe(true);

    spy.mockRestore();
  });

  it("produces identical results when the same run is repeated", () => {
    const once = runBacktest(lower, {
      warmupBars: WARMUP,
      mtf: { candles: bullishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
    });
    const twice = runBacktest(lower, {
      warmupBars: WARMUP,
      mtf: { candles: bullishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
    });

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("reports which higher timeframe was used, so a run states what it tested", () => {
    expect(
      runBacktest(lower, {
        warmupBars: WARMUP,
        mtf: { candles: bullishHigher, lowerTimeframe: "H1", higherTimeframe: "H4" },
      }).higherTimeframe,
    ).toBe("H4");

    expect(runBacktest(lower, { warmupBars: WARMUP }).higherTimeframe).toBeNull();
  });

  it("offers nothing on a falling market whichever way it is run", () => {
    const bear = downtrend();
    expect(runBacktest(bear, { warmupBars: 60 }).setups).toEqual([]);
  });

  it("survives a higher-timeframe series that does not reach the replay at all", () => {
    const disjoint = makeCandles([100, 101, 102], {
      startTime: lower[0].openTime - 500 * TIMEFRAME_MS.H4,
      timeframe: "H4",
    });

    expect(() =>
      runBacktest(lower, {
        warmupBars: WARMUP,
        mtf: { candles: disjoint, lowerTimeframe: "H1", higherTimeframe: "H4" },
      }),
    ).not.toThrow();
  });
});
