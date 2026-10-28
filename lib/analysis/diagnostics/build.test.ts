import { describe, expect, it } from "vitest";

import { RETEST_ZONE, zoneRetest, zoneRetestRejection } from "@/lib/golden/fixtures";
import { downtrend, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import { staleEntryTimeframe } from "../incomplete";
import { runAnalysis, runAnalysisWithDiagnostics, MIN_ACCEPTABLE_RR } from "../setup";
import { VOLUME_HOLD_RELATIVE } from "../setup/status";
import { ANALYSIS_RULES_VERSION, DIAGNOSTICS_VERSION } from "../version";
import type { AnalysisDiagnostics, GateId, GateOutcome } from "./types";

const outcome = (d: AnalysisDiagnostics, gate: GateId): GateOutcome =>
  d.gates.find((g) => g.gate === gate)!.outcome;

describe("diagnostics of a potential setup", () => {
  const candles = pullbackIntoSupport();
  const { result, diagnostics } = runAnalysisWithDiagnostics(candles);

  it("has no deciding gate, and every gate passed or did not apply", () => {
    expect(result.status).toBe("POTENTIAL_SETUP");
    expect(diagnostics.blockingGate).toBeNull();
    for (const g of diagnostics.gates) expect(["PASS", "NOT_APPLICABLE"]).toContain(g.outcome);
    // No higher timeframe and nothing declared incomplete: those gates cannot apply.
    expect(outcome(diagnostics, "HIGHER_TF_VETO")).toBe("NOT_APPLICABLE");
    expect(outcome(diagnostics, "DATA_COMPLETENESS")).toBe("NOT_APPLICABLE");
  });

  it("carries its versions", () => {
    expect(diagnostics.diagnosticsVersion).toBe(DIAGNOSTICS_VERSION);
    expect(diagnostics.rulesVersion).toBe(ANALYSIS_RULES_VERSION);
  });

  it("reports the facts the engine decided on, unchanged", () => {
    const setup = result.setup!;
    expect(diagnostics.reward).toMatchObject({
      entryBasis: "ZONE_MID",
      entry: setup.entry.mid,
      stop: setup.stopLoss.price,
      ratio: setup.riskReward.ratio,
      minimum: MIN_ACCEPTABLE_RR,
    });
    expect(diagnostics.volume).toEqual({
      relative: result.read.volume.read!.relative,
      trend: result.read.volume.read!.trend,
      aboveAverage: result.read.volume.read!.isAboveAverage,
      holdThreshold: VOLUME_HOLD_RELATIVE,
    });
    expect(diagnostics.confirmation?.status).toBe(result.confirmation!.status);
    expect(diagnostics.confirmation?.signals).toEqual(
      result.confirmation!.signals.map((s) => ({ type: s.type, signal: s.signal })),
    );
    expect(diagnostics.window).toEqual({
      candles: candles.length,
      lastOpenTime: candles.at(-1)!.openTime,
      lastCandleIsForming: false,
      priceBasis: "LAST_CLOSED",
      confirmationEvaluatedAt: result.confirmation!.evaluatedAt,
    });
  });
});

describe("diagnostics of an early exit", () => {
  it("reports what was never built as unavailable, and builds none of it", () => {
    const { result, diagnostics } = runAnalysisWithDiagnostics(downtrend());

    expect(result.status).toBe("AVOID");
    expect(diagnostics.blockingGate).toBe("ENTRY_TF_BEARISH");
    expect(outcome(diagnostics, "ENTRY_TF_TREND")).toBe("FAIL");
    expect(outcome(diagnostics, "HISTORY")).toBe("NOT_REACHED");
    expect(outcome(diagnostics, "ENTRY_ZONE")).toBe("UNAVAILABLE");
    expect(outcome(diagnostics, "CONFIRMATION")).toBe("UNAVAILABLE");
    expect(diagnostics.location).toBeNull();
    expect(diagnostics.reward).toBeNull();
    expect(diagnostics.confirmation).toBeNull();
  });

  it("describes an empty series without inventing a candle", () => {
    const { diagnostics } = runAnalysisWithDiagnostics([]);

    expect(diagnostics.blockingGate).toBe("NO_DATA");
    expect(diagnostics.window.candles).toBe(0);
    expect(diagnostics.window.lastOpenTime).toBeNull();
    expect(diagnostics.zoneAtClose).toBeNull();
    expect(diagnostics.volume).toBeNull();
  });
});

describe("location and the zone price closed in", () => {
  it("shows a lower-half retest as a zone entered from above and assigned to resistance", () => {
    const { result, diagnostics } = runAnalysisWithDiagnostics(zoneRetest(101));

    expect(diagnostics.blockingGate).toBe("PRICE_IN_RESISTANCE");
    expect(diagnostics.zoneAtClose).toEqual({
      ...RETEST_ZONE,
      assignedKind: "RESISTANCE",
      approach: "FROM_ABOVE",
    });
    // The entry re-anchored to the zone below, which the last candle never reached.
    expect(diagnostics.location?.position).toBe("ABOVE");
    expect(diagnostics.location?.lastClosedCandleTouchedZone).toBe(false);
    expect(diagnostics.location?.distanceAtr).toBe(result.setup!.entry.distanceAtr);
  });

  it("shows an upper-half retest inside the zone, assigned to support", () => {
    const { diagnostics } = runAnalysisWithDiagnostics(zoneRetest(103));

    expect(diagnostics.location?.position).toBe("INSIDE_UPPER_HALF");
    expect(diagnostics.zoneAtClose?.assignedKind).toBe("SUPPORT");
    expect(diagnostics.zoneAtClose?.approach).toBe("FROM_ABOVE");
  });

  it("shows a rejection that closed above the zone it touched", () => {
    const { result, diagnostics } = runAnalysisWithDiagnostics(zoneRetestRejection());

    expect(diagnostics.location?.position).toBe("ABOVE");
    expect(diagnostics.location?.lastClosedCandleTouchedZone).toBe(true);
    expect(diagnostics.zoneAtClose).toBeNull();
    expect(diagnostics.confirmation?.status).toBe(result.confirmation!.status);
  });
});

describe("window and data facts", () => {
  it("reads the touch from the last closed candle when the newest is forming", () => {
    const candles = pullbackIntoSupport();
    const { result, diagnostics } = runAnalysisWithDiagnostics(candles, {
      lastCandleIsForming: true,
    });
    const closed = candles.at(-2)!;
    const zone = result.setup?.entry;

    expect(diagnostics.window.priceBasis).toBe("FORMING");
    expect(diagnostics.window.lastCandleIsForming).toBe(true);
    if (zone) {
      expect(diagnostics.location?.lastClosedCandleTouchedZone).toBe(
        closed.low <= zone.high && closed.high >= zone.low,
      );
    }
  });

  it("names the data-completeness hold, and what was missing, without its prose", () => {
    const { result, diagnostics } = runAnalysisWithDiagnostics(pullbackIntoSupport(), {
      incomplete: staleEntryTimeframe("H1"),
    });

    expect(result.status).toBe("WAIT_FOR_CONFIRMATION");
    expect(diagnostics.blockingGate).toBe("HELD_INCOMPLETE_DATA");
    expect(outcome(diagnostics, "DATA_COMPLETENESS")).toBe("FAIL");
    expect(diagnostics.incomplete).toEqual({ scope: "ENTRY", timeframe: "H1", gap: "STALE" });
  });
});

describe("purity", () => {
  it("is identical across runs, and leaves the result exactly as runAnalysis returns it", () => {
    const candles = pullbackIntoSupport();
    const first = runAnalysisWithDiagnostics(candles);
    const second = runAnalysisWithDiagnostics(candles);

    expect(second.diagnostics).toStrictEqual(first.diagnostics);
    expect(first.result).toStrictEqual(runAnalysis(candles));
  });
});
