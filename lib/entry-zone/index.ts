/**
 * Live entry-zone monitoring — the pure part.
 *
 * Reports one thing: the live price moved from outside a tracked setup's stored
 * entry zone to inside it. Once per setup. It is the only notification not
 * derived from a closed candle, and it is deliberately narrow because of that:
 * it changes no lifecycle state, triggers no confirmation check, creates no
 * decision and touches no setup number. Price arriving at a level is when to
 * start reading the setup, not evidence about it.
 *
 * `services/entry-zone-monitor.ts` performs the reads and writes;
 * `scripts/entry-zone-monitor.ts` is the process (`npm run monitor`).
 */
export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  STALE_PRICE_MS,
  groupBySymbol,
  initialMemory,
  mergeMemory,
  planEntryZoneWatch,
  zonePosition,
} from "./watch";

export { entryZoneEvent } from "./event";

export type {
  PriceObservation,
  SkipReason,
  StoredWatch,
  WatchDecision,
  WatchMemory,
  WatchedSetup,
  ZonePosition,
} from "./types";
