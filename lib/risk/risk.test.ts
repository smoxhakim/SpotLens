import { describe, expect, it } from "vitest";

import { runAnalysis } from "@/lib/analysis";
import { extendedAboveSupport, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import { calculateRisk } from "./calculate";
import { HIGH_RISK_PERCENT, type RiskInput, type RiskResult } from "./types";

/**
 * The calculation that decides whether a losing trade is survivable.
 *
 * The property under test throughout is that capital and risk are different
 * numbers: a 100 account risking 1% buys a 20 position, not a 100 one and not
 * a 1 one.
 */

const BASE: RiskInput = { balance: 100, riskPercent: 1, entry: 100, stopLoss: 95 };

function ok(input: Partial<RiskInput> = {}) {
  const result = calculateRisk({ ...BASE, ...input });
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.errors)}`);
  return result.calculation;
}

function errors(input: Partial<RiskInput>) {
  const result = calculateRisk({ ...BASE, ...input }) as Extract<RiskResult, { ok: false }>;
  expect(result.ok).toBe(false);
  return result.errors.map((e) => e.code);
}

describe("position size from the stop distance", () => {
  it("sizes the worked example: 100 balance, 1%, entry 100, stop 95 → 20", () => {
    const c = ok({ feeRate: 0 });

    expect(c.intendedRiskAmount).toBeCloseTo(1);
    expect(c.stopDistance).toBeCloseTo(5);
    expect(c.stopDistancePercent).toBeCloseTo(5);
    expect(c.positionQuote).toBeCloseTo(20);
    expect(c.quantity).toBeCloseTo(0.2);

    // The whole point: the account is 100, the risk is 1, the position is 20.
    expect(c.balance).toBe(100);
    expect(c.positionQuote).not.toBeCloseTo(c.balance);
    expect(c.positionQuote).not.toBeCloseTo(c.intendedRiskAmount);
  });

  it("scales with the balance", () => {
    expect(ok({ balance: 1000, feeRate: 0 }).positionQuote).toBeCloseTo(200);
    expect(ok({ balance: 10_000, feeRate: 0 }).positionQuote).toBeCloseTo(2000);
  });

  it("scales with the risk percentage", () => {
    expect(ok({ riskPercent: 2, feeRate: 0 }).positionQuote).toBeCloseTo(40);
    expect(ok({ riskPercent: 0.5, feeRate: 0 }).positionQuote).toBeCloseTo(10);
  });

  it("grows as the stop tightens, for the same risk", () => {
    // 10% stop, 5% stop, 1% stop — same 1 at risk each time.
    expect(ok({ stopLoss: 90, feeRate: 0 }).positionQuote).toBeCloseTo(10);
    expect(ok({ stopLoss: 95, feeRate: 0 }).positionQuote).toBeCloseTo(20);
    expect(ok({ stopLoss: 99, balance: 10_000, feeRate: 0 }).positionQuote).toBeCloseTo(10_000);
  });

  it("derives quantity from the position and the entry", () => {
    const c = ok({ balance: 1000, entry: 250, stopLoss: 200, feeRate: 0 });

    expect(c.intendedRiskAmount).toBeCloseTo(10);
    expect(c.quantity).toBeCloseTo(10 / 50);
    expect(c.positionQuote).toBeCloseTo(c.quantity * 250);
  });

  it("keeps full precision internally", () => {
    // A recurring quantity must not be rounded on the way through: rounding it
    // and multiplying back out gives a risk figure that is quietly wrong.
    const c = ok({ balance: 1000, riskPercent: 1, entry: 3, stopLoss: 2, feeRate: 0 });

    expect(c.quantity).toBeCloseTo(10, 12);
    expect(c.actualRiskAmount).toBeCloseTo(10, 12);
  });
});

describe("spot cannot exceed the balance", () => {
  it("caps the position at the account, and says what it now risks", () => {
    // 1000 balance, 1% risk, 0.2% stop → 5000 unconstrained. Spot has no
    // borrowing, so 1000 is the ceiling.
    const c = ok({ balance: 1000, riskPercent: 1, entry: 100, stopLoss: 99.8, feeRate: 0 });

    expect(c.uncappedPositionQuote).toBeCloseTo(5000);
    expect(c.wasCapped).toBe(true);
    expect(c.positionQuote).toBeCloseTo(1000);
    expect(c.exposureCap).toBeCloseTo(1000);

    // Both numbers are reported. The capped position risks a fifth of what was
    // intended — less, never more.
    expect(c.intendedRiskAmount).toBeCloseTo(10);
    expect(c.actualRiskAmount).toBeCloseTo(2);
    expect(c.actualRiskAmount).toBeLessThan(c.intendedRiskAmount);
  });

  it("explains the cap without rewriting the request", () => {
    const c = ok({ balance: 1000, riskPercent: 1, entry: 100, stopLoss: 99.8, feeRate: 0 });
    const capped = c.warnings.find((w) => w.code === "POSITION_CAPPED")!;

    expect(capped).toBeDefined();
    expect(capped.message).toMatch(/risks 2\.00/);
    expect(capped.message).toMatch(/10\.00 intended/);
    // The risk percentage the user chose is untouched.
    expect(c.riskPercent).toBe(1);
  });

  it("honours a tighter exposure limit", () => {
    const c = ok({ balance: 1000, maxExposurePercent: 10, feeRate: 0 });

    // 1% of 1000 with a 5% stop wants 200; a 10% exposure limit allows 100.
    expect(c.uncappedPositionQuote).toBeCloseTo(200);
    expect(c.exposureCap).toBeCloseTo(100);
    expect(c.positionQuote).toBeCloseTo(100);
    expect(c.actualRiskAmount).toBeCloseTo(5);
  });

  it("never lets an exposure limit widen the spot ceiling", () => {
    // 100% exposure is still bounded by the balance.
    const c = ok({
      balance: 1000,
      riskPercent: 1,
      entry: 100,
      stopLoss: 99.8,
      maxExposurePercent: 100,
      feeRate: 0,
    });

    expect(c.positionQuote).toBeCloseTo(1000);
  });

  it("does not cap a position that fits", () => {
    const c = ok({ feeRate: 0 });

    expect(c.wasCapped).toBe(false);
    expect(c.positionQuote).toBeCloseTo(c.uncappedPositionQuote);
    expect(c.actualRiskAmount).toBeCloseTo(c.intendedRiskAmount);
    expect(c.warnings.some((w) => w.code === "POSITION_CAPPED")).toBe(false);
  });
});

describe("costs", () => {
  it("is exactly neutral at zero fee and zero slippage", () => {
    const c = ok({ feeRate: 0, slippageRate: 0 });

    expect(c.estimatedCosts).toBe(0);
    expect(c.estimatedNetLoss).toBeCloseTo(c.actualRiskAmount);
  });

  it("shows intended risk and estimated total loss separately", () => {
    // The distinction §5 exists for: costs are not hidden inside the risk.
    const c = ok({ feeRate: 0.001, slippageRate: 0 });

    expect(c.intendedRiskAmount).toBeCloseTo(1);
    expect(c.estimatedCosts).toBeGreaterThan(0);
    expect(c.estimatedNetLoss).toBeCloseTo(1 + c.estimatedCosts);
    expect(c.estimatedNetLoss).toBeGreaterThan(c.intendedRiskAmount);
  });

  it("charges fees on the position, not on the risk", () => {
    // quantity 0.2, legs at 100 and 95, 0.1% a side.
    const c = ok({ feeRate: 0.001, slippageRate: 0 });

    expect(c.estimatedCosts).toBeCloseTo(0.2 * (100 + 95) * 0.001, 10);
  });

  it("treats slippage the same way fees are treated", () => {
    const fees = ok({ feeRate: 0.001, slippageRate: 0 }).estimatedCosts;
    const both = ok({ feeRate: 0.001, slippageRate: 0.001 }).estimatedCosts;

    expect(both).toBeCloseTo(fees * 2, 10);
  });

  it("flags costs that are large next to what is actually at risk", () => {
    // A stop tight enough to cap the position is also the one whose costs are
    // worst relative to its risk: capped to 10,000 of position, this risks 10
    // and pays about 20 to trade.
    const c = ok({ balance: 10_000, entry: 100, stopLoss: 99.9, feeRate: 0.001 });

    expect(c.wasCapped).toBe(true);
    expect(c.actualRiskAmount).toBeCloseTo(10);
    expect(c.estimatedCosts).toBeGreaterThan(c.actualRiskAmount);
    expect(c.warnings.some((w) => w.code === "COSTS_LARGE_VS_RISK")).toBe(true);
  });

  it("compares costs to the real risk, not the intended one, when capped", () => {
    // Comparing against the intended 100 would have hidden costs of 20 against
    // an actual risk of 10 — the exact case the warning exists for.
    const c = ok({ balance: 10_000, entry: 100, stopLoss: 99.9, feeRate: 0.001 });

    expect(c.intendedRiskAmount).toBeCloseTo(100);
    expect(c.estimatedCosts).toBeLessThan(c.intendedRiskAmount * 0.2);
    expect(c.estimatedCosts).toBeGreaterThan(c.actualRiskAmount * 0.2);
  });
});

describe("profit and ratio", () => {
  it("computes gross and net profit from the capped position", () => {
    const c = ok({ takeProfit: 110, feeRate: 0, slippageRate: 0 });

    expect(c.potentialGrossProfit).toBeCloseTo(0.2 * 10);
    expect(c.potentialNetProfit).toBeCloseTo(c.potentialGrossProfit!);
  });

  it("subtracts costs from the net figure", () => {
    const c = ok({ takeProfit: 110, feeRate: 0.001 });

    expect(c.potentialNetProfit!).toBeLessThan(c.potentialGrossProfit!);
  });

  it("uses the same reward-to-risk definition as the setup engine", () => {
    // (110 - 100) / (100 - 95) = 2
    expect(ok({ takeProfit: 110 }).riskReward).toBeCloseTo(2);
    expect(ok({ takeProfit: 105 }).riskReward).toBeCloseTo(1);
  });

  it("produces no ratio at all without a target", () => {
    const c = ok();

    expect(c.riskReward).toBeNull();
    expect(c.potentialGrossProfit).toBeNull();
    expect(c.potentialNetProfit).toBeNull();
  });

  it("marks a ratio taken from an unmeasured target", () => {
    // Phase A's rule follows the number: a ratio to an R-multiple restates
    // that multiple rather than describing the chart.
    const c = ok({ takeProfit: 110, takeProfitIsSynthetic: true });

    expect(c.riskRewardIsSynthetic).toBe(true);
    expect(c.warnings.some((w) => w.code === "UNMEASURED_TARGET")).toBe(true);
  });
});

describe("invalid input is named, never guessed at", () => {
  it("rejects a non-positive balance", () => {
    expect(errors({ balance: 0 })).toContain("INVALID_BALANCE");
    expect(errors({ balance: -100 })).toContain("INVALID_BALANCE");
  });

  it("rejects a risk percentage outside 0 to 100", () => {
    expect(errors({ riskPercent: 0 })).toContain("INVALID_RISK_PERCENT");
    expect(errors({ riskPercent: -1 })).toContain("INVALID_RISK_PERCENT");
    expect(errors({ riskPercent: 101 })).toContain("INVALID_RISK_PERCENT");
  });

  it("rejects non-positive prices", () => {
    expect(errors({ entry: 0 })).toContain("INVALID_ENTRY");
    expect(errors({ stopLoss: 0 })).toContain("INVALID_STOP");
    expect(errors({ stopLoss: -5 })).toContain("INVALID_STOP");
  });

  it("rejects a stop at or above the entry, and says why", () => {
    expect(errors({ stopLoss: 100 })).toContain("STOP_NOT_BELOW_ENTRY");
    expect(errors({ stopLoss: 105 })).toContain("STOP_NOT_BELOW_ENTRY");
  });

  it("rejects NaN and Infinity everywhere", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(errors({ balance: bad }).length, `balance ${bad}`).toBeGreaterThan(0);
      expect(errors({ entry: bad }).length, `entry ${bad}`).toBeGreaterThan(0);
      expect(errors({ stopLoss: bad }).length, `stop ${bad}`).toBeGreaterThan(0);
      expect(errors({ riskPercent: bad }).length, `risk ${bad}`).toBeGreaterThan(0);
    }
  });

  it("rejects a target at or below the entry", () => {
    expect(errors({ takeProfit: 100 })).toContain("INVALID_TAKE_PROFIT");
    expect(errors({ takeProfit: 90 })).toContain("INVALID_TAKE_PROFIT");
  });

  it("rejects a nonsensical exposure limit", () => {
    expect(errors({ maxExposurePercent: 0 })).toContain("INVALID_EXPOSURE_CAP");
    expect(errors({ maxExposurePercent: 150 })).toContain("INVALID_EXPOSURE_CAP");
  });

  it("rejects impossible cost rates", () => {
    expect(errors({ feeRate: -0.1 })).toContain("INVALID_COSTS");
    expect(errors({ slippageRate: 0.5 })).toContain("INVALID_COSTS");
  });

  it("reports every problem at once rather than one at a time", () => {
    const codes = errors({ balance: -1, riskPercent: 0, entry: -5 });

    expect(codes).toEqual(
      expect.arrayContaining(["INVALID_BALANCE", "INVALID_RISK_PERCENT", "INVALID_ENTRY"]),
    );
  });

  it("never returns a misleading zero for invalid input", () => {
    const result = calculateRisk({ ...BASE, balance: 0 });

    // A bare zero would be indistinguishable from "the answer is zero".
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("calculation");
  });
});

describe("warnings inform, they never override", () => {
  it("flags a very tight stop", () => {
    const c = ok({ entry: 100, stopLoss: 99.8, balance: 100_000 });
    expect(c.warnings.some((w) => w.code === "TIGHT_STOP")).toBe(true);
  });

  it("flags an unusually high risk percentage without changing it", () => {
    const c = ok({ riskPercent: HIGH_RISK_PERCENT + 5 });

    expect(c.warnings.some((w) => w.code === "HIGH_RISK_PERCENT")).toBe(true);
    // The number the user chose survives untouched. Nothing here is adaptive.
    expect(c.riskPercent).toBe(HIGH_RISK_PERCENT + 5);
    expect(c.intendedRiskAmount).toBeCloseTo(100 * ((HIGH_RISK_PERCENT + 5) / 100));
  });

  it("stays quiet on an ordinary trade", () => {
    expect(ok({ feeRate: 0 }).warnings).toEqual([]);
  });
});

describe("consistency with the setup engine", () => {
  it("returns the engine's own ratio when given the engine's own target", () => {
    // The rule §10 exists for: one definition of reward-to-risk, not two. The
    // target must be the one `riskReward.measuredTo` names — Phase A picks the
    // second *qualifying* structural target, which is often not `takeProfits[1]`.
    const analysis = runAnalysis(pullbackIntoSupport());
    const setup = analysis.setup!;
    const measured = setup.takeProfits.find((t) => t.label === setup.riskReward.measuredTo)!;

    const calculation = ok({
      balance: 1000,
      entry: setup.entry.mid,
      stopLoss: setup.stopLoss.price,
      takeProfit: measured.level,
      feeRate: 0,
    });

    expect(calculation.riskReward).toBeCloseTo(setup.riskReward.ratio, 10);
  });

  it("carries the engine's unmeasured-target qualifier through", () => {
    const analysis = runAnalysis(extendedAboveSupport());
    const setup = analysis.setup!;
    expect(setup.riskReward.isSynthetic).toBe(true);

    const measured = setup.takeProfits.find((t) => t.label === setup.riskReward.measuredTo)!;
    const calculation = ok({
      balance: 1000,
      entry: setup.entry.mid,
      stopLoss: setup.stopLoss.price,
      takeProfit: measured.level,
      takeProfitIsSynthetic: setup.riskReward.isSynthetic,
      feeRate: 0,
    });

    // The ratio is still reported — the ladder has to be measured to something
    // — but it is never presented as though the chart supplied it.
    expect(calculation.riskRewardIsSynthetic).toBe(true);
    expect(calculation.warnings.some((w) => w.code === "UNMEASURED_TARGET")).toBe(true);
  });
});

describe("determinism", () => {
  it("returns an identical result for identical input", () => {
    const input = { ...BASE, takeProfit: 110, feeRate: 0.001, maxExposurePercent: 50 };

    expect(JSON.stringify(calculateRisk(input))).toBe(JSON.stringify(calculateRisk(input)));
  });

  it("reads no clock and no randomness", () => {
    const first = ok({ takeProfit: 110 });
    const second = ok({ takeProfit: 110 });

    expect(first.positionQuote).toBe(second.positionQuote);
    expect(first.estimatedCosts).toBe(second.estimatedCosts);
  });
});
