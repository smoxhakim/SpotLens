import { computeOutcome } from "./decide";
import type { TradeExitReason } from "./types";

/**
 * Preserving what a correction replaced.
 *
 * `JournalEntry` holds the latest numbers, which is what every reader wants:
 * the trade as the user now says it happened. But a person correcting a
 * mistyped fill and a person quietly rewriting a losing trade type the same
 * keys, and only one of those should be possible. So before the entry is
 * updated, the values being replaced are written onto the event that replaces
 * them — in full, and structured, not summarised into a sentence.
 *
 * That keeps one row per entry (no second history table, no shadow copy to
 * keep in step) while making every previous version recoverable from the
 * append-only event log, in order.
 *
 * Pure: no clock, no I/O. The service supplies the moment.
 */

/** The ten trade fields, exactly as `JournalEntry` stores them. */
export interface SupersededOutcome {
  actualEntry: number | null;
  actualStopLoss: number | null;
  actualTakeProfit: number | null;
  actualExit: number | null;
  quantity: number | null;
  fees: number | null;
  slippage: number | null;
  exitReason: TradeExitReason | null;
  /** Epoch ms, so the payload stays a plain JSON value. */
  openedAt: number | null;
  closedAt: number | null;
  /**
   * What this version reported at the time.
   *
   * Derived from the fields above, and stored anyway: the record is of what
   * the user was shown, and recomputing it later would silently restate
   * history if the formula ever moved.
   */
  realizedR: number | null;
  /** When it was replaced, epoch ms. */
  supersededAt: number;
}

/** The payload written onto an amending `OUTCOME_RECORDED` event. */
export interface AmendmentPayload {
  supersededOutcome: SupersededOutcome;
}

/** The trade fields as they come off a `JournalEntry` row, already numeric. */
export interface StoredOutcome {
  actualEntry: number | null;
  actualStopLoss: number | null;
  actualTakeProfit: number | null;
  actualExit: number | null;
  quantity: number | null;
  fees: number | null;
  slippage: number | null;
  exitReason: TradeExitReason | null;
  openedAt: number | null;
  closedAt: number | null;
}

/**
 * Whether an entry already holds a recorded trade.
 *
 * The entry and the size are what every other reader treats as "there is a
 * trade here", so the same test decides whether a write supersedes anything.
 */
export function hasRecordedOutcome(stored: StoredOutcome): boolean {
  return stored.actualEntry !== null && stored.quantity !== null;
}

/**
 * The payload for a write that replaces an existing recording, or null when
 * there was nothing there to replace.
 */
export function buildAmendmentPayload(
  stored: StoredOutcome,
  supersededAt: number,
): AmendmentPayload | null {
  if (!hasRecordedOutcome(stored)) return null;

  const outcome = computeOutcome({
    actualEntry: stored.actualEntry!,
    actualStopLoss: stored.actualStopLoss ?? undefined,
    actualExit: stored.actualExit ?? undefined,
    quantity: stored.quantity!,
    fees: stored.fees ?? undefined,
    slippage: stored.slippage ?? undefined,
  });

  return {
    supersededOutcome: {
      actualEntry: stored.actualEntry,
      actualStopLoss: stored.actualStopLoss,
      actualTakeProfit: stored.actualTakeProfit,
      actualExit: stored.actualExit,
      quantity: stored.quantity,
      fees: stored.fees,
      slippage: stored.slippage,
      exitReason: stored.exitReason,
      openedAt: stored.openedAt,
      closedAt: stored.closedAt,
      realizedR: outcome.realizedR,
      supersededAt,
    },
  };
}

/**
 * Reads a superseded version back out of an event payload.
 *
 * Returns null for anything that is not one — a first recording, a decision
 * change, or an event written before the column existed. Older rows stay
 * valid; they simply have no previous version to offer.
 */
export function readAmendmentPayload(payload: unknown): SupersededOutcome | null {
  if (payload === null || typeof payload !== "object") return null;

  const candidate = (payload as { supersededOutcome?: unknown }).supersededOutcome;
  if (candidate === null || typeof candidate !== "object") return null;

  const outcome = candidate as Partial<SupersededOutcome>;
  // The two fields that make a recording a recording. Without them the payload
  // is not one, whatever else it contains.
  if (typeof outcome.actualEntry !== "number" || typeof outcome.quantity !== "number") return null;

  return outcome as SupersededOutcome;
}

/**
 * Every superseded version an entry's events carry, oldest first.
 *
 * The events are already append-only and already ordered, so this is a read
 * over them rather than a second source of truth. Combined with the entry's
 * current values it gives the full sequence: version 1, version 2, … and then
 * whatever the entry says now.
 */
export function supersededVersions(
  events: { payload: unknown; createdAt: number }[],
): SupersededOutcome[] {
  return events
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((event) => readAmendmentPayload(event.payload))
    .filter((version): version is SupersededOutcome => version !== null);
}
