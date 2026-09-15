import { PRIMARY_SIGNALS, type ConfirmationSignalType } from "@/lib/analysis/confirmation";

import type {
  ConfirmationAlert,
  ConfirmationObservation,
  ConfirmationWatchPlan,
  ObservedSignal,
  WatchState,
} from "./types";

/**
 * The confirmation watcher.
 *
 * Pure: no clock, no I/O, no randomness. Given what the confirmation engine
 * just said about one tracked setup and what has already been announced about
 * it, this returns a plan. `services/confirmation-alerts.ts` executes the plan.
 *
 * It owns no detector and no threshold. Every signal it reads was produced by
 * `lib/analysis/confirmation`, and `PRESENT` is that engine's own verdict —
 * this file never re-derives whether evidence is sufficient, it only decides
 * whether the reader has been told yet.
 */

/**
 * Every signal type, in the order a reader should see them.
 *
 * Primary signals first because they are the ones that can carry a setup, and
 * volume last because it can only corroborate. Taken from the engine's own
 * `PRIMARY_SIGNALS` rather than restated, so a change there cannot leave this
 * list describing a different vocabulary.
 */
export const EVIDENCE_ORDER: ConfirmationSignalType[] = [...PRIMARY_SIGNALS, "VOLUME_CONFIRMATION"];

/** Canonical order for a set of signal types, so a key cannot depend on arrival order. */
function canonical(types: readonly ConfirmationSignalType[]): ConfirmationSignalType[] {
  const seen = new Set(types);
  return EVIDENCE_ORDER.filter((type) => seen.has(type));
}

/**
 * The stored form of an evidence set: canonical order, joined with `+`.
 *
 * A string rather than a JSON array because it is half of a deduplication key
 * and the whole of a database column, and both want one unambiguous spelling
 * per set. Empty string means nothing has been announced yet.
 */
export function encodeEvidence(types: readonly ConfirmationSignalType[]): string {
  return canonical(types).join("+");
}

/** The inverse. Unrecognised entries are dropped rather than trusted. */
export function decodeEvidence(encoded: string): ConfirmationSignalType[] {
  if (!encoded) return [];

  const known = new Set<string>(EVIDENCE_ORDER);
  return canonical(
    encoded.split("+").filter((part): part is ConfirmationSignalType => known.has(part)),
  );
}

/**
 * The identity of a "confirmation developing" message.
 *
 * Keyed on the setup and the evidence set *after* this announcement. Because
 * the set is a high-water union it only ever grows, so each announcement has a
 * key no earlier one used, and a pass that finds nothing new re-derives a key
 * that is already in the table — which the unique index rejects. That is the
 * second guarantee, independent of the watch state, and it is what makes a
 * crash between writing the row and updating the state self-healing rather than
 * a duplicate message.
 */
export function dedupeKeyForEvidence(
  trackedSetupId: string,
  evidence: readonly ConfirmationSignalType[],
): string {
  return `confirmation-evidence:${trackedSetupId}:${encodeEvidence(evidence)}`;
}

/** The identity of a "confirmation reached" message. One per setup, ever. */
export function dedupeKeyForReached(trackedSetupId: string): string {
  return `confirmation-reached:${trackedSetupId}`;
}

/**
 * Decides what to say about one observation.
 *
 * The order of the rules is the whole design:
 *
 *  1. Refuse outright for anything that is not a live tracked setup being
 *     waited on — invalidated, contradicted, untracked. A setup whose premise
 *     has failed is not a setup with interesting evidence.
 *  2. First sight is a baseline. Record, say nothing.
 *  3. Reaching PRESENT for the first time supersedes everything else this pass:
 *     one message, not two, when the evidence that completes the set is also
 *     new.
 *  4. Otherwise, speak only for evidence never announced for this setup.
 *
 * Rule 4 is stated on the *union*, not on set equality, and that is what makes
 * shrink and regrowth silent: an evidence set that loses a signal and later
 * regains it contains nothing the reader has not already been told.
 */
