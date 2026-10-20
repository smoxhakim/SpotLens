import { beforeEach, describe, expect, it, vi } from "vitest";

import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import type { StopLoss, TakeProfitTarget } from "./types";

/**
 * What `runAnalysis` does with levels that are not in long order.
 *
 * The calculators no longer produce such a set, so they are replaced here with
 * ones that do — this is the guard behind them, tested on its own. Each double
 * falls through to the real function unless a test sets it.
 */

const doubles = vi.hoisted(() => ({
  /** Target levels as R-multiples of the real risk, or null for the real ladder. */
  multiples: null as number[] | null,
  /** Where to put the stop, relative to the entry zone, or null for the real one. */
  stopAt: null as ((entry: { low: number; mid: number }) => number) | null,
  riskRewardCalls: 0,
}));

vi.mock("./take-profit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./take-profit")>();
  return {
    ...actual,
    calculateTakeProfits: (...args: Parameters<typeof actual.calculateTakeProfits>) => {
      if (!doubles.multiples) return actual.calculateTakeProfits(...args);
      const [, entry, stop] = args;
      const risk = entry.mid - stop.price;
      return doubles.multiples.map((rr, i): TakeProfitTarget => ({
        label: (["TP1", "TP2", "TP3"] as const)[i],
        level: entry.mid + risk * rr,
        reason: "test",
        rr,
        kind: "STRUCTURAL",
      }));
    },
  };
});

vi.mock("./stop-loss", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stop-loss")>();
  return {
    ...actual,
    calculateStopLoss: (...args: Parameters<typeof actual.calculateStopLoss>) => {
      const real = actual.calculateStopLoss(...args);
      if (!doubles.stopAt || !real) return real;
      return { ...real, price: doubles.stopAt(args[1]) } satisfies StopLoss;
    },
  };
});

vi.mock("./risk-reward", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./risk-reward")>();
  return {
    ...actual,
    calculateRiskReward: (...args: Parameters<typeof actual.calculateRiskReward>) => {
      doubles.riskRewardCalls += 1;
      return actual.calculateRiskReward(...args);
    },
  };
});

const { runAnalysis } = await import("./index");

const BASELINE = runAnalysis(pullbackIntoSupport());

beforeEach(() => {
  doubles.multiples = null;
  doubles.stopAt = null;
  doubles.riskRewardCalls = 0;
});

/** Every way a set was refused: no levels, no score, no ratio, and a wait. */
function expectRefused(result: ReturnType<typeof runAnalysis>, reason: RegExp) {
  expect(result.setup).toBeNull();
  expect(result.score).toBeNull();
  expect(result.confirmation).toBeNull();
  expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
  expect(result.statusReason).toMatch(reason);
  // The ratio was never measured against levels that failed the check.
  expect(doubles.riskRewardCalls).toBe(0);
}

describe("runAnalysis — an invalid level set is refused, not rearranged", () => {
  it("refuses TP3 below TP2 (the LTC/USDT 1h shape)", () => {
    // TP1 is above the zone here; at LTC's own 0.16R it would sit inside this
    // fixture's wider zone, and be refused for that first.
    doubles.multiples = [1.2, 5.74, 4];
    expectRefused(runAnalysis(pullbackIntoSupport()), /TP3 sits below TP2/);
  });

  it("refuses TP2 below TP1", () => {
    doubles.multiples = [3, 2.5, 4];
    expectRefused(runAnalysis(pullbackIntoSupport()), /TP2 sits below TP1/);
  });

  it("refuses a TP1 on the entry zone's ceiling or inside it", () => {
    doubles.multiples = [0, 2, 3]; // at the mid: inside the zone
    expectRefused(runAnalysis(pullbackIntoSupport()), /TP1 is not above the entry zone/);
  });

  it("refuses a stop that is not below the entry zone", () => {
    doubles.stopAt = (entry) => entry.low; // on the floor, not under it
    expectRefused(runAnalysis(pullbackIntoSupport()), /stop loss is not below the entry zone/);

    doubles.stopAt = (entry) => (entry.low + entry.mid) / 2; // inside the zone
    expectRefused(runAnalysis(pullbackIntoSupport()), /stop loss is not below the entry zone/);
  });

  it("says no target exists when the ladder is empty", () => {
    doubles.multiples = [];
    const result = runAnalysis(pullbackIntoSupport());
    expect(result.setup).toBeNull();
    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(result.statusReason).toMatch(/No target above the entry zone/);
  });

  it("never reaches POTENTIAL_SETUP on a set that fails, from a chart that otherwise does", () => {
    // The unmodified chart is a potential setup, so each refusal below is the
    // guard and nothing else.
    expect(BASELINE.status).toBe("POTENTIAL_SETUP");

    for (const multiples of [
      [2, 1.5],
      [0, 3],
      [-1, 2],
      [3, 3.5, 2],
      [1.5, 2.5, 2.4],
    ]) {
      doubles.multiples = multiples;
      const result = runAnalysis(pullbackIntoSupport());
      expect(result.status, multiples.join(",")).not.toBe("POTENTIAL_SETUP");
      expect(result.setup, multiples.join(",")).toBeNull();
    }
  });
});

describe("runAnalysis — a valid ladder keeps its meaning", () => {
  it("is untouched by the guard: same levels, same ratio, same verdict", () => {
    const result = runAnalysis(pullbackIntoSupport());
    expect(result).toEqual(BASELINE);
    expect(doubles.riskRewardCalls).toBe(1);
  });

  it("allows equal adjacent targets, which the order permits", () => {
    doubles.multiples = [1.5, 2.5, 2.5];
    const result = runAnalysis(pullbackIntoSupport());
    expect(result.setup).not.toBeNull();
  });

  it("measures the ratio to the second structural target, as before", () => {
    doubles.multiples = [1.2, 3, 5];
    const result = runAnalysis(pullbackIntoSupport());
    expect(result.setup!.riskReward).toMatchObject({ measuredTo: "TP2", isSynthetic: false });
    expect(result.setup!.riskReward.ratio).toBeCloseTo(3, 6);
  });
});
