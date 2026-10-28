import { describe, expect, it } from "vitest";

import {
  BLOCKING_CODES,
  GATE_OF,
  GATE_ORDER,
  GATE_STAGE,
  STAGE_ORDER,
  STATUS_OF,
  gateOutcomes,
} from "./gates";
import type { GateId, GateOutcome } from "./types";

const none = new Set<GateId>();
const outcomeOf = (checks: ReturnType<typeof gateOutcomes>, gate: GateId): GateOutcome =>
  checks.find((c) => c.gate === gate)!.outcome;

describe("the gate tables", () => {
  it("lists 21 distinct gates, each with a stage", () => {
    expect(GATE_ORDER).toHaveLength(21);
    expect(new Set(GATE_ORDER).size).toBe(21);
    expect(Object.keys(GATE_STAGE).sort()).toEqual([...GATE_ORDER].sort());
    for (const gate of GATE_ORDER) expect(STAGE_ORDER).toContain(GATE_STAGE[gate]);
  });

  it("maps every code to a listed gate and a status", () => {
    expect(BLOCKING_CODES).toHaveLength(24);
    expect([...BLOCKING_CODES].sort()).toEqual(Object.keys(GATE_OF).sort());
    expect(Object.keys(STATUS_OF).sort()).toEqual(Object.keys(GATE_OF).sort());
    for (const code of BLOCKING_CODES) expect(GATE_ORDER).toContain(GATE_OF[code]);
  });

  it("orders the codes by the gate they belong to", () => {
    const positions = BLOCKING_CODES.map((code) => GATE_ORDER.indexOf(GATE_OF[code]));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("gives every gate at least one code", () => {
    const covered = new Set(BLOCKING_CODES.map((code) => GATE_OF[code]));
    expect([...covered].sort()).toEqual([...GATE_ORDER].sort());
  });
});

describe("gateOutcomes", () => {
  it("passes every gate when nothing held the analysis back", () => {
    const checks = gateOutcomes(null, { reached: "SCORE", notApplicable: none });

    expect(checks.map((c) => c.gate)).toEqual(GATE_ORDER);
    expect(checks.every((c) => c.outcome === "PASS" && c.code === null)).toBe(true);
  });

  it("fails the deciding gate only, with its code, and passes everything before it", () => {
    const checks = gateOutcomes("PRICE_NOT_IN_ZONE", { reached: "SCORE", notApplicable: none });
    const at = GATE_ORDER.indexOf("ZONE_LOCATION");

    expect(checks.filter((c) => c.outcome === "FAIL")).toEqual([
      { gate: "ZONE_LOCATION", outcome: "FAIL", code: "PRICE_NOT_IN_ZONE" },
    ]);
    expect(checks.slice(0, at).every((c) => c.outcome === "PASS")).toBe(true);
    // Everything after it had its inputs built, and was never asked.
    expect(checks.slice(at + 1).every((c) => c.outcome === "NOT_REACHED")).toBe(true);
  });

  it("separates a gate never asked from one whose inputs were never built", () => {
    // The higher-timeframe veto stops the run before any entry zone exists.
    const checks = gateOutcomes("HTF_COUNTER_TREND", { reached: "READ", notApplicable: none });

    expect(outcomeOf(checks, "DATA_PRESENT")).toBe("PASS");
    expect(outcomeOf(checks, "HIGHER_TF_VETO")).toBe("FAIL");
    expect(outcomeOf(checks, "ENTRY_TF_TREND")).toBe("NOT_REACHED");
    expect(outcomeOf(checks, "HISTORY")).toBe("NOT_REACHED");
    expect(outcomeOf(checks, "ENTRY_ZONE")).toBe("UNAVAILABLE");
    expect(outcomeOf(checks, "ZONE_LOCATION")).toBe("UNAVAILABLE");
    expect(outcomeOf(checks, "RR_FLOOR")).toBe("UNAVAILABLE");
    expect(outcomeOf(checks, "CONFIRMATION")).toBe("UNAVAILABLE");
  });

  it("follows the stages actually reached", () => {
    // No stop: the entry zone exists, nothing after it does.
    const checks = gateOutcomes("NO_STOP", { reached: "ENTRY", notApplicable: none });

    expect(outcomeOf(checks, "ENTRY_ZONE")).toBe("PASS");
    expect(outcomeOf(checks, "STOP")).toBe("FAIL");
    expect(outcomeOf(checks, "EXTENSION")).toBe("NOT_REACHED");
    expect(outcomeOf(checks, "LEVEL_ORDER")).toBe("UNAVAILABLE");
    expect(outcomeOf(checks, "REWARD_MEASURABLE")).toBe("UNAVAILABLE");
  });

  it("reports an absent optional input as not applicable, before or after the deciding gate", () => {
    const notApplicable = new Set<GateId>(["HIGHER_TF_VETO", "HIGHER_TF_DIRECTION", "VOLUME"]);
    const checks = gateOutcomes("PRICE_IN_RESISTANCE", { reached: "SCORE", notApplicable });

    expect(outcomeOf(checks, "HIGHER_TF_VETO")).toBe("NOT_APPLICABLE");
    expect(outcomeOf(checks, "HIGHER_TF_DIRECTION")).toBe("NOT_APPLICABLE");
    expect(outcomeOf(checks, "VOLUME")).toBe("NOT_APPLICABLE");
    expect(outcomeOf(checks, "RESISTANCE")).toBe("FAIL");
  });
});
