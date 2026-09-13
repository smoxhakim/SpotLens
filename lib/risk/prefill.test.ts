import { describe, expect, it } from "vitest";

import { selectMeasuredTarget } from "@/lib/analysis";
import type { CoachLevels } from "@/lib/coach";

import { calculateRisk } from "./calculate";
import { entryPriceOf, riskCalculatorParams, riskPrefillFrom } from "./prefill";

/**
 * Carrying a stored setup's levels into the calculator.
 *
 * The property worth protecting is that the calculator sizes the setup the
 * reader was shown. Every number here is selected, never recomputed — so the
 * tests compare the prefill against the *source* levels rather than against a
 * second arithmetic of their own.
 */

const levels: CoachLevels = {
  entryLow: 100,
  entryHigh: 104,
  stopLoss: 96,
  takeProfits: [
    { label: "TP1", level: 108, rr: 0.75, kind: "STRUCTURAL", reason: "nearest resistance" },
    { label: "TP2", level: 120, rr: 3, kind: "STRUCTURAL", reason: "prior swing high" },
    { label: "TP3", level: 132, rr: 5, kind: "EXTENSION", reason: "measured move" },
  ],
  riskReward: 3,
  riskRewardIsSynthetic: false,
  riskRewardReason: "Risking 6 to make 18.",
  entryReason: "support zone",
  stopLossReason: "below the zone",
};

describe("riskPrefillFrom", () => {
  it("offers the target the stored ratio was measured to", () => {
    // TP1 is structural but sits under 1R, so the engine measures past it. A
    // prefill that offered TP1 would size against a reward the panel never
    // quoted — which is the specific disagreement this exists to prevent.
    const prefill = riskPrefillFrom(levels);

    expect(prefill.takeProfitLabel).toBe("TP2");
    expect(prefill.takeProfit).toBe(120);
  });

  it("picks the same target the engine itself would", () => {
    // Not a parallel rule: the same function decides both, so this asserts the
    // wiring rather than re-deriving the choice.
    const chosen = selectMeasuredTarget(
      levels.takeProfits.map((t) => ({ ...t, kind: t.kind!, rr: t.rr! })),
    );

    expect(riskPrefillFrom(levels).takeProfitLabel).toBe(chosen!.target.label);
  });

  it("reads every level straight off the record", () => {
    const prefill = riskPrefillFrom(levels);

    expect(prefill.stopLoss).toBe(levels.stopLoss);
    expect(prefill.riskReward).toBe(levels.riskReward);
    expect(prefill.entry).toBe(entryPriceOf(levels));
    expect(prefill.targets).toEqual([
      { label: "TP1", level: 108 },
      { label: "TP2", level: 120 },
      { label: "TP3", level: 132 },
    ]);
  });

  it("carries the unmeasured qualifier the whole way", () => {
    // Phase A's rule follows the number wherever it goes. A calculator that
    // dropped it would present a fallback constant as a measured reward.
    const prefill = riskPrefillFrom({ ...levels, riskRewardIsSynthetic: true });

    expect(prefill.riskRewardIsSynthetic).toBe(true);
    expect(riskCalculatorParams(prefill, ctx).get("unmeasured")).toBe("1");
  });

  it("identifies no measured target when the record predates the kind being stored", () => {
    // Better than guessing. An old row that lost `kind` yields no default, the
    // reader picks, and no target is silently presented as the measured one.
    const older = {
      ...levels,
      takeProfits: levels.takeProfits.map((t) => ({ ...t, kind: null })),
    };

    const prefill = riskPrefillFrom(older);

    expect(prefill.takeProfit).toBeNull();
    expect(prefill.takeProfitLabel).toBeNull();
    expect(prefill.targets).toHaveLength(3);
  });

  it("has no measured target for a setup with no targets at all", () => {
    const prefill = riskPrefillFrom({ ...levels, takeProfits: [] });

    expect(prefill.takeProfit).toBeNull();
    expect(prefill.targets).toEqual([]);
  });
});

