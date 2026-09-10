import {
  ALLOWED_TRANSITIONS,
  POSITION_DECISIONS,
  type JournalDecision,
  type JournalError,
  type TradeOutcome,
  type TradeOutcomeInput,
} from "./types";

/**
 * The journal's rules, as pure functions.
 *
 * No database, no clock: a transition is legal or it is not, and an outcome is
 * arithmetic on numbers the user supplied. The service performs the writes.
 */

/** Whether one decision may follow another. */
export function canTransition(from: JournalDecision, to: JournalDecision): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function validateTransition(
  from: JournalDecision,
  to: JournalDecision,
): JournalError | null {
  if (from === to) {
    // Not an error, but not a transition either. The service writes no event.
    return null;
  }

  if (!canTransition(from, to)) {
    return {
      code: "INVALID_TRANSITION",
      field: "decision",
      message:
        from === "CLOSED"
          ? "A closed entry cannot change: its recorded outcome describes the position as it was entered."
          : `A ${from.toLowerCase()} entry cannot become ${to.toLowerCase()}.`,
    };
  }

  return null;
}

/**
 * Checks a recorded outcome.
 *
 * Deliberately strict about the stop. Risk is measured from the fill the user
 * actually got to the stop they actually placed — not from the setup's plan —
 * so without a real stop there is no R to report, and reporting one anyway
 * would credit the engine's arithmetic to the user's trade.
 */
export function validateOutcome(
  decision: JournalDecision,
  input: TradeOutcomeInput,
): JournalError[] {
  const errors: JournalError[] = [];
  const finite = (v: number | undefined) => v !== undefined && Number.isFinite(v);

  if (!POSITION_DECISIONS.includes(decision)) {
    errors.push({
      code: "OUTCOME_REQUIRES_POSITION",
      field: "decision",
      message: "Only a taken or closed entry can carry a trade outcome.",
    });
  }

  for (const [field, value, required] of [
    ["actualEntry", input.actualEntry, true],
    ["actualStopLoss", input.actualStopLoss, false],
    ["actualTakeProfit", input.actualTakeProfit, false],
    ["actualExit", input.actualExit, false],
  ] as const) {
    if (value === undefined) {
      if (required) {
        errors.push({
          code: "INVALID_PRICE",
          field,
          message: "An actual entry price is required to record a trade.",
        });
      }
      continue;
    }
    if (!finite(value) || value <= 0) {
      errors.push({ code: "INVALID_PRICE", field, message: `${field} must be a positive number.` });
    }
  }

  if (!finite(input.quantity) || input.quantity <= 0) {
    errors.push({
      code: "INVALID_QUANTITY",
      field: "quantity",
      message: "Quantity must be a positive number.",
    });
  }

  for (const [field, value] of [
    ["fees", input.fees],
    ["slippage", input.slippage],
  ] as const) {
    if (value === undefined) continue;
    if (!finite(value) || value < 0) {
      errors.push({ code: "INVALID_COSTS", field, message: `${field} cannot be negative.` });
    }
  }

  // Spot longs only, exactly as the risk calculator requires.
  if (
    finite(input.actualEntry) &&
    input.actualStopLoss !== undefined &&
    finite(input.actualStopLoss) &&
    input.actualStopLoss >= input.actualEntry
  ) {
    errors.push({
      code: "STOP_NOT_BELOW_ENTRY",
      field: "actualStopLoss",
      message: "The stop must be below the entry. SpotLens covers spot longs only.",
    });
  }

  if (decision === "CLOSED" && input.actualExit === undefined) {
    errors.push({
      code: "CLOSED_REQUIRES_EXIT",
      field: "actualExit",
      message: "A closed entry needs an exit price — otherwise there is no result to record.",
    });
  }

  if (
    input.openedAt !== undefined &&
    input.closedAt !== undefined &&
    input.closedAt < input.openedAt
  ) {
    errors.push({
      code: "INVALID_TIMESTAMPS",
      field: "closedAt",
      message: "A trade cannot close before it opened.",
    });
  }

  return errors;
}

/**
 * What the recorded trade produced.
 *
 * Costs are whatever the user entered, not an assumption: the backtester models
 * a generic fee because it has to, but a journal entry describes one real trade
 * and the person who took it knows what it cost. Nothing is estimated here.
 */
export function computeOutcome(input: TradeOutcomeInput): TradeOutcome {
  const costs = (input.fees ?? 0) + (input.slippage ?? 0);

  const grossPnl =
    input.actualExit === undefined ? null : (input.actualExit - input.actualEntry) * input.quantity;

  const netPnl = grossPnl === null ? null : grossPnl - costs;

  const riskAmount =
    input.actualStopLoss === undefined
      ? null
      : (input.actualEntry - input.actualStopLoss) * input.quantity;

  // R only exists when both halves are real. The setup's planned stop is not a
  // substitute — that would measure the engine's intention, not the trade.
  const realizedR =
    netPnl === null || riskAmount === null || riskAmount <= 0 ? null : netPnl / riskAmount;

  const holdingMs =
    input.openedAt === undefined || input.closedAt === undefined
      ? null
      : input.closedAt - input.openedAt;

  return { grossPnl, netPnl, riskAmount, realizedR, holdingMs, costs };
}
