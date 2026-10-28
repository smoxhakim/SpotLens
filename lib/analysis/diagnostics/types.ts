import type { VolumeRead } from "@/lib/indicators";
import type { Candle } from "@/lib/market-data/provider";

import type {
  ConfirmationResult,
  ConfirmationSignalDirection,
  ConfirmationSignalType,
  ConfirmationStatus,
} from "../confirmation";
import type { AnalysisShortfall } from "../incomplete";
import type { MarketRead } from "../market-read";
import type { MtfAgreement, MtfSummary } from "../mtf";
import type { SetupScore } from "../setup/score";
import type { EntryZone, RiskReward, StopLoss, TakeProfitTarget, TargetKind } from "../setup/types";
import type { Trend, TrendRead } from "../trend";
import type { ZoneKind } from "../zones";

/**
 * Diagnostics: how an analysis reached its verdict.
 *
 * Observational only. Every outcome below is read off the decision the engine
 * already made — the gate it returned at — and never re-evaluated, so a
 * diagnostics record cannot disagree with the verdict it describes. Nothing in
 * the engine reads one back.
 */

/** One rule of the engine, named for what it asks. Listed in `GATE_ORDER`. */
export type GateId =
  | "DATA_PRESENT"
  | "HIGHER_TF_VETO"
  | "ENTRY_TF_TREND"
  | "ENTRY_ZONE"
  | "STOP"
  | "LEVEL_ORDER"
  | "REWARD_MEASURABLE"
  | "RR_FLOOR"
  | "SCORE_FLOOR"
  | "RR_MINIMUM"
  | "HISTORY"
  | "RESISTANCE"
  | "EXTENSION"
  | "ENTRY_TF_RANGE"
  | "ZONE_LOCATION"
  | "REWARD_STRUCTURE"
  | "HIGHER_TF_DIRECTION"
  | "VOLUME"
  | "SCORE_GRADE"
  | "CONFIRMATION"
  | "DATA_COMPLETENESS";

/**
 * The specific return that decided a verdict. A gate with two returns — the
 * higher-timeframe veto, the entry-timeframe trend, confirmation — has a code
 * for each. Potential has none.
 */
export type BlockingCode =
  | "NO_DATA"
  | "HTF_COUNTER_TREND"
  | "HTF_BEARISH"
  | "ENTRY_TF_BEARISH"
  | "PULLBACK_IN_UPTREND_VETO"
  | "NO_ENTRY_ZONE"
  | "NO_STOP"
  | "INVALID_LEVELS"
  | "NO_MEASURABLE_REWARD"
  | "RR_BELOW_ONE"
  | "SCORE_AVOID_GRADE"
  | "RR_BELOW_MINIMUM"
  | "INSUFFICIENT_HISTORY"
  | "PRICE_IN_RESISTANCE"
  | "PRICE_EXTENDED"
  | "ENTRY_TF_SIDEWAYS"
  | "PRICE_NOT_IN_ZONE"
  | "REWARD_NOT_STRUCTURAL"
  | "HTF_MIXED"
  | "VOLUME_THIN"
  | "SCORE_WEAK"
  | "CONFIRMATION_CONTRADICTED"
  | "CONFIRMATION_NOT_PRESENT"
  | "HELD_INCOMPLETE_DATA";

/**
 * What the engine did at a gate.
 *
 *   PASS            — evaluated, and let the analysis through.
 *   FAIL            — evaluated, and decided the verdict. At most one gate.
 *   NOT_APPLICABLE  — its optional input is absent (no higher timeframe, no
 *                     volume read, no targets, no confirmation, nothing
 *                     declared incomplete), so it cannot hold anything back.
 *   NOT_REACHED     — after the deciding gate; its inputs existed, but the
 *                     engine had already decided.
 *   UNAVAILABLE     — after the deciding gate, and its inputs were never
 *                     built: there is no answer to report.
 *
 * Only a gate before the deciding one can PASS. A gate after it is never
 * reported as passing or failing, because the engine never asked.
 */
export type GateOutcome = "PASS" | "FAIL" | "NOT_APPLICABLE" | "NOT_REACHED" | "UNAVAILABLE";

