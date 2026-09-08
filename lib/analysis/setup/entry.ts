import type { Candle } from "@/lib/market-data/provider";

import { formatPrice } from "@/lib/format";

import type { MarketRead } from "../market-read";
import { isInZone } from "../zones";
import type { EntryZone } from "./types";

/**
 * How far above the entry zone price can sit before the setup is "extended" —
 * i.e. entering here means buying into the move rather than at the level.
 */
export const EXTENDED_ATR_MULTIPLE = 2.5;

/**
 * The entry zone is a support zone, not the current price.
 *
 * This is the deliberate difference from a signal service: the tool does not
 * say "buy now", it says "here is where this trade makes sense, and here is
 * what you should see before taking it". If price is nowhere near that level,
 * the honest answer is to wait, and the status engine says so.
 */
export function calculateEntryZone(read: MarketRead, candles: Candle[]): EntryZone | null {
  const zone = read.support[0];
  if (!zone) return null;

  const atr = read.indicators.atr14;
  if (!atr || atr <= 0) return null;

  const price = read.price;
  const priceInZone = isInZone(price, zone);
  const distanceAtr = (price - zone.high) / atr;

  const reasons = [
    `This is the nearest support zone below price, tested ${zone.touches} ${
      zone.touches === 1 ? "time" : "times"
    }.`,
  ];

  if (zone.flipped) {
    reasons.push(
      "The level has acted as both resistance and support, so a retest from above is a recognised entry area.",
    );
  }

  if (read.trend.trend === "BULLISH") {
    reasons.push("The wider trend is bullish, so buying a pullback into support trades with it.");
  } else if (read.trend.trend === "SIDEWAYS") {
    reasons.push(
      "The market is ranging, so this is the lower boundary of the range rather than a trend pullback.",
    );
  }

  if (priceInZone) {
    reasons.push(`Price is inside the zone now, at ${formatPrice(price)}.`);
  } else if (distanceAtr > EXTENDED_ATR_MULTIPLE) {
    reasons.push(
      `Price is currently ${distanceAtr.toFixed(1)} ATR above the zone, so entering here would mean chasing the move rather than buying the level.`,
    );
  }

  return {
    low: zone.low,
    high: zone.high,
    mid: zone.mid,
    reason: reasons.join(" "),
    confirmations: buildConfirmations(read, candles),
    priceInZone,
    distanceAtr,
    sourceZone: zone,
  };
}

/**
 * What to see before entering. These are observations the user makes on the
 * chart, not conditions the app evaluates for them — the point is to teach the
 * habit of waiting for confirmation instead of entering on a level alone.
 */
function buildConfirmations(read: MarketRead, candles: Candle[]): string[] {
  const items = [
    "A bullish rejection candle from the zone — a long lower wick showing buyers defending it",
    "A strong bullish close back above the zone, rather than a close inside or below it",
    "Volume rising on the bounce, not on the drop into the zone",
    "A higher low forming after the touch, confirming structure is intact",
  ];

  if (read.trend.trend === "SIDEWAYS") {
    items.push(
      "Because the market is ranging, treat a decisive close below the zone as invalidation rather than a better price",
    );
  }

  const last = candles.at(-1);
  if (last && read.volume.read && read.volume.read.relative < 0.8) {
    items.push(
      "Current volume is below average, so any move from here is weakly confirmed until participation picks up",
    );
  }

  return items;
}
