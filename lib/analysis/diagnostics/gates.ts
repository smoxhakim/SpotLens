import type { TradeStatus } from "../setup/types";
import type { AnalysisStage, BlockingCode, GateCheck, GateId } from "./types";

/**
 * The engine's gates, in the order `runAnalysis` and then `determineStatus`
 * apply them.
 *
 * A mirror of the source order, not a second copy of the rules: nothing here
 * evaluates a condition. `determineStatus` repeats the higher-timeframe veto
 * and the bearish-trend check that `runAnalysis` already made; both copies map
 * to the same gate, which is why each appears once.
 */
export const GATE_ORDER: readonly GateId[] = [
  "DATA_PRESENT",
  "HIGHER_TF_VETO",
  "ENTRY_TF_TREND",
  "ENTRY_ZONE",
  "STOP",
  "LEVEL_ORDER",
  "REWARD_MEASURABLE",
  "RR_FLOOR",
  "SCORE_FLOOR",
  "RR_MINIMUM",
  "HISTORY",
  "RESISTANCE",
  "EXTENSION",
  "ENTRY_TF_RANGE",
  "ZONE_LOCATION",
  "REWARD_STRUCTURE",
  "HIGHER_TF_DIRECTION",
  "VOLUME",
  "SCORE_GRADE",
  "CONFIRMATION",
  "DATA_COMPLETENESS",
];

/** The pipeline stages, in the order they run. */
export const STAGE_ORDER: readonly AnalysisStage[] = [
  "READ",
  "ENTRY",
  "STOP",
  "TARGETS",
  "REWARD",
  "SCORE",
];

/**
 * The stage that builds each gate's inputs. A gate after the deciding one is
 * NOT_REACHED when its stage ran and UNAVAILABLE when it did not.
 */
export const GATE_STAGE: Record<GateId, AnalysisStage> = {
  DATA_PRESENT: "READ",
  HIGHER_TF_VETO: "READ",
  ENTRY_TF_TREND: "READ",
  ENTRY_ZONE: "ENTRY",
  STOP: "STOP",
  LEVEL_ORDER: "TARGETS",
  REWARD_MEASURABLE: "REWARD",
  RR_FLOOR: "REWARD",
  SCORE_FLOOR: "SCORE",
  RR_MINIMUM: "REWARD",
  HISTORY: "READ",
  RESISTANCE: "READ",
  EXTENSION: "ENTRY",
  ENTRY_TF_RANGE: "READ",
  ZONE_LOCATION: "ENTRY",
  REWARD_STRUCTURE: "REWARD",
  HIGHER_TF_DIRECTION: "READ",
  VOLUME: "READ",
  SCORE_GRADE: "SCORE",
  CONFIRMATION: "SCORE",
  DATA_COMPLETENESS: "READ",
};

/** The gate each code is a failure of. */
export const GATE_OF: Record<BlockingCode, GateId> = {
  NO_DATA: "DATA_PRESENT",
  HTF_COUNTER_TREND: "HIGHER_TF_VETO",
  HTF_BEARISH: "HIGHER_TF_VETO",
  ENTRY_TF_BEARISH: "ENTRY_TF_TREND",
  PULLBACK_IN_UPTREND_VETO: "ENTRY_TF_TREND",
  NO_ENTRY_ZONE: "ENTRY_ZONE",
  NO_STOP: "STOP",
  INVALID_LEVELS: "LEVEL_ORDER",
  NO_MEASURABLE_REWARD: "REWARD_MEASURABLE",
  RR_BELOW_ONE: "RR_FLOOR",
  SCORE_AVOID_GRADE: "SCORE_FLOOR",
  RR_BELOW_MINIMUM: "RR_MINIMUM",
  INSUFFICIENT_HISTORY: "HISTORY",
  PRICE_IN_RESISTANCE: "RESISTANCE",
  PRICE_EXTENDED: "EXTENSION",
  ENTRY_TF_SIDEWAYS: "ENTRY_TF_RANGE",
  PRICE_NOT_IN_ZONE: "ZONE_LOCATION",
  REWARD_NOT_STRUCTURAL: "REWARD_STRUCTURE",
  HTF_MIXED: "HIGHER_TF_DIRECTION",
  VOLUME_THIN: "VOLUME",
  SCORE_WEAK: "SCORE_GRADE",
  CONFIRMATION_CONTRADICTED: "CONFIRMATION",
  CONFIRMATION_NOT_PRESENT: "CONFIRMATION",
  HELD_INCOMPLETE_DATA: "DATA_COMPLETENESS",
};

