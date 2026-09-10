import { formatPrice } from "@/lib/format";
import type { Candle } from "@/lib/market-data/provider";

import type { MarketRead } from "../market-read";
import { findSwingPoints } from "../structure";
import type { EntryZone, StopLoss, TakeProfitTarget, TargetKind } from "./types";

const LABELS: TakeProfitTarget["label"][] = ["TP1", "TP2", "TP3"];

/** R-multiples used only when the chart offers no structural target. */
const FALLBACK_R_MULTIPLES = [1.5, 2.5, 4];

/**
 * Structural targets beyond this many R are dropped.
 *
 * A level 13R away is real, but it is not a target for a trade whose stop is a
 * few percent wide — it is a cycle high months out. Listing it as TP3 makes the
 * ladder look absurd and buries the targets that matter. The level is still
 * mentioned in the replacement target's reasoning.
 */
const MAX_TARGET_R = 8;

/**
 * Take-profit targets drawn from structure, not round numbers.
 *
 * Each target is a place sellers have actually shown up before: a resistance
 * zone, or a prior significant high. Targets are set at the *near* edge of a
 * resistance zone rather than its middle — getting filled matters more than
 * squeezing the last fraction out of a level that has rejected price before.
 */
export function calculateTakeProfits(
  read: MarketRead,
  entry: EntryZone,
  stopLoss: StopLoss,
  candles: Candle[],
  swingLookback = 2,
): TakeProfitTarget[] {
  const risk = entry.mid - stopLoss.price;
  if (risk <= 0) return [];

  const candidates: { level: number; reason: string; kind: TargetKind }[] = [];

  for (const zone of read.resistance) {
    if (zone.low <= entry.mid) continue;
    candidates.push({
      kind: "STRUCTURAL",
      level: zone.low,
      reason: `The near edge of a resistance zone at ${formatPrice(zone.low)} – ${formatPrice(
        zone.high,
      )}, where price has been rejected ${zone.touches} ${
        zone.touches === 1 ? "time" : "times"
      }. Targeting the near edge favours getting filled over the last fraction of the move.`,
    });
  }

  // A prior significant high beyond the known zones — the classic third target.
  const swingHighs = findSwingPoints(candles, swingLookback)
    .filter((s) => s.type === "HIGH")
    .map((s) => s.price)
    .sort((a, b) => b - a);

  const priorHigh = swingHighs[0];
  const priorHighR = priorHigh === undefined ? 0 : (priorHigh - entry.mid) / risk;
  const priorHighUsable =
    priorHigh !== undefined && priorHigh > entry.mid && priorHighR <= MAX_TARGET_R;

  if (priorHighUsable) {
    candidates.push({
      kind: "STRUCTURAL",
      level: priorHigh,
      reason: `The highest prior swing high on this timeframe, at ${formatPrice(priorHigh)}. Beyond it there is no historical reference left to target.`,
    });
  }

  const targets = dedupe(
    candidates.filter((c) => (c.level - entry.mid) / risk <= MAX_TARGET_R),
    risk,
  );

  // Mention a distant historical high rather than silently dropping it.
  const distantHighNote =
    priorHigh !== undefined && !priorHighUsable && priorHighR > MAX_TARGET_R
      ? ` The next historical reference above is far higher at ${formatPrice(priorHigh)} (${priorHighR.toFixed(0)}× the risk), too distant to manage as a target for this trade.`
      : "";

  // Fill any remaining slots with R-multiples, clearly labelled as such.
  while (targets.length < 3) {
    const multiple = FALLBACK_R_MULTIPLES[targets.length];
    const level = entry.mid + risk * multiple;
    if (targets.some((t) => Math.abs(t.level - level) / level < 0.001)) break;
    targets.push({
      kind: "R_MULTIPLE",
      level,
      reason: `No further resistance is visible on this timeframe, so this target is set at ${multiple}× the risk taken rather than at a level price has reacted to before. Treat it as a target of convenience, not of structure.${distantHighNote}`,
    });
  }

  return targets.slice(0, 3).map((target, i) => ({
    label: LABELS[i],
    level: target.level,
    reason: target.reason,
    rr: (target.level - entry.mid) / risk,
    kind: target.kind,
  }));
}

/** Sorts ascending and drops targets too close together to be distinct. */
function dedupe(
  candidates: { level: number; reason: string; kind: TargetKind }[],
  risk: number,
): { level: number; reason: string; kind: TargetKind }[] {
  const sorted = [...candidates].sort((a, b) => a.level - b.level);
  const out: { level: number; reason: string; kind: TargetKind }[] = [];

  for (const candidate of sorted) {
    const last = out[out.length - 1];
    // Targets within half an R of each other are the same target in practice.
    if (last && candidate.level - last.level < risk * 0.5) continue;
    out.push(candidate);
  }

  return out;
}
