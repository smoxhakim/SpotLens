import { isClosedSetup } from "@/lib/setups/labels";

import type { JournalDecision, JournalError } from "./types";

/**
 * What a decision may say about a setup that has closed.
 *
 * A closed setup — invalidated, or replaced by a new setup on a different
 * level — is a record, not an opportunity. So:
 *
 *  - Watching it is refused. There is nothing left to watch.
 *  - Skipping it stays possible. Passing on one is worth recording.
 *  - Taking it is refused as a new entry. A closed setup is not permission to
 *    enter a trade. The one exception is a trade the user had *already* entered
 *    while the setup was open and is only now writing down; leaving that
 *    unrecordable would quietly drop it from the journal, and the trades most
 *    likely to land here are the ones whose stop was hit — a journal that lost
 *    them would remember only the winners.
 *
 * SpotLens has no order path, so it cannot know when a trade happened. The late
 * entry is therefore the user's own statement, and it is held to what can be
 * checked: an explicit acknowledgement, and an entry time inside the window the
 * setup was actually open — from when SpotLens first saw it to when it closed.
 * A time outside that window, or a window SpotLens cannot establish, is refused
 * rather than guessed. The statement is stored as self-reported and never
 * becomes `decidedAt` or `openedAt`.
 *
 * Pure: the window comes from the setup row and the clock from nowhere. The
 * service and the interface both call `checkSetupDecision`, so a button cannot
 * offer what the server would refuse.
 */

/** How a closed setup treats a decision. */
export type ClosedSetupMove = "ALLOWED" | "REFUSED" | "LATE_ENTRY";

export function closedSetupMove(to: JournalDecision): ClosedSetupMove {
  if (to === "WATCHING") return "REFUSED";
  if (to === "TAKEN") return "LATE_ENTRY";
  return "ALLOWED";
}

/** What the user sends to record a trade entered before the setup closed. */
export interface LateEntryClaim {
  /** "This setup is now closed, and I entered this trade earlier, while it was open." */
  acknowledged: boolean;
  /** When the user says they entered, epoch ms. Self-reported. */
  enteredAt: number;
}

/** The setup a decision is about, as SpotLens recorded it. */
export interface DecisionSetup {
  status: string;
  /** When SpotLens first recorded the setup, epoch ms. */
  firstSeenAt: number | null;
  /** When SpotLens recorded it as closed, epoch ms. Null while open. */
  closedAt: number | null;
}

/** What is written onto the event, beside `decisionContext`. */
export interface LateEntryRecord {
  /** Always the user's statement. SpotLens cannot verify when a trade happened. */
  source: "USER_STATED";
  acknowledged: true;
  /** When the user says they entered, epoch ms. Self-reported, not verified. */
  statedEnteredAt: number;
  /** The window the statement was checked against, as SpotLens recorded it. */
  setupFirstSeenAt: number;
  setupClosedAt: number;
}

export const SETUP_CLOSED_MESSAGE =
  "This setup is closed — invalidated or replaced — so there is nothing left to watch. Record it as skipped instead.";

export const LATE_ENTRY_REQUIRED_MESSAGE =
  "This setup is closed. Taken is recorded only for a trade you already entered while it was open: acknowledge that, and state when you entered.";

export const LATE_ENTRY_OUTSIDE_WINDOW_MESSAGE =
  "The stated entry time is outside the window this setup was open — from when SpotLens first saw it to when it closed. A trade entered outside that window was not entered on this setup while it was open.";

const invalid = (message: string): JournalError => ({
  code: "LATE_ENTRY_INVALID",
  field: "lateEntry",
  message,
});

/**
 * Whether a decision may be recorded against this setup. Null when it may.
 *
 * `from` is the decision already on record, or null when the entry is being
 * created. `setup` is null for an opportunity that was never tracked — it has
 * no lifecycle, so it cannot be closed. A move that changes nothing (a note
 * against the same decision) is never refused here.
 */
