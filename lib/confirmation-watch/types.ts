import type { ConfirmationSignalType, ConfirmationStatus } from "@/lib/analysis/confirmation";
import type { Timeframe } from "@/lib/market-data/provider";
import type { SetupLifecycleStatus } from "@/lib/setups";

/**
 * The confirmation watcher's vocabulary.
 *
 * Deliberately its own domain rather than a variant of `NotificationEvent`.
 * The main notification path answers "what happened to this setup's
 * lifecycle?"; this answers "what has the confirmation engine seen at this
 * level since we started watching it?" — a different question, on a different
 * cadence, delivered to a different bot. Keeping the two types apart is what
 * makes it impossible to hand one of these to `deliverEvents` and have it reach
 * the main bot.
 *
 * Nothing here computes. Every signal, status and number originates in
 * `lib/analysis/confirmation` or in the immutable setup snapshot.
 */

/**
 * One reading of one tracked setup, as the scanner saw it on one pass.
 *
 * Built in `services/scanner.ts` from the `AnalysisResult` the engine just
 * produced, against candles that have all closed. There is no path by which a
 * forming candle reaches this: the scanner drops it before the engine runs, and
 * `evaluatedAt` is the close time of the candle the engine actually judged.
 */
export interface ConfirmationObservation {
  trackedSetupId: string;
  userId: string;
  symbol: string;
  timeframe: Timeframe;
  /** Where the lifecycle put this setup on this pass. Null when untracked. */
  lifecycleStatus: SetupLifecycleStatus | null;
  status: ConfirmationStatus;
  /** Every signal the engine returned, positive, negative and supporting. */
  signals: ObservedSignal[];
  /** Close time of the judged candle, epoch ms. Always a closed candle. */
  evaluatedAt: number;
}

export interface ObservedSignal {
  type: ConfirmationSignalType;
  signal: "positive" | "negative" | "neutral";
  title: string;
  detail: string;
}

/**
 * What the watcher has already said about one setup.
 *
 * `announcedEvidence` is a high-water union rather than the last set observed.
 * Evidence that lapses and comes back is the same evidence; re-announcing it on
 * every oscillation is the spam this layer exists to prevent.
 */
export interface WatchState {
  announcedEvidence: ConfirmationSignalType[];
  reachedAnnounced: boolean;
}

export type ConfirmationAlertLevel = "DEVELOPING" | "REACHED";

/**
 * One thing worth telling the reader, with the identity that makes it idempotent.
 *
 * `dedupeKey` is anchored on `trackedSetupId`, never on symbol and timeframe: a
 * replacement setup on the same market is a different level with its own
 * history, and must be able to speak for itself without inheriting — or being
 * silenced by — what was said about the one it replaced.
 */
export interface ConfirmationAlert {
  level: ConfirmationAlertLevel;
  trackedSetupId: string;
  userId: string;
  symbol: string;
  timeframe: Timeframe;
  dedupeKey: string;
  /** Close time of the candle this was judged on, epoch ms. */
  evaluatedAt: number;
  /** Positive signals never announced for this setup before. */
  newEvidence: ObservedSignal[];
  /** Positive signals that were already known. Context, not news. */
  knownEvidence: ObservedSignal[];
  /** Signal types the engine did not report positive. Shown as "not yet". */
  missingEvidence: ConfirmationSignalType[];
  /** Negative supporting signals — an absence of corroboration, not a refutation. */
  caveats: ObservedSignal[];
  lifecycleStatus: SetupLifecycleStatus;
  confirmationStatus: ConfirmationStatus;
}

/**
 * What the watcher decided about one observation.
 *
 * A plan rather than a write, the same shape `lib/setups` uses and for the same
 * reason: every rule is a pure function of (stored state, observation) and can
 * be tested without a database. `services/confirmation-alerts.ts` executes it.
 *
 * `BASELINE` is the first sight of a setup. It records whatever is already true
 * and says nothing — arming the watcher over setups that have been open for
 * days must not produce a burst of messages about evidence the reader never
 * asked to hear about.
 */
export type ConfirmationWatchPlan =
  | { action: "NONE"; reason: string }
  | { action: "BASELINE"; state: WatchState; evaluatedAt: number; reason: string }
  | { action: "ANNOUNCE"; alerts: ConfirmationAlert[]; state: WatchState; evaluatedAt: number }
  | { action: "OBSERVE"; state: WatchState; evaluatedAt: number; reason: string };
