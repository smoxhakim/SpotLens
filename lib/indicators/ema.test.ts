import { describe, expect, it } from "vitest";

import { ema, latestEma } from "./ema";

describe("ema", () => {
  it("matches a hand-computed series", () => {
    // period 3 over [1,2,3,4,5]: SMA seed of [1,2,3] = 2, multiplier 2/(3+1) = 0.5.
    //   i=3: (4 - 2) * 0.5 + 2 = 3
    //   i=4: (5 - 3) * 0.5 + 3 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("seeds with a simple moving average, not the first value", () => {
    // A first-value seed would put 10 at index 2; the SMA seed puts 20.
    expect(ema([10, 20, 30], 3)[2]).toBe(20);
  });

  it("stays aligned with the input array", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = ema(values, 4);

    expect(out).toHaveLength(values.length);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).not.toBeNull();
  });

  it("returns a flat line for a constant series", () => {
    const out = ema(new Array(10).fill(42), 5);
    expect(out.slice(4)).toEqual(new Array(6).fill(42));
  });

  it("tracks a rising series without exceeding it", () => {
    const values = Array.from({ length: 60 }, (_, i) => i + 1);
    const out = ema(values, 20);
    const last = out[out.length - 1]!;

    // A lagging average sits below the latest price in an uptrend.
    expect(last).toBeLessThan(values[values.length - 1]);
    expect(last).toBeGreaterThan(values[values.length - 21]);
  });

  it("reacts faster on a shorter period", () => {
    const values = [...new Array(30).fill(100), ...new Array(10).fill(200)];
    const fast = ema(values, 10).at(-1)!;
    const slow = ema(values, 30).at(-1)!;

    expect(fast).toBeGreaterThan(slow);
  });

  it("is undefined until it has a full period of data", () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
    expect(ema([], 5)).toEqual([]);
  });

  it("rejects a nonsensical period", () => {
    expect(() => ema([1, 2, 3], 0)).toThrow(/positive integer/);
    expect(() => ema([1, 2, 3], 2.5)).toThrow(/positive integer/);
  });

  it("latestEma returns the final defined value", () => {
    expect(latestEma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(latestEma([1, 2], 5)).toBeNull();
  });
});
