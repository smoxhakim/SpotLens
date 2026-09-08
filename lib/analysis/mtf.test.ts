import { describe, expect, it } from "vitest";

import { downtrend, pullbackIntoSupport, rangeBound } from "@/lib/test-utils/scenarios";

import {
  analyzeMultiTimeframe,
  defaultHigherTimeframe,
  isValidTimeframePair,
  type MtfAgreement,
} from "./mtf";
import { runAnalysis } from "./setup";

function summary(lower: ReturnType<typeof downtrend>, higher: ReturnType<typeof downtrend>) {
  return analyzeMultiTimeframe({
    lowerCandles: lower,
    higherCandles: higher,
    lowerTimeframe: "H1",
    higherTimeframe: "H4",
  });
}

describe("timeframe pairing", () => {
  it("pairs each timeframe with the next one up", () => {
    expect(defaultHigherTimeframe("M15")).toBe("H1");
    expect(defaultHigherTimeframe("H1")).toBe("H4");
    expect(defaultHigherTimeframe("H4")).toBe("D1");
    expect(defaultHigherTimeframe("D1")).toBe("W1");
  });

  it("has nothing above the weekly", () => {
    expect(defaultHigherTimeframe("W1")).toBeNull();
  });

  it("rejects a higher timeframe that is not actually higher", () => {
    expect(isValidTimeframePair("H1", "H4")).toBe(true);
    expect(isValidTimeframePair("H4", "H1")).toBe(false);
    expect(isValidTimeframePair("H1", "H1")).toBe(false);
  });
});

describe("analyzeMultiTimeframe", () => {
  it("reports agreement when both timeframes are bullish", () => {
    const read = summary(pullbackIntoSupport(), pullbackIntoSupport());

    expect(read.agreement).toBe<MtfAgreement>("ALIGNED_BULLISH");
    expect(read.conflictNote).toBeNull();
    expect(read.note).toMatch(/both timeframes agree/i);
  });

  it("reports agreement when both are bearish", () => {
    const read = summary(downtrend(), downtrend());

    expect(read.agreement).toBe<MtfAgreement>("ALIGNED_BEARISH");
    expect(read.conflictNote).toMatch(/no long setup/i);
  });

  it("distinguishes a pullback in an uptrend from a counter-trend bounce", () => {
    // The two disagreement cases are opposites, not one "conflict" bucket.
    const pullback = summary(downtrend(), pullbackIntoSupport());
    const bounce = summary(pullbackIntoSupport(), downtrend());

    expect(pullback.agreement).toBe<MtfAgreement>("PULLBACK_IN_UPTREND");
    expect(bounce.agreement).toBe<MtfAgreement>("COUNTER_TREND_BOUNCE");
  });

  it("treats a pullback in an uptrend as favourable, not a warning", () => {
    const read = summary(downtrend(), pullbackIntoSupport());

    expect(read.conflictNote).toBeNull();
    expect(read.note).toMatch(/pullback|better price/i);
  });

  it("warns explicitly about a bounce inside a downtrend", () => {
    const read = summary(pullbackIntoSupport(), downtrend());

    expect(read.conflictNote).toMatch(/warning/i);
    expect(read.conflictNote).toMatch(/bullish, but/i);
    expect(read.conflictNote).toMatch(/most of them fail/i);
  });

  it("falls back to MIXED when the higher timeframe has no direction", () => {
    const read = summary(pullbackIntoSupport(), rangeBound());
    expect(read.agreement).toBe<MtfAgreement>("MIXED");
  });

  it("carries a reason for each timeframe's trend", () => {
    const read = summary(pullbackIntoSupport(), pullbackIntoSupport());

    expect(read.higherReason.length).toBeGreaterThan(20);
    expect(read.lowerReason.length).toBeGreaterThan(20);
  });
});

describe("MTF folded into the verdict", () => {
  it("refuses a setup that looks clean on its own timeframe but fights the higher one", () => {
    // Identical lower-timeframe data; only the higher timeframe differs.
    const lower = pullbackIntoSupport();

    const alone = runAnalysis(lower);
    const withBearishHigher = runAnalysis(lower, {
      mtf: summary(lower, downtrend()),
    });

    expect(alone.status).toBe("POTENTIAL_SETUP");
    expect(withBearishHigher.status).toBe("AVOID");
    expect(withBearishHigher.setup).toBeNull();
    expect(withBearishHigher.statusReason).toMatch(/bearish/i);
  });

  it("scores the same chart lower when the higher timeframe disagrees", () => {
    const lower = pullbackIntoSupport();

    const aligned = runAnalysis(lower, { mtf: summary(lower, pullbackIntoSupport()) });
    const mixed = runAnalysis(lower, { mtf: summary(lower, rangeBound()) });

    expect(aligned.score!.total).toBeGreaterThan(mixed.score!.total);
  });

  it("keeps the PRD's six score categories rather than adding a seventh", () => {
    const lower = pullbackIntoSupport();
    const result = runAnalysis(lower, { mtf: summary(lower, pullbackIntoSupport()) });

    expect(Object.keys(result.score!.breakdown)).toEqual([
      "trend",
      "supportResistance",
      "volume",
      "rsi",
      "emaAlignment",
      "riskReward",
    ]);
    // Higher-timeframe context adjusts the trend category; it is trend
    // information, and the breakdown still sums to 100.
    const total = Object.values(result.score!.breakdown).reduce((sum, c) => sum + c.max, 0);
    expect(total).toBe(100);
  });

  it("never lets an MTF bonus push a category past its maximum", () => {
    const lower = pullbackIntoSupport();
    const result = runAnalysis(lower, { mtf: summary(lower, pullbackIntoSupport()) });

    for (const category of Object.values(result.score!.breakdown)) {
      expect(category.score).toBeLessThanOrEqual(category.max);
    }
  });

  it("attaches the higher-timeframe read to the result", () => {
    const lower = pullbackIntoSupport();
    const result = runAnalysis(lower, { mtf: summary(lower, pullbackIntoSupport()) });

    expect(result.mtf).not.toBeNull();
    expect(result.mtf!.higherTimeframe).toBe("H4");
    expect(runAnalysis(lower).mtf).toBeNull();
  });
});
