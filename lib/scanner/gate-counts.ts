import {
  BLOCKING_CODES,
  GATE_ORDER,
  GOOD_RR,
  type AnalysisDiagnostics,
  type BlockingCode,
  type ConfirmationStatus,
  type GateId,
  type GateOutcome,
  type TradeStatus,
  type ZonePosition,
} from "@/lib/analysis";

/**
 * Where each analysis in a pass stopped, counted per timeframe.
 *
 * Counts of what the engine already decided, read off each result's
 * diagnostics. Nothing here evaluates a rule, ranks a market or excludes one:
 * it says which gate held each analysis back, so a pass that found no
 * potential setup also says why.
 */

/** The fields a scan result needs to be counted. */
export interface GateCountInput {
  timeframe: string;
  ok: boolean;
  analysisStatus: TradeStatus | null;
  diagnostics: AnalysisDiagnostics | null;
}

/**
 * The reward as the engine measured it. SYNTHETIC is a ratio to an R-multiple
 * target — arithmetic, not a measurement — so it is never bucketed by size.
 */
export type RewardBucket =
  "NOT_MEASURED" | "SYNTHETIC" | "BELOW_ONE" | "BELOW_MINIMUM" | "ACCEPTABLE" | "GOOD";

export interface TimeframeGateCounts {
  timeframe: string;
  /** Analyses counted below. */
  analysed: number;
  /** Markets that failed before the engine read them; they have no gate to count. */
  failed: number;
  verdicts: Record<TradeStatus, number>;
  /** The deciding gate of each analysis that has one. */
  blockingGates: Record<BlockingCode, number>;
  /** Analyses no gate held back: the potential setups. */
  passed: number;
  /** Every gate's outcomes. Each gate's counts sum to `analysed`. */
  gates: Record<GateId, Record<GateOutcome, number>>;
  confirmation: Record<ConfirmationStatus | "NONE", number>;
  location: Record<ZonePosition | "NONE", number>;
  reward: Record<RewardBucket, number>;
  /** Price closed inside a zone the engine assigned to resistance, having come down into it. */
  resistanceEnteredFromAbove: number;
  /** Confirmation present while price sits above an entry zone its last closed candle touched. */
  confirmedAboveZoneAfterTouch: number;
}

/** Per timeframe, in the order the timeframes first appear in `results`. */
export function breakdownOf(results: readonly GateCountInput[]): TimeframeGateCounts[] {
  const byTimeframe = new Map<string, TimeframeGateCounts>();

  for (const result of results) {
    let counts = byTimeframe.get(result.timeframe);
    if (!counts) {
      counts = emptyCounts(result.timeframe);
      byTimeframe.set(result.timeframe, counts);
    }

    const { diagnostics, analysisStatus } = result;
    if (!result.ok || diagnostics === null || analysisStatus === null) {
      counts.failed += 1;
      continue;
    }

    counts.analysed += 1;
    counts.verdicts[analysisStatus] += 1;
    if (diagnostics.blockingGate === null) counts.passed += 1;
    else counts.blockingGates[diagnostics.blockingGate] += 1;
    for (const check of diagnostics.gates) counts.gates[check.gate][check.outcome] += 1;
    counts.confirmation[diagnostics.confirmation?.status ?? "NONE"] += 1;
    counts.location[diagnostics.location?.position ?? "NONE"] += 1;
    counts.reward[rewardBucket(diagnostics.reward)] += 1;

    const zone = diagnostics.zoneAtClose;
    if (zone?.assignedKind === "RESISTANCE" && zone.approach === "FROM_ABOVE") {
      counts.resistanceEnteredFromAbove += 1;
    }
    const location = diagnostics.location;
    if (
      diagnostics.confirmation?.status === "PRESENT" &&
      location?.position === "ABOVE" &&
      location.lastClosedCandleTouchedZone === true
    ) {
      counts.confirmedAboveZoneAfterTouch += 1;
    }
  }

  return [...byTimeframe.values()];
}

/**
 * One line for the scanner log: the gates that held analyses back, most
 * frequent first (ties in gate order), then the two location counts.
 */
export function describeBreakdown(counts: TimeframeGateCounts, top = 5): string {
  const held = BLOCKING_CODES.filter((code) => counts.blockingGates[code] > 0).sort(
    (a, b) => counts.blockingGates[b] - counts.blockingGates[a],
  );
  const shown = held.slice(0, top).map((code) => `${code} ${counts.blockingGates[code]}`);
  const others = held.slice(top).reduce((sum, code) => sum + counts.blockingGates[code], 0);
  if (others > 0) shown.push(`other ${others}`);

  return [
    `${counts.timeframe}: ${counts.analysed} analysed` +
      (counts.failed > 0 ? `, ${counts.failed} failed` : ""),
    `passed ${counts.passed}`,
    `held at ${shown.length > 0 ? shown.join(", ") : "nothing"}`,
    `confirmation present ${counts.confirmation.PRESENT}`,
    `resistance entered from above ${counts.resistanceEnteredFromAbove}`,
    `confirmed above zone after touch ${counts.confirmedAboveZoneAfterTouch}`,
  ].join(" · ");
}

function rewardBucket(reward: AnalysisDiagnostics["reward"]): RewardBucket {
  if (!reward) return "NOT_MEASURED";
  if (reward.isSynthetic) return "SYNTHETIC";
  if (reward.ratio < 1) return "BELOW_ONE";
  if (reward.isPoor) return "BELOW_MINIMUM";
  return reward.ratio < GOOD_RR ? "ACCEPTABLE" : "GOOD";
}

function emptyCounts(timeframe: string): TimeframeGateCounts {
  const zeros = <K extends string>(keys: readonly K[]) =>
    Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  const outcomes: GateOutcome[] = ["PASS", "FAIL", "NOT_APPLICABLE", "NOT_REACHED", "UNAVAILABLE"];

  return {
    timeframe,
    analysed: 0,
    failed: 0,
    verdicts: zeros<TradeStatus>([
      "POTENTIAL_SETUP",
      "WAIT_FOR_CONFIRMATION",
      "HIGH_RISK",
      "AVOID",
    ]),
    blockingGates: zeros(BLOCKING_CODES),
    passed: 0,
    gates: Object.fromEntries(GATE_ORDER.map((gate) => [gate, zeros(outcomes)])) as Record<
      GateId,
      Record<GateOutcome, number>
    >,
    confirmation: zeros<ConfirmationStatus | "NONE">([
      "PRESENT",
      "NOT_PRESENT",
      "CONTRADICTED",
      "NONE",
    ]),
    location: zeros<ZonePosition | "NONE">([
      "BELOW",
      "INSIDE_LOWER_HALF",
      "INSIDE_UPPER_HALF",
      "ABOVE",
      "NONE",
    ]),
    reward: zeros<RewardBucket>([
      "NOT_MEASURED",
      "SYNTHETIC",
      "BELOW_ONE",
      "BELOW_MINIMUM",
      "ACCEPTABLE",
      "GOOD",
    ]),
    resistanceEnteredFromAbove: 0,
    confirmedAboveZoneAfterTouch: 0,
  };
}
