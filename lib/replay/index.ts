/**
 * Replay: what was knowable at a moment.
 *
 * Pure and cutoff-driven. Reads persisted candles only — never the network —
 * so a replay is reproducible and offline, and coverage gaps are reported
 * rather than filled.
 */
export {
  candlesUpTo,
  coverageFor,
  eventsUpTo,
  markersUpTo,
  type ReplayCoverage,
  type ReplayMarker,
} from "./cutoff";