/**
 * The status the engine returns with each code. Used to check the codes are
 * attached to the right returns; the engine itself never reads it.
 */
export const STATUS_OF: Record<BlockingCode, TradeStatus> = {
  NO_DATA: "AVOID",
  HTF_COUNTER_TREND: "AVOID",
  HTF_BEARISH: "AVOID",
  ENTRY_TF_BEARISH: "AVOID",
  PULLBACK_IN_UPTREND_VETO: "AVOID",
  NO_ENTRY_ZONE: "WAIT_FOR_CONFIRMATION",
  NO_STOP: "WAIT_FOR_CONFIRMATION",
  INVALID_LEVELS: "WAIT_FOR_CONFIRMATION",
  NO_MEASURABLE_REWARD: "WAIT_FOR_CONFIRMATION",
  RR_BELOW_ONE: "AVOID",
  SCORE_AVOID_GRADE: "AVOID",
  RR_BELOW_MINIMUM: "HIGH_RISK",
  INSUFFICIENT_HISTORY: "HIGH_RISK",
  PRICE_IN_RESISTANCE: "HIGH_RISK",
  PRICE_EXTENDED: "WAIT_FOR_CONFIRMATION",
  ENTRY_TF_SIDEWAYS: "WAIT_FOR_CONFIRMATION",
  PRICE_NOT_IN_ZONE: "WAIT_FOR_CONFIRMATION",
  REWARD_NOT_STRUCTURAL: "WAIT_FOR_CONFIRMATION",
  HTF_MIXED: "WAIT_FOR_CONFIRMATION",
  VOLUME_THIN: "WAIT_FOR_CONFIRMATION",
  SCORE_WEAK: "WAIT_FOR_CONFIRMATION",
  CONFIRMATION_CONTRADICTED: "WAIT_FOR_CONFIRMATION",
  CONFIRMATION_NOT_PRESENT: "WAIT_FOR_CONFIRMATION",
  HELD_INCOMPLETE_DATA: "WAIT_FOR_CONFIRMATION",
};

/** Every code, in the order of the gate it belongs to. */
export const BLOCKING_CODES: readonly BlockingCode[] = (
  Object.keys(GATE_OF) as BlockingCode[]
).sort((a, b) => GATE_ORDER.indexOf(GATE_OF[a]) - GATE_ORDER.indexOf(GATE_OF[b]));

export interface GateFacts {
  /** The furthest stage whose output exists. */
  reached: AnalysisStage;
  /** Gates whose optional input is absent, so they cannot hold anything back. */
  notApplicable: ReadonlySet<GateId>;
}

/**
 * Each gate's outcome, derived from the code the engine returned and which of
 * its inputs exist. No gate's condition is evaluated here: before the deciding
 * gate the engine let the analysis through, at it the engine decided, and
 * after it the engine never asked.
 */
export function gateOutcomes(blockingGate: BlockingCode | null, facts: GateFacts): GateCheck[] {
  const blocked =
    blockingGate === null ? GATE_ORDER.length : GATE_ORDER.indexOf(GATE_OF[blockingGate]);
  const reached = STAGE_ORDER.indexOf(facts.reached);

  return GATE_ORDER.map((gate, index): GateCheck => {
    if (index === blocked) return { gate, outcome: "FAIL", code: blockingGate };
    if (facts.notApplicable.has(gate)) return { gate, outcome: "NOT_APPLICABLE", code: null };
    if (index < blocked) return { gate, outcome: "PASS", code: null };
    const built = STAGE_ORDER.indexOf(GATE_STAGE[gate]) <= reached;
    return { gate, outcome: built ? "NOT_REACHED" : "UNAVAILABLE", code: null };
  });
}