export interface GateCheck {
  gate: GateId;
  outcome: GateOutcome;
  /** Set on the FAIL gate only. */
  code: BlockingCode | null;
}

/** The pipeline stages that produce a gate's inputs, in the order they run. */
export type AnalysisStage = "READ" | "ENTRY" | "STOP" | "TARGETS" | "REWARD" | "SCORE";

/** Where price sits relative to the entry zone. At the midpoint counts as the upper half. */
export type ZonePosition = "BELOW" | "INSIDE_LOWER_HALF" | "INSIDE_UPPER_HALF" | "ABOVE";

/** The side price last closed on before it came into a zone. */
export type ZoneApproach = "FROM_ABOVE" | "FROM_BELOW" | "UNKNOWN";

export interface AnalysisDiagnostics {
  diagnosticsVersion: string;
  rulesVersion: string;
  /** The return that decided the verdict. Null on a potential setup. */
  blockingGate: BlockingCode | null;
  /** Every gate, in `GATE_ORDER`. */
  gates: GateCheck[];
  window: {
    candles: number;
    /** Open time of the newest candle. Null when there were none. */
    lastOpenTime: number | null;
    lastCandleIsForming: boolean;
    /** Which candle's close the price was read from. */
    priceBasis: "LAST_CLOSED" | "FORMING";
    /** Close time of the candle confirmation judged. Null when it never ran. */
    confirmationEvaluatedAt: number | null;
  };
  trend: {
    entry: Trend;
    confidence: TrendRead["confidence"];
    conflict: boolean;
    higher: Trend | null;
    agreement: MtfAgreement | null;
  };
  /** Relative to the entry zone. Null when none was built. */
  location: {
    position: ZonePosition;
    /** The engine's own figure: ATR from the top of the zone, negative below it. */
    distanceAtr: number;
    zoneWidthAtr: number;
    /** Whether the newest closed candle's range overlapped the zone. Null with none. */
    lastClosedCandleTouchedZone: boolean | null;
  } | null;
  /**
   * The read's zone that contains the price, and which side the engine
   * assigned it to. Reported, never acted on. Null when price is in no zone.
   */
  zoneAtClose: {
    low: number;
    high: number;
    mid: number;
    assignedKind: ZoneKind;
    approach: ZoneApproach;
  } | null;
  /** Null when there is no volume read. */
  volume: {
    relative: number;
    trend: VolumeRead["trend"];
    aboveAverage: boolean;
    /** The relative volume below which the engine holds a setup. */
    holdThreshold: number;
  } | null;
  /**
   * The reward as the engine measured it. Null when it never got that far.
   * Price fields are null on AVOID, as the result's own levels are.
   */
  reward: {
    entryBasis: "ZONE_MID";
    entry: number | null;
    stop: number | null;
    risk: number | null;
    target: number | null;
    measuredTo: TakeProfitTarget["label"];
    targetKind: TargetKind | null;
    /** Unrounded. */
    ratio: number;
    isSynthetic: boolean;
    isPoor: boolean;
    minimum: number;
  } | null;
  /** Null when confirmation never ran. */
  confirmation: {
    status: ConfirmationStatus;
    evaluatedAt: number;
    signals: { type: ConfirmationSignalType; signal: ConfirmationSignalDirection }[];
  } | null;
  incomplete: Pick<AnalysisShortfall, "scope" | "timeframe" | "gap"> | null;
}

/**
 * Everything the engine computed on the way to its verdict, and the return it
 * took. In memory only, and never part of the result: the diagnostics builder
 * reads it, and nothing else does.
 *
 * A stage the engine never reached stays null, so a diagnostics record can
 * tell an input that was never built from one that was.
 */
export interface AnalysisTrace {
  candles: Candle[];
  lastCandleIsForming: boolean;
  read: MarketRead;
  mtf: MtfSummary | null;
  incomplete: AnalysisShortfall | null;
  entry: EntryZone | null;
  stopLoss: StopLoss | null;
  takeProfits: TakeProfitTarget[] | null;
  riskReward: RiskReward | null;
  score: SetupScore | null;
  confirmation: ConfirmationResult | null;
  blockingGate: BlockingCode | null;
}
