import type { Candle } from "@/lib/market-data/provider";

import type { MarketRead } from "../market-read";
import type { AnalysisResult } from "../setup";
import { VOLUME_HOLD_RELATIVE } from "../setup/status";
import { MIN_ACCEPTABLE_RR, type EntryZone } from "../setup/types";
import { DIAGNOSTICS_VERSION, ANALYSIS_RULES_VERSION } from "../version";
import { isInZone, type PriceZone } from "../zones";
import { gateOutcomes } from "./gates";
import type {
  AnalysisDiagnostics,
  AnalysisStage,
  AnalysisTrace,
  GateId,
  ZoneApproach,
  ZonePosition,
} from "./types";

/**
 * The diagnostics record for one analysis.
 *
 * Pure, and computed after the verdict from what the engine already produced:
 * the gate it returned at, and the values it built on the way. It decides
 * nothing and feeds nothing back. The figures it adds — where price sits in the
 * zone, the side price approached from — describe the chart; none of them is a
 * level, a score or a ratio.
 */
export function buildDiagnostics(
  trace: AnalysisTrace,
  result: AnalysisResult,
): AnalysisDiagnostics {
  const { read, mtf } = trace;
  // AVOID withholds its levels from the result, so no price is quoted here either.
  const withhold = result.status === "AVOID";

  return {
    diagnosticsVersion: DIAGNOSTICS_VERSION,
    rulesVersion: ANALYSIS_RULES_VERSION,
    blockingGate: trace.blockingGate,
    gates: gateOutcomes(trace.blockingGate, {
      reached: stageReached(trace),
      notApplicable: notApplicable(trace),
    }),
    window: {
      candles: read.candleCount,
      lastOpenTime: read.candleCount > 0 ? read.lastCandleTime : null,
      lastCandleIsForming: trace.lastCandleIsForming,
      priceBasis: trace.lastCandleIsForming ? "FORMING" : "LAST_CLOSED",
      confirmationEvaluatedAt: trace.confirmation?.evaluatedAt ?? null,
    },
    trend: {
      entry: read.trend.trend,
      confidence: read.trend.confidence,
      conflict: read.trend.conflict,
      higher: mtf?.higherTrend ?? null,
      agreement: mtf?.agreement ?? null,
    },
    location: trace.entry ? locationOf(trace.entry, read, trace) : null,
    zoneAtClose: zoneAtClose(read, trace.candles),
    volume: read.volume.read
      ? {
          relative: read.volume.read.relative,
          trend: read.volume.read.trend,
          aboveAverage: read.volume.read.isAboveAverage,
          holdThreshold: VOLUME_HOLD_RELATIVE,
        }
      : null,
    reward: rewardOf(trace, withhold),
    confirmation: trace.confirmation
      ? {
          status: trace.confirmation.status,
          evaluatedAt: trace.confirmation.evaluatedAt,
          signals: trace.confirmation.signals.map((s) => ({ type: s.type, signal: s.signal })),
        }
      : null,
    incomplete: trace.incomplete
      ? {
          scope: trace.incomplete.scope,
          timeframe: trace.incomplete.timeframe,
          gap: trace.incomplete.gap,
        }
      : null,
  };
}

/** The furthest stage whose output exists. Score and confirmation are built together. */
function stageReached(trace: AnalysisTrace): AnalysisStage {
  if (trace.score) return "SCORE";
  if (trace.riskReward) return "REWARD";
  if (trace.takeProfits) return "TARGETS";
  if (trace.stopLoss) return "STOP";
  if (trace.entry) return "ENTRY";
  return "READ";
}

/**
 * Gates whose optional input is absent. Presence checks only: each is the
 * absence that makes the engine's own condition let the analysis through.
 * Targets and confirmation count only once their stage ran — before that, it
 * is not known whether they would have existed.
 */
function notApplicable(trace: AnalysisTrace): Set<GateId> {
  const gates = new Set<GateId>();
  if (!trace.mtf) {
    gates.add("HIGHER_TF_VETO");
    gates.add("HIGHER_TF_DIRECTION");
  }
  if (!trace.read.volume.read) gates.add("VOLUME");
  if (!trace.incomplete) gates.add("DATA_COMPLETENESS");
  if (trace.takeProfits && trace.takeProfits.length === 0) gates.add("LEVEL_ORDER");
  if (trace.score && !trace.confirmation) gates.add("CONFIRMATION");
  return gates;
}

function locationOf(
  entry: EntryZone,
  read: MarketRead,
  trace: AnalysisTrace,
): NonNullable<AnalysisDiagnostics["location"]> {
  // Positive by construction: the engine builds no entry zone without an ATR.
  const atr = read.indicators.atr14 ?? Number.NaN;
  const last = lastClosedCandle(trace);

  return {
    position: positionOf(read.price, entry),
    distanceAtr: entry.distanceAtr,
    zoneWidthAtr: (entry.high - entry.low) / atr,
    lastClosedCandleTouchedZone: last ? last.low <= entry.high && last.high >= entry.low : null,
  };
}

/** Inside or not is the engine's own answer (`priceInZone`); only the half is added. */
function positionOf(price: number, entry: EntryZone): ZonePosition {
  if (entry.priceInZone) return price < entry.mid ? "INSIDE_LOWER_HALF" : "INSIDE_UPPER_HALF";
  return price > entry.high ? "ABOVE" : "BELOW";
}

function lastClosedCandle(trace: AnalysisTrace): Candle | null {
  const index = trace.candles.length - (trace.lastCandleIsForming ? 2 : 1);
  return trace.candles[index] ?? null;
}

/**
 * The zone price closed inside, if any, with the side the engine assigned it
 * and the side price came from. Resistance is checked first, then support.
 */
function zoneAtClose(read: MarketRead, candles: Candle[]): AnalysisDiagnostics["zoneAtClose"] {
  const zone = [...read.resistance, ...read.support].find((z) => isInZone(read.price, z));
  if (!zone) return null;

  return {
    low: zone.low,
    high: zone.high,
    mid: zone.mid,
    assignedKind: zone.kind,
    approach: approachOf(zone, candles),
  };
}

/** The side of the most recent close outside the zone, before the newest candle. */
function approachOf(zone: PriceZone, candles: Candle[]): ZoneApproach {
  for (let i = candles.length - 2; i >= 0; i--) {
    const close = candles[i].close;
    if (close > zone.high) return "FROM_ABOVE";
    if (close < zone.low) return "FROM_BELOW";
  }
  return "UNKNOWN";
}

function rewardOf(trace: AnalysisTrace, withhold: boolean): AnalysisDiagnostics["reward"] {
  const { riskReward, entry, stopLoss, takeProfits } = trace;
  if (!riskReward || !entry || !stopLoss) return null;

  const target = takeProfits?.find((t) => t.label === riskReward.measuredTo) ?? null;

  return {
    entryBasis: "ZONE_MID",
    entry: withhold ? null : entry.mid,
    stop: withhold ? null : stopLoss.price,
    risk: withhold ? null : riskReward.risk,
    target: withhold || !target ? null : target.level,
    measuredTo: riskReward.measuredTo,
    targetKind: target?.kind ?? null,
    ratio: riskReward.ratio,
    isSynthetic: riskReward.isSynthetic,
    isPoor: riskReward.isPoor,
    minimum: MIN_ACCEPTABLE_RR,
  };
}
