/**
 * The confirmation watcher.
 *
 * Follows each tracked setup independently while it waits, and says something
 * only when the deterministic confirmation engine reports evidence that has not
 * been reported for *that setup* before. It owns no detector, no threshold and
 * no number: `lib/analysis/confirmation` decides what the market did, the
 * immutable setup snapshot supplies every level, and this decides whether the
 * reader has already been told.
 *
 * Pure throughout. `services/confirmation-alerts.ts` performs the writes and
 * the delivery, and is the only path to the confirmation bot.
 */
export {
  EVIDENCE_ORDER,
  dedupeKeyForEvidence,
  dedupeKeyForReached,
  decodeEvidence,
  encodeEvidence,
  planConfirmationWatch,
} from "./watch";

export {
  CONFIRMATION_TITLES,
  formatConfirmationAlert,
  formatConfirmationConnectionTest,
  formatDeveloping,
  formatReached,
  renderConfirmationInApp,
  type SetupNumbers,
} from "./format";

export type {
  ConfirmationAlert,
  ConfirmationAlertLevel,
  ConfirmationObservation,
  ConfirmationWatchPlan,
  ObservedSignal,
  WatchState,
} from "./types";
