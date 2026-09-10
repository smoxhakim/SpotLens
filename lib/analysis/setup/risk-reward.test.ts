import { describe, expect, it } from "vitest";

import { calculateRiskReward } from "./risk-reward";
import type { EntryZone, StopLoss, TakeProfitTarget, TargetKind } from "./types";

/**
 * Risk/reward has to describe the chart, not the fallback ladder.
 *
 * The distortion these cover is specific: an R-multiple target makes the ratio
 * equal to its own multiple, so a chart with nothing above it reported a tidy
 * 1:2.5 and outranked setups with real levels on them.
 */

const ENTRY = { mid: 100 } as EntryZone;
const STOP = { price: 90 } as StopLoss; // risk = 10

function target(label: TakeProfitTarget["label"], rr: number, kind: TargetKind): TakeProfitTarget {
  return { label, level: ENTRY.mid + 10 * rr, reason: "", rr, kind };
}

describe("calculateRiskReward — which target the ratio is measured to", () => {
  it("measures to the second structural target when the chart offers two", () => {
    const rr = calculateRiskReward(ENTRY, STOP, [
      target("TP1", 1.2, "STRUCTURAL"),
      target("TP2", 3, "STRUCTURAL"),
      target("TP3", 5, "R_MULTIPLE"),
    ])!;

    expect(rr.measuredTo).toBe("TP2");
    expect(rr.ratio).toBeCloseTo(3);
    expect(rr.isSynthetic).toBe(false);
  });

  it("flags the ratio as synthetic when every target is an R-multiple", () => {
    const rr = calculateRiskReward(ENTRY, STOP, [
      target("TP1", 1.5, "R_MULTIPLE"),
      target("TP2", 2.5, "R_MULTIPLE"),
      target("TP3", 4, "R_MULTIPLE"),
    ])!;

    expect(rr.isSynthetic).toBe(true);
    // The number is still reported — the ladder has to be measured to
    // something — but the reason says plainly that it is not evidence.
    expect(rr.ratio).toBeCloseTo(2.5);
    expect(rr.reason).toMatch(/arithmetic rather than evidence/i);
  });

  it("does not let a structural target closer than 1R stand in as the measure", () => {
    // The inverse distortion: a resistance zone a fifth of an R above the
    // entry is a real level, but 1:0.2 describes the level's proximity, not
    // the opportunity — and it would condemn the setup outright.
    const rr = calculateRiskReward(ENTRY, STOP, [
      target("TP1", 0.2, "STRUCTURAL"),
      target("TP2", 2.5, "R_MULTIPLE"),
      target("TP3", 4, "R_MULTIPLE"),
    ])!;

    expect(rr.measuredTo).toBe("TP2");
    expect(rr.isSynthetic).toBe(true);
    expect(rr.ratio).toBeCloseTo(2.5);
  });

  it("uses the only structural target when it is far enough to mean something", () => {
    const rr = calculateRiskReward(ENTRY, STOP, [
      target("TP1", 1.8, "STRUCTURAL"),
      target("TP2", 3, "R_MULTIPLE"),
      target("TP3", 5, "R_MULTIPLE"),
    ])!;

    expect(rr.measuredTo).toBe("TP1");
    expect(rr.ratio).toBeCloseTo(1.8);
    expect(rr.isSynthetic).toBe(false);
  });

  it("never reports a synthetic ratio as better than a real one it replaced", () => {
    // The ranking bug in one assertion: before this fix the synthetic setup
    // scored the higher ratio of the two and would have outranked the setup
    // with an actual level above it.
    const synthetic = calculateRiskReward(ENTRY, STOP, [
      target("TP1", 1.5, "R_MULTIPLE"),
      target("TP2", 2.5, "R_MULTIPLE"),
    ])!;
    const structural = calculateRiskReward(ENTRY, STOP, [
      target("TP1", 1.2, "STRUCTURAL"),
      target("TP2", 1.8, "STRUCTURAL"),
    ])!;

    expect(synthetic.ratio).toBeGreaterThan(structural.ratio);
    // ...which is why the flag, not the ratio, is what downstream ranking reads.
    expect(synthetic.isSynthetic).toBe(true);
    expect(structural.isSynthetic).toBe(false);
  });

  it("returns null when the stop is not below the entry", () => {
    expect(
      calculateRiskReward(ENTRY, { price: 100 } as StopLoss, [target("TP1", 2, "STRUCTURAL")]),
    ).toBeNull();
  });
});
