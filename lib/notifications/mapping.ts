import type { SetupLifecycleStatus } from "@/lib/setups";

import type { NotificationEventType } from "./types";

/**
 * Turning what the lifecycle recorded into what is worth saying.
 *
 * A mapping, deliberately, and not a second state machine. Phase D decides
 * whether a setup moved and Phase C decides what the market did; this file only
 * decides which of those facts is worth a notification. If the two ever
 * disagree, the lifecycle is right.
 */

/**
 * Signal types that describe an actual change in structure.
 *
 * Taken from the confirmation engine rather than re-derived. `STRUCTURE_BREAK`
 * is a close beyond a confirmed swing; `RECLAIM` is a support zone lost or
 * taken back. Those are the "meaningful support loss" and "resistance break"
 * cases — already computed, already deterministic, already frozen onto the
 * lifecycle event that carried them.
 */
const STRUCTURAL_SIGNAL_TYPES = new Set(["STRUCTURE_BREAK", "RECLAIM"]);

export interface TransitionFacts {
  /** The state the setup arrived at. Null for a market that failed outright. */
  lifecycleStatus: SetupLifecycleStatus | null;
  /** Confirmation signals frozen onto this transition by Phase D. */
  confirmationSignals: { type: string; signal: string }[];
}

/**
 * Whether this transition changed structure, as opposed to merely changing state.
 *
 * The distinction matters more than it looks. `SETUP_FORMING →
 * WAITING_CONFIRMATION` means price arrived at a level that was already
 * identified — nothing about the market's structure changed, and announcing it
 * would be announcing that a chart is still a chart. A structural change is a
 * level actually breaking or being reclaimed, and the confirmation engine
 * already says which of those happened.
 */
export function isStructuralChange(facts: TransitionFacts): boolean {
  return facts.confirmationSignals.some((signal) => STRUCTURAL_SIGNAL_TYPES.has(signal.type));
}

/**
 * The notification event for one lifecycle transition, or null for silence.
 *
 * Ordered by what the reader most needs to know:
 *
 *  - INVALIDATED first: the premise failed, and that outranks everything else
 *    that might also be true on the same candle.
 *  - POTENTIAL_SETUP: every deterministic condition now holds. This is the
 *    highest state the engine offers, and it is still not an instruction.
 *  - CONFIRMATION_DETECTED: the market acted at the level, while some other
 *    rule still holds the analysis back.
 *  - Anything else only speaks if structure actually moved. Most transitions
 *    are price arriving somewhere, and those are silent.
 */
export function eventTypeForTransition(facts: TransitionFacts): NotificationEventType | null {
  switch (facts.lifecycleStatus) {
    case "INVALIDATED":
      return "SETUP_INVALIDATED";

    case "POTENTIAL_SETUP":
      return "SETUP_DETECTED";

    case "CONFIRMATION_DETECTED":
      return "CONFIRMATION_DETECTED";

    case "SETUP_FORMING":
    case "WAITING_CONFIRMATION":
      return isStructuralChange(facts) ? "STRUCTURE_CHANGED" : null;

    default:
      return null;
  }
}

/**
 * The identity of a notification.
 *
 * For a setup event this is Phase D's `SetupEvent.id` — one row per lifecycle
 * transition, already written, already unique. Deriving identity from it rather
 * than from the setup's current state means a setup that leaves a state and
 * returns to it later is correctly treated as a new thing to say, while a
 * scanner re-observing an unchanged setup produces the identical key and is
 * silently dropped by the unique index.
 */
export function dedupeKeyForSetupEvent(setupEventId: string): string {
  return `setup-event:${setupEventId}`;
}

/**
 * System errors are bucketed by the hour.
 *
 * A market that is failing is usually failing on every pass, and a key per
 * occurrence would mean one message per scan for as long as it lasts. Per hour
 * says the same thing once.
 */
export function dedupeKeyForSystemError(input: {
  category: string;
  symbol: string | null;
  at: number;
}): string {
  const hour = new Date(input.at).toISOString().slice(0, 13);
  return `system-error:${input.category}:${input.symbol ?? "global"}:${hour}`;
}

/** One summary per UTC day, however many times the job runs. */
export function dedupeKeyForDailySummary(date: string): string {
  return `daily-summary:${date}`;
}

// --- channel routing -------------------------------------------------------

/**
 * How much a given event is worth interrupting someone's phone for.
 *
 * Distinct from `EVENT_PRIORITY`, which grades an event *type* and is what the
 * in-app list shows. This grades an *event*, using the facts already on it, and
 * it is a routing decision rather than metadata: LOW never reaches Telegram.
 *
 * The in-app channel is unaffected — it keeps receiving everything the user
 * subscribed to, and the database keeps receiving everything full stop. This
 * decides delivery, never recording.
 *
 * Nothing here re-derives strategy. Every input is a fact the lifecycle or the
 * snapshot already established: whether the engine re-anchored, whether the
 * setup ever confirmed, what the engine's own verdict was, and whether the
 * reward was measurable at all.
 */
export type TelegramPriority = "HIGH" | "MEDIUM" | "LOW";

/** Facts the routing rules read. A subset of `NotificationEvent`, so the rules stay testable. */
export interface RoutingFacts {
  type: NotificationEventType;
  setup: {
    analysisStatus: string;
    riskRewardIsSynthetic: boolean;
    isReplacement: boolean;
    everConfirmed: boolean;
  } | null;
}

export function telegramPriorityFor(event: RoutingFacts): TelegramPriority {
  switch (event.type) {
    // Every deterministic condition holds. The rarest thing the engine says,
    // and the only one worth a push on its own.
    case "SETUP_DETECTED":
      return "HIGH";

    case "CONFIRMATION_DETECTED": {
      const setup = event.setup;
      if (!setup) return "LOW";

      // Confirmation on a setup the engine itself calls high risk is a notice,
      // not an alert — nine of the seventeen confirmations ever sent were
      // exactly this, and the levels were printed above the disqualifier.
      if (setup.analysisStatus === "HIGH_RISK") return "LOW";

      // An unmeasured reward means no structural target sits far enough above
      // the entry. Confirming into that is not something to be woken for.
      if (setup.riskRewardIsSynthetic) return "LOW";

      return "HIGH";
    }

    case "SETUP_INVALIDATED": {
      const setup = event.setup;
      if (!setup) return "MEDIUM";

      // The engine re-anchored to an adjacent zone and created a replacement in
      // the same pass. Nothing failed; the bookkeeping moved. Recorded and
      // shown in-app, never pushed.
      if (setup.isReplacement) return "LOW";

      // A level that had actually confirmed is one the reader was waiting on.
      return setup.everConfirmed ? "HIGH" : "MEDIUM";
    }

    // Always in-app. It cannot carry bad news — a negative structural signal is
    // a primary signal, so it contradicts confirmation and arrives as an
    // invalidation instead — and it has fired on setups being seen for the
    // first time, where nothing changed at all.
    case "STRUCTURE_CHANGED":
      return "LOW";

    case "DAILY_SUMMARY":
      return "MEDIUM";

    case "SYSTEM_ERROR":
      return "HIGH";
  }
}

/** Whether this event should be pushed to Telegram at all. */
export function isTelegramWorthy(event: RoutingFacts): boolean {
  return telegramPriorityFor(event) !== "LOW";
}
