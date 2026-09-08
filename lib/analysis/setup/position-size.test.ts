import { describe, expect, it } from "vitest";

import { calculatePositionSize } from "./position-size";

describe("calculatePositionSize", () => {
  it("sizes from the stop distance, not a fixed fraction of balance", () => {
    // Risk 1% of 10,000 = 100. Stop is 10 below entry, so 10 units.
    const result = calculatePositionSize({
      balance: 10_000,
      riskPercent: 1,
      entry: 100,
      stopLoss: 90,
    })!;

    expect(result.riskAmount).toBe(100);
    expect(result.positionSize).toBe(10);
    expect(result.positionValue).toBe(1_000);
  });

  it("needs a bigger position when the stop is tighter", () => {
    const wide = calculatePositionSize({
      balance: 10_000,
      riskPercent: 1,
      entry: 100,
      stopLoss: 90,
    })!;
    const tight = calculatePositionSize({
      balance: 10_000,
      riskPercent: 1,
      entry: 100,
      stopLoss: 99,
    })!;

    expect(tight.positionSize).toBeGreaterThan(wide.positionSize);
    // Same money at risk either way — that is the point of the calculation.
    expect(tight.riskAmount).toBe(wide.riskAmount);
  });

  it("warns when the position costs more than the whole balance", () => {
    // A very tight stop with a large risk budget demands more than you have.
    const result = calculatePositionSize({
      balance: 1_000,
      riskPercent: 5,
      entry: 100,
      stopLoss: 99.5,
    })!;

    expect(result.positionValue).toBeGreaterThan(result.riskAmount);
    expect(result.note).toMatch(/more than the whole balance/i);
    expect(result.note).toMatch(/leverage, which SpotLens does not support/i);
  });

  it("always repeats the risk warning", () => {
    const result = calculatePositionSize({
      balance: 5_000,
      riskPercent: 2,
      entry: 50,
      stopLoss: 45,
    })!;
    expect(result.note).toMatch(/never risk money that you cannot afford to lose/i);
  });

  it("rejects nonsensical input rather than returning a number", () => {
    const bad = [
      { balance: 0, riskPercent: 1, entry: 100, stopLoss: 90 },
      { balance: 1000, riskPercent: 0, entry: 100, stopLoss: 90 },
      { balance: 1000, riskPercent: 150, entry: 100, stopLoss: 90 },
      { balance: 1000, riskPercent: 1, entry: 100, stopLoss: 100 },
      { balance: 1000, riskPercent: 1, entry: 100, stopLoss: 110 },
      { balance: 1000, riskPercent: 1, entry: 0, stopLoss: 0 },
      { balance: Number.NaN, riskPercent: 1, entry: 100, stopLoss: 90 },
    ];

    for (const input of bad) {
      expect(calculatePositionSize(input), JSON.stringify(input)).toBeNull();
    }
  });
});
