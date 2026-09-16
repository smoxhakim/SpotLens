import type { AnalysisResult } from "@/lib/analysis";
import { formatPrice } from "@/lib/format";

import type { SetupLevel } from "./CandlestickChart";

/**
 * The setup's levels, as the chart should draw them.
 *
 * One function rather than a copy in each workspace: the embedded chart and
 * the full-page one must draw the same lines with the same labels, and two
 * copies of this is how one of them ends up a target behind.
 *
 * Nothing is computed. Every price is the engine's own float, passed through
 * untouched — `formatPrice` appears only in the label text.
 *
 * ## Why the entry is titled once
 *
 * The entry is a zone, and its two edges were each drawn titled "Entry", which
 * reads as two unrelated lines that happen to share a name. Titling the upper
 * edge "Entry zone" with its full range and leaving the lower edge's title
 * empty is the convention this chart already uses for support and resistance
 * bands — both edges keep their own axis price, because both are real levels,
 * but they read as one thing.
 */
export function setupLevelsFor(setup: AnalysisResult["setup"]): SetupLevel[] {
  if (!setup) return [];

  const isZone = setup.entry.high !== setup.entry.low;

  return [
    {
      price: setup.entry.high,
      label: isZone
        ? `Entry ${formatPrice(setup.entry.low)} – ${formatPrice(setup.entry.high)}`
        : "Entry",
      kind: "entry",
    },
    // The lower edge carries the price on the axis and no title of its own.
    ...(isZone ? [{ price: setup.entry.low, label: "", kind: "entry" as const }] : []),
    { price: setup.stopLoss.price, label: "Stop", kind: "stop" },
    ...setup.takeProfits.map((target) => ({
      price: target.level,
      label: target.label,
      kind: "target" as const,
    })),
  ];
}
