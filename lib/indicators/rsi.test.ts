import { describe, expect, it } from "vitest";

import { latestRsi, rsi } from "./rsi";

/**
 * Wilder's worked example from "New Concepts in Technical Trading Systems",
 * the series reproduced in most RSI references.
 */
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
  46.28, 46.0, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18,
  44.22, 44.57, 43.42, 42.66, 43.13,
];

describe("rsi", () => {
  it("matches the value derived by hand from Wilder's series", () => {
    // Over the first 14 changes: gains sum to 3.34, losses to 1.40.
    // avgGain = 0.238571, avgLoss = 0.100000, RS = 2.385714
    // RSI = 100 - 100 / (1 + RS) = 70.4641
    //
    // Published tables often show 70.53 here. That comes from a source series
    // carrying more precision than the 2dp closes above; 70.46 is the correct
    // result for these exact inputs, verified by hand.
    expect(rsi(WILDER_CLOSES, 14)[14]!).toBeCloseTo(70.4641, 3);
  });

  it("follows Wilder's smoothing on subsequent values", () => {
    const out = rsi(WILDER_CLOSES, 14);
    expect(out[15]!).toBeCloseTo(66.25, 1);
    expect(out[16]!).toBeCloseTo(66.48, 1);
    expect(out.at(-1)!).toBeCloseTo(37.79, 1);
  });

  it("matches a hand-computed short series", () => {
    // period 2 over [10,11,12,11,12]; changes: +1, +1, -1, +1
    //   seed:  avgGain 1,    avgLoss 0     -> saturates at 100
    //   i=3:   avgGain 0.5,  avgLoss 0.5   -> RS 1 -> 50
    //   i=4:   avgGain 0.75, avgLoss 0.25  -> RS 3 -> 75
    expect(rsi([10, 11, 12, 11, 12], 2)).toEqual([null, null, 100, 50, 75]);
  });

  it("saturates at 100 when every change is a gain", () => {
    expect(latestRsi([1, 2, 3, 4, 5, 6], 3)).toBe(100);
  });

  it("bottoms out at 0 when every change is a loss", () => {
    expect(latestRsi([6, 5, 4, 3, 2, 1], 3)).toBe(0);
  });

  it("reads 50 for a flat series rather than dividing by zero", () => {
    // No gains and no losses is neutral, not NaN or 100.
    expect(latestRsi(new Array(20).fill(100), 14)).toBe(50);
  });

  it("stays within 0-100 across a noisy series", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 20 + (i % 7));
    for (const value of rsi(noisy, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("needs period + 1 values, since it reads price changes", () => {
    // 14 values give only 13 changes — not enough for RSI(14).
    expect(rsi(new Array(14).fill(1), 14).every((v) => v === null)).toBe(true);
    expect(rsi(new Array(15).fill(1), 14).at(-1)).not.toBeNull();
  });

  it("stays aligned with the input array", () => {
    const values = Array.from({ length: 40 }, (_, i) => i + 1);
    const out = rsi(values, 14);

    expect(out).toHaveLength(values.length);
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
  });

  it("rejects a nonsensical period", () => {
    expect(() => rsi([1, 2, 3], 0)).toThrow(/positive integer/);
  });
});
