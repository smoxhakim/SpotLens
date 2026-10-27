import { afterEach, describe, expect, it, vi } from "vitest";

import { runAnalysis, type TakeProfitTarget } from "@/lib/analysis";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import { branchOf, decisionOf, goldenFile, line, wordingOf } from "./project";

/**
 * Golden master for the two exits no real candle series reaches (Phase 5,
 * commit 0).
 *
 * `runAnalysis` refuses a setup whose targets do not ascend from the entry
 * (`validateSetupLevels`), and one with no target to measure against. With
 * valid candles neither looks reachable: by reading `calculateTakeProfits`, it
 * always returns at least one target, filling empty slots with R-multiples, and
 * builds its ladder in ascending order above the entry. That is derived from
 * the source, not proven — `engine.branches.golden.txt` would show either exit
 * if a corpus case ever reached it. Both exits still return a verdict, a reason
 * and withheld levels that the diagnostics release has to leave alone.
 *
 * So the ladder is substituted here, and only here. The substitute replaces
 * `calculateTakeProfits` for the cases that set it and defers to the real one
 * otherwise; the first test proves the deferral works.
 */

const ladder = vi.hoisted(() => ({
  override: null as null | ((entryHigh: number) => TakeProfitTarget[]),
}));

vi.mock("@/lib/analysis/setup/take-profit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis/setup/take-profit")>();
  return {
    ...actual,
    calculateTakeProfits: (...args: Parameters<typeof actual.calculateTakeProfits>) =>
      ladder.override ? ladder.override(args[1].high) : actual.calculateTakeProfits(...args),
  };
});

afterEach(() => {
  ladder.override = null;
});

const target = (label: TakeProfitTarget["label"], level: number): TakeProfitTarget => ({
  label,
  level,
  reason: "Substituted by the golden-master test.",
  rr: 1,
  kind: "STRUCTURAL",
});

const CASES: [string, (entryHigh: number) => TakeProfitTarget[]][] = [
  ["no targets at all", () => []],
  ["TP2 below TP1", (entryHigh) => [target("TP1", entryHigh + 10), target("TP2", entryHigh + 5)]],
  ["TP1 at the top of the entry zone", (entryHigh) => [target("TP1", entryHigh)]],
];

describe("golden master: defensive exits", () => {
  it("uses the real ladder when nothing is substituted", () => {
    expect(runAnalysis(pullbackIntoSupport()).status).toBe("POTENTIAL_SETUP");
  });

  it("refuses a setup with no target to measure the reward against", () => {
    ladder.override = () => [];
    const result = runAnalysis(pullbackIntoSupport());

    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(branchOf(result)).toBe("NO_MEASURABLE_REWARD");
    expect(result.setup).toBeNull();
    expect(result.score).toBeNull();
    expect(result.confirmation).toBeNull();
  });

  it("refuses a target set that does not ascend, rather than re-sorting it", () => {
    ladder.override = (entryHigh) => [target("TP1", entryHigh + 10), target("TP2", entryHigh + 5)];
    const result = runAnalysis(pullbackIntoSupport());

    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(branchOf(result)).toBe("INVALID_LEVELS");
    expect(result.statusReason).toMatch(/TP2 sits below TP1/);
    expect(result.setup).toBeNull();
  });

  it("refuses a first target that is not above the entry zone", () => {
    ladder.override = (entryHigh) => [target("TP1", entryHigh)];
    const result = runAnalysis(pullbackIntoSupport());

    expect(branchOf(result)).toBe("INVALID_LEVELS");
    expect(result.statusReason).toMatch(/TP1 is not above the entry zone/);
  });

  it("pins the verdict, reason and withheld levels for each", async () => {
    const lines = CASES.map(([name, build]) => {
      ladder.override = build;
      const result = runAnalysis(pullbackIntoSupport());
      ladder.override = null;
      return line(name, {
        branch: branchOf(result),
        decision: decisionOf(result),
        wording: wordingOf(result, false),
      });
    });

    await expect(
      goldenFile("Defensive exits, reached by substituting the target ladder", lines),
    ).toMatchFileSnapshot("./__golden__/defensive-exits.golden.txt");
  });
});
