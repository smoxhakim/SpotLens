import { describe, expect, it } from "vitest";

import { BLOCKING_CODES, GATE_ORDER, runAnalysisWithDiagnostics } from "@/lib/analysis";
import { zoneRetest, zoneRetestRejection } from "@/lib/golden/fixtures";
import {
  downtrend,
  extendedAboveSupport,
  pullbackIntoSupport,
  rangeBound,
} from "@/lib/test-utils/scenarios";

import { breakdownOf, describeBreakdown, type GateCountInput } from "./gate-counts";

function analysed(timeframe: string, candles = pullbackIntoSupport()): GateCountInput {
  const { result, diagnostics } = runAnalysisWithDiagnostics(candles);
  return { timeframe, ok: true, analysisStatus: result.status, diagnostics };
}

const failed = (timeframe: string): GateCountInput => ({
  timeframe,
  ok: false,
  analysisStatus: null,
  diagnostics: null,
});

const RESULTS = [
  analysed("H1", pullbackIntoSupport()),
  analysed("H1", downtrend()),
  analysed("H1", extendedAboveSupport()),
  analysed("H1", rangeBound()),
  analysed("H1", zoneRetest(101)),
  analysed("H1", zoneRetestRejection()),
  failed("H1"),
  analysed("H4", pullbackIntoSupport()),
  analysed("H4", zoneRetest(101)),
  failed("H4"),
];

describe("breakdownOf", () => {
  const counts = breakdownOf(RESULTS);

  it("keeps timeframes in the order they appear", () => {
    expect(counts.map((c) => c.timeframe)).toEqual(["H1", "H4"]);
  });

  it("counts what the engine decided, and reconciles with it", () => {
    for (const tf of counts) {
      const inputs = RESULTS.filter((r) => r.timeframe === tf.timeframe);
      const read = inputs.filter((r) => r.ok);

      expect(tf.analysed).toBe(read.length);
      expect(tf.failed).toBe(inputs.length - read.length);
      // Every analysis has one deciding gate, or passed.
      const blocked = Object.values(tf.blockingGates).reduce((a, b) => a + b, 0);
      expect(blocked + tf.passed).toBe(tf.analysed);
      expect(tf.passed).toBe(tf.verdicts.POTENTIAL_SETUP);
      expect(Object.values(tf.verdicts).reduce((a, b) => a + b, 0)).toBe(tf.analysed);
      // Every gate has exactly one outcome per analysis.
      for (const gate of GATE_ORDER) {
        const outcomes = Object.values(tf.gates[gate]).reduce((a, b) => a + b, 0);
        expect(outcomes, gate).toBe(tf.analysed);
      }
      for (const field of [tf.confirmation, tf.location, tf.reward]) {
        expect(Object.values(field).reduce((a, b) => a + b, 0)).toBe(tf.analysed);
      }
      // Each deciding gate is counted under its own code.
      for (const r of read) {
        const code = r.diagnostics!.blockingGate;
        if (code) expect(tf.blockingGates[code]).toBeGreaterThan(0);
      }
    }
  });

  it("counts the two location patterns from the facts alone", () => {
    // A lower-half retest: closed in a zone assigned to resistance, having come
    // down into it (audit D1).
    const retest = breakdownOf([analysed("H1", zoneRetest(101))])[0];
    expect(retest.blockingGates.PRICE_IN_RESISTANCE).toBe(1);
    expect(retest.resistanceEnteredFromAbove).toBe(1);

    // A rejection with confirmation present, closed above the zone it touched,
    // and held for not being in it (audit D2).
    const rejection = breakdownOf([analysed("H1", zoneRetestRejection())])[0];
    expect(rejection.blockingGates.PRICE_NOT_IN_ZONE).toBe(1);
    expect(rejection.confirmation.PRESENT).toBe(1);
    expect(rejection.confirmedAboveZoneAfterTouch).toBe(1);

    // A potential setup is neither.
    const potential = breakdownOf([analysed("H1", pullbackIntoSupport())])[0];
    expect(potential.resistanceEnteredFromAbove + potential.confirmedAboveZoneAfterTouch).toBe(0);
  });

  it("is empty for an empty pass", () => {
    expect(breakdownOf([])).toEqual([]);
  });
});

describe("describeBreakdown", () => {
  it("lists the most frequent deciding gates first, ties in gate order, then the rest", () => {
    const counts = breakdownOf([failed("H1")])[0];
    counts.analysed = 9;
    counts.passed = 1;
    counts.blockingGates.PRICE_NOT_IN_ZONE = 3;
    counts.blockingGates.HTF_COUNTER_TREND = 2;
    counts.blockingGates.PRICE_IN_RESISTANCE = 2;
    counts.blockingGates.VOLUME_THIN = 1;

    expect(describeBreakdown(counts, 3)).toBe(
      "H1: 9 analysed, 1 failed · passed 1 · " +
        "held at PRICE_NOT_IN_ZONE 3, HTF_COUNTER_TREND 2, PRICE_IN_RESISTANCE 2, other 1 · " +
        "confirmation present 0 · resistance entered from above 0 · " +
        "confirmed above zone after touch 0",
    );
  });

  it("says so when nothing was held back", () => {
    const counts = breakdownOf([analysed("H4")])[0];
    expect(describeBreakdown(counts)).toContain("held at nothing");
    expect(describeBreakdown(counts)).toContain("passed 1");
  });

  it("names only codes the engine has", () => {
    const counts = breakdownOf(RESULTS)[0];
    for (const code of Object.keys(counts.blockingGates)) expect(BLOCKING_CODES).toContain(code);
  });
});