describe("the prefill and lib/risk agree", () => {
  it("sizes from the same entry and stop the setup recorded", () => {
    // One formula, and it is the Phase H one. The prefill supplies inputs; it
    // does not compute a position, and there is no second sizing rule here.
    const prefill = riskPrefillFrom(levels);

    const result = calculateRisk({
      balance: 1000,
      riskPercent: 1,
      entry: prefill.entry,
      stopLoss: prefill.stopLoss,
      takeProfit: prefill.takeProfit ?? undefined,
      takeProfitIsSynthetic: prefill.riskRewardIsSynthetic,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.calculation.entry).toBe(prefill.entry);
    expect(result.calculation.stopLoss).toBe(prefill.stopLoss);
    // 1% of 1000 over a 6-wide stop: 1.666… units, 170 of quote.
    expect(result.calculation.intendedRiskAmount).toBeCloseTo(10, 10);
    expect(result.calculation.quantity).toBeCloseTo(10 / 6, 10);
  });

  it("reports the ratio the engine measured, to the target it measured to", () => {
    const prefill = riskPrefillFrom(levels);

    const result = calculateRisk({
      balance: 1000,
      riskPercent: 1,
      entry: prefill.entry,
      stopLoss: prefill.stopLoss,
      takeProfit: prefill.takeProfit!,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The engine stores each target's own ratio to the same entry midpoint and
    // the same stop, so sizing to the measured target must reproduce exactly
    // the ratio the panel quoted — not something close to it.
    const measured = levels.takeProfits.find((t) => t.label === prefill.takeProfitLabel)!;

    expect(result.calculation.riskReward).toBeCloseTo(measured.rr!, 10);
    expect(result.calculation.riskReward).toBeCloseTo(levels.riskReward, 10);
  });

  it("charges fees on both legs without changing the ratio", () => {
    // Phase G's rule, and Phase H inherits it: costs change what a trade was
    // worth, never whether the reward was measured.
    const prefill = riskPrefillFrom(levels);

    const inputs = {
      balance: 1000,
      riskPercent: 1,
      entry: prefill.entry,
      stopLoss: prefill.stopLoss,
      takeProfit: prefill.takeProfit!,
    };

    const free = calculateRisk({ ...inputs, feeRate: 0, slippageRate: 0 });
    const charged = calculateRisk({ ...inputs, feeRate: 0.001, slippageRate: 0.0005 });

    expect(free.ok && charged.ok).toBe(true);
    if (!free.ok || !charged.ok) return;

    expect(charged.calculation.riskReward).toBe(free.calculation.riskReward);
    expect(charged.calculation.quantity).toBe(free.calculation.quantity);
    expect(charged.calculation.estimatedCosts).toBeGreaterThan(0);
    expect(free.calculation.estimatedCosts).toBe(0);
  });

  it("caps the position at the balance and reports the smaller risk it then takes", () => {
    // A tight stop implies a large position for the same risk. On spot there is
    // no borrowing, so it is capped — and a capped position risks *less* than
    // intended, which is two numbers rather than one quietly rewritten.
    const prefill = riskPrefillFrom({ ...levels, stopLoss: 101.9 });

    const result = calculateRisk({
      balance: 1000,
      riskPercent: 5,
      entry: prefill.entry,
      stopLoss: prefill.stopLoss,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.calculation.wasCapped).toBe(true);
    expect(result.calculation.positionQuote).toBeLessThanOrEqual(1000);
    expect(result.calculation.actualRiskAmount).toBeLessThan(result.calculation.intendedRiskAmount);
  });
});

const ctx = { symbol: "ETHUSDT", timeframe: "H4", runId: "run-1", setupId: "setup-1" };

describe("riskCalculatorParams", () => {
  it("carries the identity of the opportunity alongside the levels", () => {
    // Without these the calculator is a cul-de-sac: the reader can size a
    // position and then has no way back to the setup it belonged to.
    const params = riskCalculatorParams(riskPrefillFrom(levels), ctx);

    expect(params.get("symbol")).toBe("ETHUSDT");
    expect(params.get("tf")).toBe("H4");
    expect(params.get("runId")).toBe("run-1");
    expect(params.get("setupId")).toBe("setup-1");
    expect(params.get("entry")).toBe(String(entryPriceOf(levels)));
    expect(params.get("stop")).toBe("96");
    expect(params.get("tp")).toBe("120");
  });

  it("omits the setup for an opportunity that was never tracked", () => {
    const params = riskCalculatorParams(riskPrefillFrom(levels), { ...ctx, setupId: null });

    expect(params.has("setupId")).toBe(false);
  });

  it("lets the reader size against a target they chose instead", () => {
    const params = riskCalculatorParams(riskPrefillFrom(levels), ctx, 132);

    expect(params.get("tp")).toBe("132");
  });
});
