import type { Timeframe } from "@/lib/market-data/provider";

/**
 * Where a price sits relative to an entry zone.
 *
 * Three values rather than a boolean, so "outside" keeps its side in logs and
 * tests. A gap-through — ABOVE then BELOW — crossed the zone without ever being
 * seen in it, and that is not the transition this layer reports.
 */
export type ZonePosition = "BELOW" | "INSIDE" | "ABOVE";

/**
 * One open tracked setup, as the monitor needs to see it.
 *
 * The zone is the setup's own immutable snapshot, converted once on load. The
 * monitor compares against it and never computes one of its own.
 */
export interface WatchedSetup {
  setupId: string;
  /** The owner. Every alert for this setup goes to this account and no other. */
  userId: string;
  /** Exchange symbol, e.g. "BTCUSDT" — the key prices are matched on. */
  symbol: string;
  timeframe: Timeframe;
  entryLow: number;
  entryHigh: number;
  /**
   * Whether the setup's `CREATED` event put it at SETUP_FORMING.
   *
   * The lifecycle returns SETUP_FORMING exactly when the creating closed
   * candle's price was outside the zone (`lifecycleStatusFor`), so this is
   * proof the setup began outside — which arms it without the monitor having
   * to have seen it. Any other creation state proves nothing either way.
   */
  createdOutside: boolean;
}

/**
 * What the monitor knows about one setup between observations.
 *
 * Two flags, and both are durable — `SetupEntryZoneWatch` and the setup's
 * creation event are their record — which is why a restart cannot change what
 * the next observation may say. No "last position" is kept: an armed setup
 * alerts on its first reading inside, so armed-and-unreached already means the
 * last reading was outside.
 */
export interface WatchMemory {
  /** Seen outside the zone (or created outside it): entering it would be news. */
  armed: boolean;
  /** The one alert this setup is allowed has been raised. Never cleared. */
  reached: boolean;
}

/** The durable part, as stored. Null when the monitor has written nothing yet. */
export interface StoredWatch {
  armedAt: number | null;
  reachedAt: number | null;
}

export interface PriceObservation {
  symbol: string;
  price: number;
  /** Epoch ms, local clock, when the price was received. */
  receivedAt: number;
}

export type SkipReason =
  /** Older than the freshness limit, or from the future: not a reading of now. */
  | "STALE"
  /** Not a finite positive number. Never treated as a price. */
  | "INVALID_PRICE"
  /** A price for a different market. Defensive: grouping should make this impossible. */
  | "WRONG_SYMBOL";

/**
 * What one observation means for one setup.
 *
 * `arm` and `alert` are the only two things that cause a write. Everything
 * else — the position moving from ABOVE to BELOW, re-entering after the alert —
 * changes memory and nothing more.
 */
export type WatchDecision =
  | { kind: "SKIPPED"; reason: SkipReason }
  | {
      kind: "OBSERVED";
      position: ZonePosition;
      next: WatchMemory;
      /** First time seen outside: persist `armedAt`. */
      arm: boolean;
      /** OUTSIDE → INSIDE on an armed setup that has not alerted: raise ENTRY_ZONE_REACHED. */
      alert: boolean;
    };
