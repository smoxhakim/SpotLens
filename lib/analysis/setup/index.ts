import { ANALYSIS_DISCLAIMER, DISCLAIMER_VERSION } from "@/lib/constants/disclaimers";
import type { Candle } from "@/lib/market-data/provider";

import { runMarketRead, type MarketRead, type MarketReadOptions } from "../market-read";
import type { MtfSummary } from "../mtf";
import { calculateEntryZone } from "./entry";
import { calculateRiskReward } from "./risk-reward";
import { scoreSetup, type SetupScore } from "./score";
import { calculateStopLoss } from "./stop-loss";
import { calculateTakeProfits } from "./take-profit";
import { determineStatus } from "./status";
import type { TradeSetup, TradeStatus } from "./types";

export interface AnalysisResult {
  read: MarketRead;
  /** Higher-timeframe context, when the run was given a second timeframe. */
  mtf: MtfSummary | null;
  /** Null when no responsible long setup exists — the status explains why. */
  setup: TradeSetup | null;
  /**
   * Null only when the run stopped before a setup could be built. An AVOID
   * verdict withholds `setup` but keeps the score, since the score is the
   * reasoning behind the refusal rather than a number to trade on.
   */
  score: SetupScore | null;
  status: TradeStatus;
  statusReason: string;
  disclaimer: string;
  disclaimerVersion: string;
}

/**
 * The full "Analyze Market" run.
 *
 * Deterministic end to end: the same candles always produce the same levels,
 * score and status. No AI produces a number here — the explanation layer only
 * phrases what these calculations decide.
 *
 * When the geometry for a responsible long does not exist, `setup` is null and
 * the status carries the reason. Handing over entry and target numbers for a
 * trade the tool has just called AVOID would undo the point of saying it.
 */
export interface RunAnalysisOptions extends MarketReadOptions {
  /** Higher-timeframe read, folded into the score and the status. */
  mtf?: MtfSummary;
}

export function runAnalysis(candles: Candle[], options: RunAnalysisOptions = {}): AnalysisResult {
  const read = runMarketRead(candles, options);
  const mtf = options.mtf ?? null;

  const base = {
    read,
    mtf,
    disclaimer: ANALYSIS_DISCLAIMER,
    disclaimerVersion: DISCLAIMER_VERSION,
  };

  const noSetup = (status: TradeStatus, statusReason: string): AnalysisResult => ({
    ...base,
    setup: null,
    score: null,
    status,
    statusReason,
  });

  if (candles.length === 0) {
    return noSetup("AVOID", "No market data is available for this pair and timeframe.");
  }

  if (mtf?.agreement === "COUNTER_TREND_BOUNCE" || mtf?.agreement === "ALIGNED_BEARISH") {
    return noSetup(
      "AVOID",
      mtf.conflictNote ??
        "The higher timeframe is bearish, so no long setup is offered on the lower one.",
    );
  }

  if (read.trend.trend === "BEARISH") {
    return noSetup(
      "AVOID",
      "The trend is bearish. SpotLens does not produce long setups against the dominant trend, and it has no short setups to offer — this is a spot-only tool with no way to profit from a falling market.",
    );
  }

  const entry = calculateEntryZone(read, candles);
  if (!entry) {
    return noSetup(
      "WAIT_FOR_CONFIRMATION",
      "No support zone has formed below the current price on this timeframe, so there is no level to anchor an entry or a stop to. Without an invalidation level there is no trade to plan.",
    );
  }

  const stopLoss = calculateStopLoss(read, entry, candles, options.swingLookback);
  if (!stopLoss) {
    return noSetup(
      "WAIT_FOR_CONFIRMATION",
      "A structurally sound stop loss cannot be placed below this entry zone, so the risk on the trade cannot be defined. A trade whose risk cannot be measured should not be taken.",
    );
  }

  const takeProfits = calculateTakeProfits(read, entry, stopLoss, candles, options.swingLookback);
  const riskReward = calculateRiskReward(entry, stopLoss, takeProfits);
  if (!riskReward) {
    return noSetup(
      "WAIT_FOR_CONFIRMATION",
      "No target above the entry zone can be identified, so the reward on the trade cannot be measured against its risk.",
    );
  }

  const score = scoreSetup(read, entry, riskReward, mtf ?? undefined);
  const verdict = determineStatus(read, entry, riskReward, score, mtf ?? undefined);

  // The status engine can reach AVOID on evidence that only exists once the
  // setup has been built — a risk/reward below 1, or a score under the AVOID
  // grade. The levels are withheld here for the same reason they are on the
  // structural exits above: handing over an entry and a stop for a trade the
  // tool has just advised against undoes the point of saying it.
  //
  // The score survives, because it is the evidence *for* the refusal rather
  // than a level to act on. Nulling it would leave "scores 43/100" in the
  // status reason with nothing behind it.
  if (verdict.status === "AVOID") {
    return {
      ...base,
      setup: null,
      score,
      status: verdict.status,
      statusReason: verdict.reason,
    };
  }

  return {
    ...base,
    setup: { direction: "LONG", entry, stopLoss, takeProfits, riskReward },
    score,
    status: verdict.status,
    statusReason: verdict.reason,
  };
}

export { calculateEntryZone, EXTENDED_ATR_MULTIPLE } from "./entry";
export { calculateStopLoss, STOP_BUFFER_ATR, MAX_SENSIBLE_RISK_PCT } from "./stop-loss";
export { calculateTakeProfits } from "./take-profit";
export { calculateRiskReward } from "./risk-reward";
export { calculatePositionSize } from "./position-size";
export type { PositionSizeInput, PositionSizeResult } from "./position-size";
export { scoreSetup, SCORE_WEIGHTS } from "./score";
export type { SetupScore, SetupGrade, ScoreCategory } from "./score";
export { determineStatus, STATUS_LABELS } from "./status";
export { MIN_ACCEPTABLE_RR, GOOD_RR } from "./types";
export type {
  TradeSetup,
  TradeStatus,
  TradeDirection,
  EntryZone,
  StopLoss,
  TakeProfitTarget,
  RiskReward,
} from "./types";