export function checkSetupDecision(input: {
  setup: DecisionSetup | null;
  from: JournalDecision | null;
  to: JournalDecision;
  lateEntry?: LateEntryClaim | null;
}): JournalError | null {
  const { setup, from, to, lateEntry } = input;
  const changes = from !== to;
  const closed = setup !== null && isClosedSetup(setup.status);

  if (!closed || !changes) {
    if (!lateEntry) return null;
    if (setup === null)
      return invalid("A late entry is only for a tracked setup that has since closed.");
    if (!closed) {
      return invalid(
        "A late entry is only for a setup that has since closed. This one is still open — record the decision as usual.",
      );
    }
    return invalid("A late entry is recorded only when the decision becomes taken.");
  }

  const move = closedSetupMove(to);
  if (move === "REFUSED") {
    return { code: "SETUP_CLOSED", field: "decision", message: SETUP_CLOSED_MESSAGE };
  }
  if (move === "ALLOWED") {
    return lateEntry
      ? invalid("A late entry is recorded only when the decision becomes taken.")
      : null;
  }

  if (!lateEntry || lateEntry.acknowledged !== true) {
    return {
      code: "LATE_ENTRY_REQUIRED",
      field: "lateEntry",
      message: LATE_ENTRY_REQUIRED_MESSAGE,
    };
  }
  if (!isTime(setup.firstSeenAt) || !isTime(setup.closedAt) || setup.closedAt < setup.firstSeenAt) {
    return invalid(
      "SpotLens has no reliable record of when this setup was first seen and when it closed, so a late entry cannot be checked against it. Nothing was recorded.",
    );
  }
  if (!isTime(lateEntry.enteredAt)) {
    return invalid("The stated entry time is not a valid time.");
  }
  if (lateEntry.enteredAt < setup.firstSeenAt || lateEntry.enteredAt > setup.closedAt) {
    return invalid(LATE_ENTRY_OUTSIDE_WINDOW_MESSAGE);
  }

  return null;
}

/**
 * The record of an accepted late entry. Call only after `checkSetupDecision`
 * accepted it; returns null otherwise, so nothing unchecked can be written.
 */
export function lateEntryRecord(
  setup: DecisionSetup,
  claim: LateEntryClaim,
): LateEntryRecord | null {
  if (
    claim.acknowledged !== true ||
    !isTime(claim.enteredAt) ||
    !isTime(setup.firstSeenAt) ||
    !isTime(setup.closedAt) ||
    claim.enteredAt < setup.firstSeenAt ||
    claim.enteredAt > setup.closedAt
  ) {
    return null;
  }
  return {
    source: "USER_STATED",
    acknowledged: true,
    statedEnteredAt: claim.enteredAt,
    setupFirstSeenAt: setup.firstSeenAt,
    setupClosedAt: setup.closedAt,
  };
}

/** The sentence the event's detail carries, so the history says it in words too. */
export function describeLateEntry(record: LateEntryRecord): string {
  return (
    ` Recorded after the setup closed (${new Date(record.setupClosedAt).toISOString()}).` +
    ` The user acknowledged this and stated they entered at ${new Date(record.statedEnteredAt).toISOString()}, while it was open — self-reported, not verified.`
  );
}

/** The payload key, a sibling of `decisionContext` and of the amendment's own key. */
export function buildLateEntryPayload(record: LateEntryRecord): { lateEntry: LateEntryRecord } {
  return { lateEntry: record };
}

/**
 * Reads a late entry back out of an event payload, field by field, so an extra
 * or malformed key cannot survive into what a reader sees. Null for anything
 * else — every event that is not a late entry, and every event written before.
 */
export function readLateEntry(payload: unknown): LateEntryRecord | null {
  if (payload === null || typeof payload !== "object") return null;
  const candidate = (payload as { lateEntry?: unknown }).lateEntry;
  if (candidate === null || typeof candidate !== "object") return null;

  const record = candidate as Partial<LateEntryRecord>;
  if (
    record.source !== "USER_STATED" ||
    record.acknowledged !== true ||
    !isTime(record.statedEnteredAt) ||
    !isTime(record.setupFirstSeenAt) ||
    !isTime(record.setupClosedAt)
  ) {
    return null;
  }
  return {
    source: "USER_STATED",
    acknowledged: true,
    statedEnteredAt: record.statedEnteredAt,
    setupFirstSeenAt: record.setupFirstSeenAt,
    setupClosedAt: record.setupClosedAt,
  };
}

function isTime(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
