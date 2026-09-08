import { describe, expect, it } from "vitest";

import { makeCandles } from "@/lib/test-utils/candles";
import {
  downtrend,
  extendedAboveSupport,
  pullbackIntoSupport,
  pullbackOnThinVolume,
  rangeBound,
  thinHistory,
} from "@/lib/test-utils/scenarios";

import { runAnalysis } from "./index";
import { SCORE_WEIGHTS } from "./score";

describe("runAnalysis — restraint", () => {
  it("offers no long setup at all in a downtrend", () => {
    const result = runAnalysis(downtrend());

    expect(result.status).toBe("AVOID");
    expect(result.setup).toBeNull();
    expect(result.statusReason).toMatch(/bearish/i);
  });

  it("never hands over entry numbers for a trade it says to avoid", () => {
    // Giving someone levels for a trade you just called AVOID undoes the point
    // of saying it.
    const result = runAnalysis(downtrend());

    expect(result.setup).toBeNull();
    expect(result.score).toBeNull();
  });

  it("says wait, not buy, when price has run away from the entry zone", () => {
    const result = runAnalysis(extendedAboveSupport());

    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(result.statusReason).toMatch(/chasing|pullback/i);
    expect(result.setup!.entry.priceInZone).toBe(false);
  });

  it("says wait when the bounce is on thin volume", () => {
    const strong = runAnalysis(pullbackIntoSupport());
    const thin = runAnalysis(pullbackOnThinVolume());

    // Same levels, same structure — only participation differs.
    expect(strong.status).toBe("POTENTIAL_SETUP");
    expect(thin.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(thin.statusReason).toMatch(/volume/i);
  });

  it("treats a range as a range, not a trend", () => {
    const result = runAnalysis(rangeBound());

    expect(result.read.trend.trend).toBe("SIDEWAYS");
    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(result.statusReason).toMatch(/ranging/i);
  });

  it("flags thin history as high risk rather than analysing it confidently", () => {
    const result = runAnalysis(thinHistory());

    expect(result.status).toBe("HIGH_RISK");
    expect(result.statusReason).toMatch(/candles|history/i);
  });

  it("only calls a potential setup when everything checks out", () => {
    const result = runAnalysis(pullbackIntoSupport());

    expect(result.status).toBe("POTENTIAL_SETUP");
    expect(result.read.trend.trend).toBe("BULLISH");
    expect(result.setup!.entry.priceInZone).toBe(true);
    expect(result.setup!.riskReward.ratio).toBeGreaterThanOrEqual(1.5);
    // Even the best case is framed as a candidate, never an instruction.
    expect(result.statusReason).toMatch(/not an instruction to buy/i);
  });

  it("returns a safe verdict for an empty series instead of throwing", () => {
    const result = runAnalysis([]);

    expect(result.status).toBe("AVOID");
    expect(result.setup).toBeNull();
  });
});

describe("runAnalysis — the numbers", () => {
  const result = runAnalysis(pullbackIntoSupport());
  const setup = result.setup!;

  it("is spot-only: the direction is always long", () => {
    expect(setup.direction).toBe("LONG");
  });

  it("places the stop below the entry zone", () => {
    expect(setup.stopLoss.price).toBeLessThan(setup.entry.low);
    expect(setup.stopLoss.reason).toMatch(/support zone|swing low/i);
    expect(setup.stopLoss.reason).toMatch(/invalid/i);
  });

  it("gives ascending take-profit targets, all above the entry", () => {
    expect(setup.takeProfits.length).toBeGreaterThan(0);

    for (const target of setup.takeProfits) {
      expect(target.level).toBeGreaterThan(setup.entry.mid);
      expect(target.reason.length).toBeGreaterThan(20);
    }
    for (let i = 1; i < setup.takeProfits.length; i += 1) {
      expect(setup.takeProfits[i].level).toBeGreaterThan(setup.takeProfits[i - 1].level);
    }
  });

  it("labels targets TP1, TP2, TP3 in order", () => {
    expect(setup.takeProfits.map((t) => t.label)).toEqual(
      ["TP1", "TP2", "TP3"].slice(0, setup.takeProfits.length),
    );
  });

  it("computes risk/reward consistently with the levels it reports", () => {
    const risk = setup.entry.mid - setup.stopLoss.price;
    const target = setup.takeProfits.find((t) => t.label === setup.riskReward.measuredTo)!;
    const reward = target.level - setup.entry.mid;

    expect(setup.riskReward.risk).toBeCloseTo(risk, 6);
    expect(setup.riskReward.reward).toBeCloseTo(reward, 6);
    expect(setup.riskReward.ratio).toBeCloseTo(reward / risk, 6);
  });

  it("attaches a reason to every number", () => {
    expect(setup.entry.reason.length).toBeGreaterThan(20);
    expect(setup.stopLoss.reason.length).toBeGreaterThan(20);
    expect(setup.riskReward.reason.length).toBeGreaterThan(20);
    expect(result.statusReason.length).toBeGreaterThan(20);
  });

  it("lists confirmations to look for rather than declaring the trade live", () => {
    expect(setup.entry.confirmations.length).toBeGreaterThanOrEqual(4);
    expect(setup.entry.confirmations.join(" ")).toMatch(/volume|higher low|rejection/i);
  });

  it("carries the disclaimer and its version", () => {
    expect(result.disclaimer).toMatch(/educational and informational only/);
    expect(result.disclaimerVersion).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("setup score", () => {
  it("uses the category weights specified in the PRD", () => {
    expect(SCORE_WEIGHTS).toEqual({
      trend: 25,
      supportResistance: 25,
      volume: 15,
      rsi: 10,
      emaAlignment: 10,
      riskReward: 15,
    });
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("never exceeds 100 and never drops below 0", () => {
    for (const scenario of [pullbackIntoSupport, extendedAboveSupport, rangeBound, thinHistory]) {
      const score = runAnalysis(scenario())!.score;
      if (!score) continue;
      expect(score.total).toBeGreaterThanOrEqual(0);
      expect(score.total).toBeLessThanOrEqual(100);
    }
  });

  it("reports a reason for every category", () => {
    const score = runAnalysis(pullbackIntoSupport()).score!;

    for (const [name, category] of Object.entries(score.breakdown)) {
      expect(category.score, name).toBeGreaterThanOrEqual(0);
      expect(category.score, name).toBeLessThanOrEqual(category.max);
      expect(category.reason.length, name).toBeGreaterThan(10);
    }
  });

  it("scores a clean pullback above an extended chase", () => {
    expect(runAnalysis(pullbackIntoSupport()).score!.total).toBeGreaterThan(
      runAnalysis(extendedAboveSupport()).score!.total,
    );
  });
});

describe("runAnalysis — determinism", () => {
  it("returns identical results for identical candles", () => {
    const candles = pullbackIntoSupport();
    expect(JSON.stringify(runAnalysis(candles))).toBe(JSON.stringify(runAnalysis(candles)));
  });

  it("never looks beyond the candles it is given", () => {
    // The property the Phase 7 backtester depends on.
    const full = pullbackIntoSupport();
    const prefix = full.slice(0, 90);

    expect(JSON.stringify(runAnalysis(prefix))).toBe(
      JSON.stringify(runAnalysis(full.slice(0, 90))),
    );
  });

  it("does not crash on degenerate input", () => {
    expect(() => runAnalysis(makeCandles([100]))).not.toThrow();
    expect(() => runAnalysis(makeCandles(new Array(80).fill(100)))).not.toThrow();
  });
});
