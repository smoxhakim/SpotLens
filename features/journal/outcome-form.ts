import { fromLocalInput, toLocalInput } from "@/features/decision/components/LateEntryForm";
import type { TradeExitReason } from "@/lib/journal";

/**
 * The trade form on a journal entry, as a pure mapping between what is stored
 * and what is sent.
 *
 * `POST /api/journal/:id/outcome` replaces the whole trade: a field the request
 * leaves out is stored as null. So the form sends back every field it shows,
 * as the user left it — and the one it does not show, slippage, exactly as it
 * was recorded. A form that sent less would clear what it never displayed.
 *
 * A blank field is left out, and so stays unknown. Nothing is defaulted: not
 * the plan's target, not the clock's time.
 */

/** The trade as `GET /api/journal/:id` returns it. */
export interface RecordedTrade {
  actualEntry: number;
  actualStopLoss: number | null;
  actualTakeProfit: number | null;
  actualExit: number | null;
  quantity: number;
  fees: number | null;
  slippage: number | null;
  exitReason: string | null;
  /** ISO timestamps. */
  openedAt: string | null;
  closedAt: string | null;
}

export const EXIT_REASON_LABELS: Record<TradeExitReason, string> = {
  TAKE_PROFIT: "Take-profit hit",
  STOP_LOSS: "Stop-loss hit",
  MANUAL_EXIT: "Closed manually",
  INVALIDATED: "Setup invalidated",
  OTHER: "Other",
};

/** Every field as the inputs hold it: a string, blank when unknown. */
export interface OutcomeForm {
  actualEntry: string;
  actualStopLoss: string;
  actualTakeProfit: string;
  actualExit: string;
  quantity: string;
  fees: string;
  exitReason: string;
  /** `datetime-local` values, in the reader's own zone. */
  openedAt: string;
  closedAt: string;
}

export function outcomeFormFrom(trade: RecordedTrade | null): OutcomeForm {
  const text = (value: number | null | undefined) => (value == null ? "" : String(value));
  const time = (iso: string | null | undefined) => (iso ? toLocalInput(Date.parse(iso)) : "");
  return {
    actualEntry: text(trade?.actualEntry),
    actualStopLoss: text(trade?.actualStopLoss),
    actualTakeProfit: text(trade?.actualTakeProfit),
    actualExit: text(trade?.actualExit),
    quantity: text(trade?.quantity),
    fees: text(trade?.fees),
    exitReason: trade?.exitReason ?? "",
    openedAt: time(trade?.openedAt),
    closedAt: time(trade?.closedAt),
  };
}

export type OutcomeRequest =
  { ok: true; body: Record<string, unknown> } | { ok: false; message: string };

/**
 * The request body for a save, or why there is none.
 *
 * A time the user did not touch is sent as the instant it was recorded at, not
 * as the input's reading of it — the input holds whole seconds, and re-reading
 * it would quietly drop a recorded millisecond. A time that does not read as
 * one stops the save rather than being dropped, which would clear it.
 */
export function outcomeRequest(
  form: OutcomeForm,
  recorded: RecordedTrade | null,
  close: boolean,
): OutcomeRequest {
  const openedAt = instant(form.openedAt, recorded?.openedAt ?? null);
  const closedAt = instant(form.closedAt, recorded?.closedAt ?? null);
  if (Number.isNaN(openedAt)) return { ok: false, message: "The fill time is not a valid time." };
  if (Number.isNaN(closedAt)) return { ok: false, message: "The close time is not a valid time." };

  return {
    ok: true,
    body: {
      actualEntry: Number(form.actualEntry),
      ...(form.actualStopLoss ? { actualStopLoss: Number(form.actualStopLoss) } : {}),
      ...(form.actualTakeProfit ? { actualTakeProfit: Number(form.actualTakeProfit) } : {}),
      ...(form.actualExit ? { actualExit: Number(form.actualExit) } : {}),
      quantity: Number(form.quantity),
      ...(form.fees ? { fees: Number(form.fees) } : {}),
      ...(recorded?.slippage != null ? { slippage: recorded.slippage } : {}),
      ...(form.exitReason ? { exitReason: form.exitReason } : {}),
      ...(openedAt !== undefined ? { openedAt } : {}),
      ...(closedAt !== undefined ? { closedAt } : {}),
      close,
    },
  };
}

/** Undefined when blank, NaN when not a time. */
function instant(value: string, recorded: string | null): number | undefined {
  if (value === "") return undefined;
  const typed = fromLocalInput(value);
  if (recorded !== null) {
    const at = Date.parse(recorded);
    // Untouched: it still reads as the recorded instant, to the second. Compared
    // as instants, since a browser may drop ":00" seconds from the value.
    if (typed === fromLocalInput(toLocalInput(at))) return at;
  }
  return typed;
}