export function planConfirmationWatch(input: {
  observation: ConfirmationObservation;
  existing: WatchState | null;
}): ConfirmationWatchPlan {
  const { observation, existing } = input;

  // --- 1. nothing to watch -------------------------------------------------
  if (observation.lifecycleStatus === null) {
    return { action: "NONE", reason: "No setup is being tracked for this market." };
  }

  if (observation.lifecycleStatus === "INVALIDATED") {
    return {
      action: "NONE",
      reason:
        "The setup is invalidated. Its premise has failed, and the main bot has already said so.",
    };
  }

  if (observation.status === "CONTRADICTED") {
    return {
      action: "NONE",
      reason:
        "Confirmation is contradicted — the market answered at this level in the wrong " +
        "direction. That is an invalidation, which the lifecycle reports on its own channel.",
    };
  }

  const positives = observation.signals.filter((s) => s.signal === "positive");
  const positiveTypes = positives.map((s) => s.type);

  // --- 2. first sight ------------------------------------------------------
  if (existing === null) {
    return {
      action: "BASELINE",
      state: {
        // Whatever is already true is recorded as known. This is the rule that
        // stops arming the watcher over long-open setups from announcing a
        // week of accumulated evidence in one burst.
        announcedEvidence: canonical(positiveTypes),
        reachedAnnounced: observation.status === "PRESENT",
      },
      evaluatedAt: observation.evaluatedAt,
      reason:
        positives.length > 0
          ? "First observation of this setup. Existing evidence recorded as already known."
          : "First observation of this setup. Nothing at the level yet.",
    };
  }

  const known = new Set(existing.announcedEvidence);
  const newEvidence = positives.filter((s) => !known.has(s.type));
  const knownEvidence = positives.filter((s) => known.has(s.type));

  // The union, which only ever grows. Shrinking it would make a lapse followed
  // by a return look like news.
  const union = canonical([...existing.announcedEvidence, ...positiveTypes]);

  const reached = observation.status === "PRESENT" && !existing.reachedAnnounced;

  // Once "confirmation reached" has been sent, this setup has been announced at
  // the highest level the watcher has. Further evidence piling up does not
  // change the engine's verdict, and the next thing genuinely worth hearing —
  // promotion to a potential setup, or invalidation — is a lifecycle event the
  // main bot already carries. So the watcher goes quiet rather than narrating.
  const silencedByReached = existing.reachedAnnounced;

  if (!reached && (silencedByReached || newEvidence.length === 0)) {
    return {
      action: "OBSERVE",
      state: { announcedEvidence: union, reachedAnnounced: existing.reachedAnnounced },
      evaluatedAt: observation.evaluatedAt,
      reason: silencedByReached
        ? "Confirmation has already been reported as reached for this setup."
        : positives.length === 0
          ? "No positive evidence at this level."
          : "Every piece of evidence here has already been announced for this setup.",
    };
  }

  const missingEvidence = EVIDENCE_ORDER.filter((type) => !positives.some((s) => s.type === type));

  // Negative *supporting* signals only. A negative primary signal makes the
  // engine return CONTRADICTED, which was refused above — so anything reaching
  // here is missing corroboration, never opposing evidence, and the wording
  // has to keep that distinction.
  const caveats = observation.signals.filter(
    (s) => s.signal === "negative" && !PRIMARY_SIGNALS.includes(s.type),
  );

  const base = {
    trackedSetupId: observation.trackedSetupId,
    userId: observation.userId,
    symbol: observation.symbol,
    timeframe: observation.timeframe,
    evaluatedAt: observation.evaluatedAt,
    newEvidence,
    knownEvidence,
    missingEvidence,
    caveats,
    lifecycleStatus: observation.lifecycleStatus,
    confirmationStatus: observation.status,
  };

  // --- 3. reached supersedes developing ------------------------------------
  //
  // One message per pass per setup. The candle that completes the set is
  // usually also the candle that adds the last piece of evidence, and sending
  // "evidence developing" immediately followed by "confirmation reached" would
  // be two notifications about one event.
  const alerts: ConfirmationAlert[] = reached
    ? [
        {
          ...base,
          level: "REACHED",
          dedupeKey: dedupeKeyForReached(observation.trackedSetupId),
        },
      ]
    : [
        {
          ...base,
          level: "DEVELOPING",
          dedupeKey: dedupeKeyForEvidence(observation.trackedSetupId, union),
        },
      ];

  return {
    action: "ANNOUNCE",
    alerts,
    state: { announcedEvidence: union, reachedAnnounced: existing.reachedAnnounced || reached },
    evaluatedAt: observation.evaluatedAt,
  };
}
