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
 *
 * A target has to sit above the whole entry zone, not just its middle: zones
 * are widened to a minimum width, so a resistance edge can land inside the
 * upper half of the zone being bought, and a "target" there is a price the
 * entry itself spans.
 *
 * The ladder is ascending by construction. Structural targets are sorted; an
 * R-multiple only fills a slot *above* the last target already on the ladder
 * (see the fill loop), and when no multiple in the ladder clears it the ladder
 * stops short rather than listing a lower target after a higher one.
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
    if (zone.low <= entry.high) continue;
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
    priorHigh !== undefined && priorHigh > entry.high && priorHighR <= MAX_TARGET_R;

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
  //
  // Each slot takes its own multiple — or, when that would land at or below
  // the last target already on the ladder, the next larger one that does not.
  // Taking the slot's multiple unconditionally once put a 4R TP3 under a
  // structural TP2 at 5.7R (LTC/USDT 1h): a ladder that read downwards, with a
  // "no further resistance" reason sitting below the resistance it had just
  // listed. When no multiple clears the last target, the slot stays empty:
  // fewer targets is honest, and reordering would change what TP2 means.
  let index = targets.length;
  while (targets.length < 3 && index < FALLBACK_R_MULTIPLES.length) {
    const multiple = FALLBACK_R_MULTIPLES[index];
    index += 1;
    const level = entry.mid + risk * multiple;
    // The duplicate test first, as it always ran: a multiple that lands on a
    // target already listed ends the ladder, exactly as before.
    if (targets.some((t) => Math.abs(t.level - level) / level < 0.001)) break;
    const last = targets.at(-1);
    if (last && level <= last.level) continue;
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
