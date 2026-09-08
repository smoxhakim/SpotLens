import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";

import { atr, latestAtr, trueRange } from "./atr";

describe("trueRange", () => {
  it("uses the bar's own range when there is no gap", () => {
    const candles = makeCandles([
      { close: 10, high: 12, low: 8 },
      { close: 11, high: 13, low: 9 },
    ]);
    expect(trueRange(candles)).toEqual([4, 4]);
  });

  it("counts a gap up from the previous close", () => {
    // Bar 2 spans only 2, but opened 8 above the prior close of 10.
    const candles = makeCandles([
      { close: 10, high: 10, low: 10 },
      { close: 19, high: 20, low: 18 },
    ]);
    expect(trueRange(candles)[1]).toBe(10);
  });

  it("counts a gap down from the previous close", () => {
    const candles = makeCandles([
      { close: 100, high: 100, low: 100 },
      { close: 91, high: 92, low: 90 },
    ]);
    expect(trueRange(candles)[1]).toBe(10);
  });

  it("falls back to the bar range on the first candle", () => {
    expect(trueRange(makeCandles([{ close: 5, high: 7, low: 4 }]))).toEqual([3]);
  });
});

describe("atr", () => {
  it("averages a constant range to that range", () => {
    const candles = makeCandles(new Array(30).fill(0).map(() => ({ close: 10, high: 12, low: 8 })));
    expect(latestAtr(candles, 14)).toBeCloseTo(4, 10);
  });

  it("matches a hand-computed seed", () => {
    // Three bars of range 2, 4, 6 with no gaps; ATR(3) seed = (2+4+6)/3 = 4.
    const candles = makeCandles([
      { close: 10, high: 11, low: 9 },
      { close: 10, high: 12, low: 8 },
      { close: 10, high: 13, low: 7 },
    ]);
    expect(atr(candles, 3)[2]).toBeCloseTo(4, 10);
  });

  it("applies Wilder smoothing after the seed", () => {
    // Fourth bar has range 10: ATR = (4 * 2 + 10) / 3 = 6.
    const candles = makeCandles([
      { close: 10, high: 11, low: 9 },
      { close: 10, high: 12, low: 8 },
      { close: 10, high: 13, low: 7 },
      { close: 10, high: 15, low: 5 },
    ]);
    expect(atr(candles, 3)[3]).toBeCloseTo(6, 10);
  });

  it("stays aligned and undefined before it has a full period", () => {
    const candles = makeCandles(new Array(20).fill(0).map(() => ({ close: 10, high: 11, low: 9 })));
    const out = atr(candles, 14);

    expect(out).toHaveLength(20);
    expect(out.slice(0, 13).every((v) => v === null)).toBe(true);
    expect(out[13]).not.toBeNull();
  });

  it("is zero for a market that never moves", () => {
    const candles = makeCandles(
      new Array(20).fill(0).map(() => ({ close: 10, high: 10, low: 10 })),
    );
    expect(latestAtr(candles, 14)).toBe(0);
  });

  it("rejects a nonsensical period", () => {
    expect(() => atr(makeCandles([{ close: 1, high: 1, low: 1 }]), 0)).toThrow(/positive integer/);
  });
});
