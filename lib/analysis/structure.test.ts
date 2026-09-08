import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";

import { findSwingPoints, readStructure } from "./structure";

/** Zig-zag helper: builds a series that peaks and troughs at given prices. */
function zigzag(points: number[], stepsBetween = 3): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i];
    const to = points[i + 1];
    for (let s = 0; s < stepsBetween; s += 1) {
      out.push(from + ((to - from) * s) / stepsBetween);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

describe("findSwingPoints", () => {
  it("finds a single peak and trough", () => {
    const candles = makeCandles([10, 11, 12, 15, 12, 11, 10, 8, 5, 8, 9, 10, 11]);
    const swings = findSwingPoints(candles, 2);

    expect(swings.map((s) => s.type)).toEqual(["HIGH", "LOW"]);
    expect(swings[0].price).toBe(15);
    expect(swings[1].price).toBe(5);
  });

  it("never marks a swing in the final candles, which are unconfirmed", () => {
    // 20 rises to a peak at the very end — it cannot be a confirmed swing yet.
    const candles = makeCandles([10, 11, 12, 13, 14, 20]);
    const swings = findSwingPoints(candles, 2);

    expect(swings.every((s) => s.index <= candles.length - 3)).toBe(true);
  });

  it("resolves an equal-high plateau to its last candle, so double tops survive", () => {
    // Strict inequality on both sides would find no swing here at all.
    // Highs are set explicitly so the plateau is exactly two candles wide.
    const candles = makeCandles([
      { close: 10, high: 10, low: 10 },
      { close: 11, high: 11, low: 11 },
      { close: 20, high: 20, low: 20 },
      { close: 20, high: 20, low: 20 },
      { close: 12, high: 12, low: 12 },
      { close: 11, high: 11, low: 11 },
      { close: 10, high: 10, low: 10 },
    ]);
    const highs = findSwingPoints(candles, 2).filter((s) => s.type === "HIGH");

    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(20);
    // The last candle of the plateau — the most recent touch of the level.
    expect(highs[0].index).toBe(3);
  });

  it("always returns a strictly alternating high/low series", () => {
    // Collapsing consecutive same-type swings is what stops a cluster of noisy
    // peaks from reading as "lower highs". Checked over jagged data, where raw
    // fractal detection does produce same-type runs.
    const jagged = Array.from(
      { length: 300 },
      (_, i) => 100 + Math.sin(i / 2.3) * 12 + Math.sin(i / 7.1) * 25 + (i % 5) * 1.5,
    );
    const swings = findSwingPoints(makeCandles(jagged), 1);

    expect(swings.length).toBeGreaterThan(10);
    for (let i = 1; i < swings.length; i += 1) {
      expect(swings[i].type).not.toBe(swings[i - 1].type);
    }
  });

  it("returns nothing for a series too short to confirm a swing", () => {
    expect(findSwingPoints(makeCandles([1, 2, 3]), 2)).toEqual([]);
    expect(findSwingPoints([], 2)).toEqual([]);
  });

  it("finds no swings in a flat market", () => {
    expect(findSwingPoints(makeCandles(new Array(20).fill(100)), 2)).toEqual([]);
  });

  it("rejects a nonsensical lookback", () => {
    expect(() => findSwingPoints(makeCandles([1, 2, 3]), 0)).toThrow(/positive integer/);
  });

  it("carries the candle time so swings can be drawn on the chart", () => {
    const candles = makeCandles([10, 11, 15, 11, 10, 9, 10]);
    const swings = findSwingPoints(candles, 2);

    expect(swings[0].time).toBe(candles[swings[0].index].openTime);
  });
});

describe("readStructure", () => {
  it("reads higher highs and higher lows as an uptrend", () => {
    const candles = makeCandles(zigzag([10, 20, 15, 30, 25, 40, 35, 30], 4));
    const read = readStructure(candles, 2);

    expect(read.labels).toEqual({ high: "HH", low: "HL" });
    expect(read.structure).toBe("UPTREND");
  });

  it("reads lower highs and lower lows as a downtrend", () => {
    const candles = makeCandles(zigzag([40, 35, 20, 30, 15, 25, 10, 15], 4));
    const read = readStructure(candles, 2);

    expect(read.labels).toEqual({ high: "LH", low: "LL" });
    expect(read.structure).toBe("DOWNTREND");
  });

  it("calls a range when highs and lows disagree", () => {
    // Higher highs (30 -> 35) but lower lows (15 -> 10): expanding, not trending.
    const candles = makeCandles(zigzag([20, 30, 15, 35, 10, 20], 4));
    const read = readStructure(candles, 2);

    expect(read.labels).toEqual({ high: "HH", low: "LL" });
    expect(read.structure).toBe("RANGING");
  });

  it("is UNDETERMINED without two highs and two lows", () => {
    const read = readStructure(makeCandles([10, 12, 20, 12, 10, 11, 12]), 2);

    expect(read.structure).toBe("UNDETERMINED");
    expect(read.labels.high).toBeNull();
  });

  it("exposes the swings behind its verdict", () => {
    const candles = makeCandles(zigzag([10, 20, 15, 30, 25, 40, 35, 30], 4));
    const read = readStructure(candles, 2);

    expect(read.lastHigh!.price).toBeGreaterThan(read.previousHigh!.price);
    expect(read.lastLow!.price).toBeGreaterThan(read.previousLow!.price);
    expect(read.swings.length).toBeGreaterThanOrEqual(4);
  });
});
