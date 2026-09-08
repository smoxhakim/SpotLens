import { formatPrice } from "@/lib/format";

import type { PriceZone, ZoneRead } from "../zones";

/** Describes one zone and the evidence behind it. */
export function explainZone(zone: PriceZone, price: number): string {
  const side = zone.kind === "SUPPORT" ? "below" : "above";
  const role = zone.kind === "SUPPORT" ? "buyers have stepped in" : "sellers have stepped in";

  const parts = [
    `${formatPrice(zone.low)} – ${formatPrice(zone.high)}, ${side} the current price of ${formatPrice(price)}.`,
    zone.touches === 1
      ? "Price has reacted here once, so treat it as provisional."
      : `Price has reacted here ${zone.touches} times, which is where ${role}.`,
  ];

  if (zone.flipped) {
    parts.push(
      "This level has acted as both support and resistance, which makes it more significant than one only ever tested from a single side.",
    );
  }

  return parts.join(" ");
}

export function explainZones(read: ZoneRead): string {
  if (read.support.length === 0 && read.resistance.length === 0) {
    return "No clear support or resistance zones stand out on this timeframe — price has not reacted repeatedly at any particular level.";
  }

  const lines: string[] = [];

  if (read.support.length > 0) {
    lines.push(
      `Nearest support: ${formatPrice(read.support[0].low)} – ${formatPrice(read.support[0].high)}.`,
    );
  } else {
    lines.push("No support zone has formed below the current price on this timeframe.");
  }

  if (read.resistance.length > 0) {
    lines.push(
      `Nearest resistance: ${formatPrice(read.resistance[0].low)} – ${formatPrice(read.resistance[0].high)}.`,
    );
  } else {
    lines.push("No resistance zone has formed above the current price on this timeframe.");
  }

  return lines.join(" ");
}

/** Why zone widths are what they are — asked often enough to answer up front. */
export function explainZoneWidth(read: ZoneRead): string {
  if (read.atr === null) {
    return "Zone widths scale with recent volatility.";
  }
  return `Zones are sized from recent volatility (average true range ${formatPrice(read.atr)}), not a fixed percentage, so they widen when the market does. Support and resistance are areas, not exact prices.`;
}
