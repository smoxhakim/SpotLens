import { formatPrice } from "@/lib/format";
import type { Candle } from "@/lib/market-data/provider";

import type { MarketRead } from "../market-read";
import { findSwingPoints } from "../structure";
import type { EntryZone, StopLoss } from "./types";

/** Breathing room below the invalidation level, so noise does not stop you out. */
export const STOP_BUFFER_ATR = 0.5;

/** Beyond this, the stop is so wide the position size becomes impractical. */
export const MAX_SENSIBLE_RISK_PCT = 0.15;

/**
 * Structure-based stop loss.
 *
 * The stop is not a fixed percentage — it sits below the level that would prove
 * the trade idea wrong. If price closes below the support zone and the swing low
 * beneath it, the reason for being in the trade is gone, so that is where the
 * trade ends.
 */
export function calculateStopLoss(
  read: MarketRead,
  entry: EntryZone,
  candles: Candle[],
  swingLookback = 2,
): StopLoss | null {
  const atr = read.indicators.atr14;
  if (!atr || atr <= 0) return null;

  const swings = findSwingPoints(candles, swingLookback);
  const lowsBelowEntry = swings
    .filter((s) => s.type === "LOW" && s.price < entry.high)
    .sort((a, b) => b.index - a.index);

  const latestSwingLow = lowsBelowEntry[0]?.price ?? null;

  // Invalidation is the lower of the two: the zone floor and the most recent
  // swing low beneath it. Whichever is lower is what has to break.
  const structuralLevel = latestSwingLow === null ? entry.low : Math.min(entry.low, latestSwingLow);

  const buffer = atr * STOP_BUFFER_ATR;
  const price = structuralLevel - buffer;

  if (price <= 0 || price >= entry.mid) return null;

  const riskPct = (entry.mid - price) / entry.mid;

  const reasons: string[] = [];
  if (latestSwingLow !== null && latestSwingLow < entry.low) {
    reasons.push(
      `Placed below the most recent swing low at ${formatPrice(latestSwingLow)}, which sits under the support zone.`,
    );
  } else {
    reasons.push(`Placed below the support zone floor at ${formatPrice(entry.low)}.`);
  }

  reasons.push(
    `A further ${STOP_BUFFER_ATR} ATR (${formatPrice(buffer)}) is added underneath so ordinary volatility does not close the trade.`,
  );
  reasons.push(
    "If price trades below this level, the support that justified the entry has failed and the idea is invalid.",
  );

  if (riskPct > MAX_SENSIBLE_RISK_PCT) {
    reasons.push(
      `Note: this stop is ${(riskPct * 100).toFixed(1)}% below the entry, which is unusually wide — size the position down accordingly.`,
    );
  }

  return {
    price,
    reason: reasons.join(" "),
    riskPct,
    atrMultiple: (entry.mid - price) / atr,
  };
}
