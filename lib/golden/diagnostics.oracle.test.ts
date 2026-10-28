import { describe, expect, it } from "vitest";

import {
  GATE_OF,
  GATE_ORDER,
  STATUS_OF,
  runAnalysis,
  runAnalysisWithDiagnostics,
  type AnalysisDiagnostics,
  type AnalysisResult,
} from "@/lib/analysis";

import { namedCases, sweepCases, type GoldenCase } from "./corpus";
import { BRANCHES, branchOf } from "./project";

/**
 * Diagnostics against the Commit 0 corpus (Phase 5, commit 1).
 *
 * The gate code is emitted at the return that decided; `branchOf` infers the
 * same thing independently, from the reason text alone. They must agree on every
 * analysis in the corpus — that is what proves each code is attached to the
 * right return. And the result beside the diagnostics must be the very object
 * `runAnalysis` returns, so nothing a caller receives can change because of
 * them. Neither writes a golden file.
 */

const SLOW = 60_000;

interface Diagnosed {
  id: string;
  result: AnalysisResult;
  diagnostics: AnalysisDiagnostics;
  plain: AnalysisResult;
}

let cached: Diagnosed[] | null = null;
function diagnosed(): Diagnosed[] {
  cached ??= [...namedCases(), ...sweepCases()].map((c: GoldenCase) => ({
    id: c.id,
    ...runAnalysisWithDiagnostics(c.candles, c.options),
    plain: runAnalysis(c.candles, c.options),
  }));
  return cached;
}

describe("diagnostics against the golden corpus", () => {
  it(
    "returns exactly the result runAnalysis returns",
    () => {
      for (const d of diagnosed()) expect(d.result, d.id).toStrictEqual(d.plain);
    },
    SLOW,
  );

  it(
    "names the same deciding rule the classifier reads from the reason, on every case",
    () => {
      const cases = diagnosed();
      expect(cases).toHaveLength(696);
      for (const d of cases) {
        expect(d.diagnostics.blockingGate ?? "PASSED", d.id).toBe(branchOf(d.result));
      }
    },
    SLOW,
  );

  it(
    "covers every code the corpus reaches, with the status the engine returns for it",
    () => {
      const reached = new Set<string>();
      for (const d of diagnosed()) {
        const code = d.diagnostics.blockingGate;
        reached.add(code ?? "PASSED");
        if (code === null) expect(d.result.status, d.id).toBe("POTENTIAL_SETUP");
        else expect(d.result.status, d.id).toBe(STATUS_OF[code]);
      }
      // Commit 0 reached 22 of the 25 branches; diagnostics must reach the same.
      expect(reached.size).toBe(22);
      for (const branch of reached) expect(BRANCHES).toContain(branch);
    },
    SLOW,
  );

  it(
    "fails only the deciding gate; passes before it, never after",
    () => {
      for (const { id, diagnostics } of diagnosed()) {
        const { blockingGate, gates } = diagnostics;
        expect(
          gates.map((g) => g.gate),
          id,
        ).toEqual(GATE_ORDER);

        const failed = gates.filter((g) => g.outcome === "FAIL");
        const at = blockingGate === null ? gates.length : GATE_ORDER.indexOf(GATE_OF[blockingGate]);
        expect(failed, id).toEqual(
          blockingGate === null
            ? []
            : [{ gate: GATE_OF[blockingGate], outcome: "FAIL", code: blockingGate }],
        );
        for (const g of gates.slice(0, at)) {
          expect(["PASS", "NOT_APPLICABLE"], `${id} ${g.gate}`).toContain(g.outcome);
        }
        for (const g of gates.slice(at + 1)) {
          expect(["NOT_REACHED", "UNAVAILABLE", "NOT_APPLICABLE"], `${id} ${g.gate}`).toContain(
            g.outcome,
          );
        }
      }
    },
    SLOW,
  );

  it(
    "quotes the reward the result shows, and no price on an avoid",
    () => {
      let avoidedWithReward = 0;
      for (const { id, result, diagnostics } of diagnosed()) {
        const reward = diagnostics.reward;
        if (result.status === "AVOID") {
          if (!reward) continue;
          avoidedWithReward += 1;
          expect([reward.entry, reward.stop, reward.risk, reward.target], id).toEqual([
            null,
            null,
            null,
            null,
          ]);
          continue;
        }
        if (!result.setup) {
          expect(reward, id).toBeNull();
          continue;
        }
        const { entry, stopLoss, riskReward, takeProfits } = result.setup;
        const target = takeProfits.find((t) => t.label === riskReward.measuredTo)!;
        expect(reward, id).toMatchObject({
          entry: entry.mid,
          stop: stopLoss.price,
          risk: riskReward.risk,
          target: target.level,
          targetKind: target.kind,
          ratio: riskReward.ratio,
          isSynthetic: riskReward.isSynthetic,
          isPoor: riskReward.isPoor,
        });
      }
      // Not vacuous: the corpus has avoids decided after the reward was measured.
      expect(avoidedWithReward).toBeGreaterThan(0);
    },
    SLOW,
  );

  it(
    "agrees with the result on location and confirmation",
    () => {
      for (const { id, result, diagnostics } of diagnosed()) {
        expect(diagnostics.confirmation?.status ?? null, id).toBe(
          result.confirmation?.status ?? null,
        );
        if (!result.setup) continue;
        const inside = ["INSIDE_LOWER_HALF", "INSIDE_UPPER_HALF"].includes(
          diagnostics.location!.position,
        );
        expect(inside, id).toBe(result.setup.entry.priceInZone);
        expect(diagnostics.location!.distanceAtr, id).toBe(result.setup.entry.distanceAtr);
      }
    },
    SLOW,
  );
});
