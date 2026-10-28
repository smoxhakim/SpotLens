/**
 * How an analysis reached its verdict: the deciding gate, every gate's outcome,
 * and the facts the engine had in hand. Observational only — see `types.ts`.
 */
export { buildDiagnostics } from "./build";
export {
  BLOCKING_CODES,
  GATE_OF,
  GATE_ORDER,
  GATE_STAGE,
  STAGE_ORDER,
  STATUS_OF,
  gateOutcomes,
  type GateFacts,
} from "./gates";
export type {
  AnalysisDiagnostics,
  AnalysisStage,
  AnalysisTrace,
  BlockingCode,
  GateCheck,
  GateId,
  GateOutcome,
  ZoneApproach,
  ZonePosition,
} from "./types";
