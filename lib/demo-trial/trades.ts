import { computeOutcome, type JournalDecision, type TradeOutcome } from "@/lib/journal";

import { stateAt, statesAround, type SetupHistory, type StateAtEntry } from "./at-entry";
import { DEMO_TRIAL, FEE_ESTIMATE } from "./config";

/**
 * One journaled trade, set beside the plan it was taken from and the trial's
 * rules.
 *
 * Pure, and a comparison only. The result comes from `computeOutcome` — the
 * journal's own definition of R, imported rather than restated — and every
 * difference from the plan is reported as a difference, never corrected: the
 * gap between what SpotLens planned and what Demo filled is what the trial is
 * measuring. A rule that cannot be checked from what was recorded — missing,
 * or too close to call — is reported as unknown, never passed. A rule verdict
 * never touches the result: the exit and its R are reported as recorded.
 */

/** The stored setup's levels, as the calculator offered them. */
export interface TrialPlan {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  /** The primary target: the one the setup's risk/reward was measured to. */
  measuredTarget: number | null;
  measuredTargetLabel: string | null;
  /** The engine's ratio, measured from the middle of the zone. */
  riskReward: number;
  riskRewardIsSynthetic: boolean;
}

export interface TrialTradeInput {
  entryId: string;
  symbol: string;
  timeframe: string;
  decision: JournalDecision;
  /** Frozen when the journal entry was created, which may be before the fill. */
  statusAtDecision: string | null;
  decidedAt: number;
  /** When the journal first recorded Taken — at creation, or by a later change. */
  takenRecordedAt: number | null;
  skipReason: string | null;
  /** Recorded through the late-entry path: its entry time is the user's statement. */
  lateEntry: boolean;
  /** Null for an entry with no tracked setup behind it. */
  plan: TrialPlan | null;
  /** The tracked setup's lifecycle and reads. Null without a tracked setup. */
  history: SetupHistory | null;
  actualEntry: number | null;
  actualStopLoss: number | null;
  actualTakeProfit: number | null;
  actualExit: number | null;
  quantity: number | null;
  fees: number | null;
  slippage: number | null;
  exitReason: string | null;
  /** The fill time, as the user recorded it. */
  openedAt: number | null;
  closedAt: number | null;
}

export type TrialFlagCode =
  | "NO_FILL_RECORDED"
  | "NO_FILL_TIME"
  | "NO_STOP_RECORDED"
  | "NO_TARGET_RECORDED"
  | "NO_EXIT_RECORDED"
  | "NO_EXIT_REASON"
  | "NO_TRACKED_SETUP"
  | "NOT_POTENTIAL_AT_FILL"
  | "SETUP_CLOSED_AT_FILL"
  | "STATUS_AMBIGUOUS_AT_FILL"
  | "SETUP_HISTORY_INCOMPLETE"
  | "NOT_FRESH_AT_FILL"
  | "FRESHNESS_AMBIGUOUS_AT_FILL"
  | "FRESHNESS_UNKNOWN_AT_FILL"
  | "RISK_OVER_BUDGET"
  | "LOSS_OVER_BUDGET"
  | "POSITION_OVER_CAPITAL"
  | "TARGET_NOT_PRIMARY"
  | "NO_PRIMARY_TARGET"
  | "TAKEN_BEFORE_FILL"
  | "TAKEN_AMBIGUOUS"
  | "NO_TAKEN_RECORD"
  | "EXITED_ON_INVALIDATION"
  | "EXIT_MAY_FOLLOW_INVALIDATION"
  | "LATE_ENTRY";

/** A rule held, was broken, or cannot be told from the record. Unknown never counts as held. */
export type RuleVerdict = "ok" | "NO" | "unknown";

/** One verdict per trial rule a trade can be checked against. */
export interface RuleVerdicts {
  potentialAndOpen: RuleVerdict;
  fresh: RuleVerdict;
  /** Planned loss at the stop within 1 USDT with estimated fees, and the position within capital. */
  withinBudget: RuleVerdict;
  primaryTarget: RuleVerdict;
  takenAfterFill: RuleVerdict;
  exitNotOnInvalidation: RuleVerdict;
}

export interface TrialFlag {
  code: TrialFlagCode;
  message: string;
}

export type ZonePosition = "BELOW_ZONE" | "IN_ZONE" | "ABOVE_ZONE";

/** Actual against planned, each as a percentage of the planned price. Null when either is missing. */
export interface PlanComparison {
  entryVsZone: ZonePosition | null;
  /** The fill against the top of the zone — the price the calculator sized from. */
  entryVsZoneTopPct: number | null;
  stopVsPlanPct: number | null;
  /** The take-profit set against the primary target. */
  targetVsPlanPct: number | null;
  /**
   * On a stop-out: the exit against the stop recorded in the journal. Negative
   * is a fill below it. Null with no stop recorded — never the plan's stop.
   */
  stopFillPct: number | null;
  /**
   * On a take-profit: the exit against the take-profit recorded in the
   * journal. Null with none recorded — never the plan's target.
   */
  targetFillPct: number | null;
}

export interface TrialTradeReview extends TrialTradeInput {
  /** Null until an entry price and a quantity are recorded. */
  outcome: TradeOutcome | null;
  positionUsdt: number | null;
  /**
   * What the position stood to lose at its stop, estimated fees on both legs
   * included — the trial's budget is 1 USDT of this, not of the bare risk.
   */
  plannedLossUsdt: number | null;
  /** The setup as SpotLens showed it at the recorded fill time. Null when that cannot be known. */
  atFill: StateAtEntry | null;
  vsPlan: PlanComparison;
  rules: RuleVerdicts;
  /** Why each rule that is not ok is NO or unknown, and anything else worth a reader's eye. */
  flags: TrialFlag[];
}

/**
 * How exact a typed-in time is taken to be. Within this of a change, which
 * side of the change the moment fell on cannot be told.
 */
const SAME_MOMENT_MS = 60_000;

/** Floating-point slack on a budget check: 1.0000000001 USDT is 1 USDT. */
const BUDGET_EPSILON = 1e-9;

/**
 * The loss at the stop with estimated fees on both legs.
 *
 * The risk calculator's convention, for a quantity already chosen rather than
 * one being sized: the bare risk plus the fee rate on the notional in and out
 * (`lib/risk` — `estimatedNetLoss`). A test pins the two to the same number.
 */
export function plannedLossAtStop(input: {
  entry: number;
  stopLoss: number;
  quantity: number;
  feeRate: number;
}): number {
  const { entry, stopLoss, quantity, feeRate } = input;
  return quantity * (entry - stopLoss) + quantity * (entry + stopLoss) * feeRate;
}

export function reviewTrade(input: TrialTradeInput): TrialTradeReview {
  const outcome =
    input.actualEntry === null || input.quantity === null
      ? null
      : computeOutcome({
          actualEntry: input.actualEntry,
          actualStopLoss: input.actualStopLoss ?? undefined,
          actualTakeProfit: input.actualTakeProfit ?? undefined,
          actualExit: input.actualExit ?? undefined,
          quantity: input.quantity,
          fees: input.fees ?? undefined,
          slippage: input.slippage ?? undefined,
          openedAt: input.openedAt ?? undefined,
          closedAt: input.closedAt ?? undefined,
        });

  const positionUsdt =
    input.actualEntry === null || input.quantity === null
      ? null
      : input.actualEntry * input.quantity;

  const plannedLossUsdt =
    input.actualEntry === null || input.actualStopLoss === null || input.quantity === null
      ? null
      : plannedLossAtStop({
          entry: input.actualEntry,
          stopLoss: input.actualStopLoss,
          quantity: input.quantity,
          feeRate: DEMO_TRIAL.estimatedFeeRate,
        });

  const atFill =
    input.history === null || input.openedAt === null
      ? null
      : stateAt(input.history, input.timeframe, input.openedAt);

  return {
    ...input,
    outcome,
    positionUsdt,
    plannedLossUsdt,
    atFill,
    vsPlan: compareWithPlan(input),
    ...checkRules(input, { outcome, positionUsdt, plannedLossUsdt, atFill }),
  };
}

function pct(actual: number | null, planned: number | null): number | null {
  if (actual === null || planned === null || planned === 0) return null;
  return ((actual - planned) / planned) * 100;
}

function compareWithPlan(input: TrialTradeInput): PlanComparison {
  const { plan } = input;
  const entry = input.actualEntry;

  const entryVsZone: ZonePosition | null =
    plan === null || entry === null
      ? null
      : entry < plan.entryLow
        ? "BELOW_ZONE"
        : entry > plan.entryHigh
          ? "ABOVE_ZONE"
          : "IN_ZONE";

  return {
    entryVsZone,
    entryVsZoneTopPct: pct(entry, plan?.entryHigh ?? null),
    stopVsPlanPct: pct(input.actualStopLoss, plan?.stopLoss ?? null),
    targetVsPlanPct: pct(input.actualTakeProfit, plan?.measuredTarget ?? null),
    // An exit is measured only against the order recorded in the journal. The
    // plan's level is SpotLens's, compared with the recorded one just above;
    // standing in for a missing one it would be reported as the Demo order.
    stopFillPct:
      input.exitReason === "STOP_LOSS" ? pct(input.actualExit, input.actualStopLoss) : null,
    targetFillPct:
      input.exitReason === "TAKE_PROFIT" ? pct(input.actualExit, input.actualTakeProfit) : null,
  };
}

function checkRules(
  input: TrialTradeInput,
  derived: {
    outcome: TradeOutcome | null;
    positionUsdt: number | null;
    plannedLossUsdt: number | null;
    atFill: StateAtEntry | null;
  },
): { rules: RuleVerdicts; flags: TrialFlag[] } {
  const { outcome, positionUsdt, plannedLossUsdt, atFill } = derived;
  const { maxRiskUsdt, capitalUsdt, primaryTargetTolerancePct } = DEMO_TRIAL;
  const flags: TrialFlag[] = [];
  const flag = (code: TrialFlagCode, message: string) => flags.push({ code, message });

  // --- what was recorded ------------------------------------------------------
  if (outcome === null) {
    flag("NO_FILL_RECORDED", "No fill price or quantity recorded, so there is nothing to measure.");
  }
  if (input.openedAt === null) {
    flag(
      "NO_FILL_TIME",
      "No fill time recorded, so whether the setup was Potential, open and fresh at the fill, and whether Taken came after it, cannot be checked.",
    );
  }
  if (outcome !== null && input.actualStopLoss === null) {
    flag("NO_STOP_RECORDED", "No stop recorded, so the risk taken and R cannot be measured.");
  }
  if (input.actualTakeProfit === null) {
    flag(
      "NO_TARGET_RECORDED",
      "No take-profit recorded, so the primary-target rule cannot be checked.",
    );
  }
  if (input.decision === "CLOSED" && input.actualExit === null) {
    flag("NO_EXIT_RECORDED", "Closed with no exit price, so there is no result.");
  }

  // --- the setup at the fill ----------------------------------------------------
  let potentialAndOpen: RuleVerdict = "unknown";
  let fresh: RuleVerdict = "unknown";
  if (input.plan === null || input.history === null) {
    flag(
      "NO_TRACKED_SETUP",
      "No tracked setup behind it. Under the trial rules only an open Potential setup is tradable; with no setup history, freshness cannot be rebuilt.",
    );
    potentialAndOpen = "NO";
  } else if (input.openedAt !== null && atFill !== null) {
    // Judged across the margin a typed-in fill time carries, not at its exact instant.
    const around = statesAround(input.history, input.timeframe, input.openedAt, SAME_MOMENT_MS);
    potentialAndOpen = statusVerdict(around, atFill, flag);
    fresh = freshnessVerdict(around, flag);
  }

  // --- the budget ---------------------------------------------------------------
  const overBudget = plannedLossUsdt !== null && plannedLossUsdt > maxRiskUsdt + BUDGET_EPSILON;
  const overCapital = positionUsdt !== null && positionUsdt > capitalUsdt + BUDGET_EPSILON;
  if (overBudget) {
    flag(
      "RISK_OVER_BUDGET",
      `Planned loss at the stop ${plannedLossUsdt.toFixed(4)} USDT with ${FEE_ESTIMATE}, over the ${maxRiskUsdt} USDT budget.`,
    );
  }
  if (outcome?.netPnl != null && -outcome.netPnl > maxRiskUsdt + BUDGET_EPSILON) {
    flag(
      "LOSS_OVER_BUDGET",
      `Lost ${(-outcome.netPnl).toFixed(4)} USDT net, more than the ${maxRiskUsdt} USDT budget — fees, slippage or a fill below the stop.`,
    );
  }
  if (overCapital) {
    flag(
      "POSITION_OVER_CAPITAL",
      `A ${positionUsdt.toFixed(2)} USDT position is more than the ${capitalUsdt} USDT trial capital.`,
    );
  }
  const withinBudget: RuleVerdict =
    overBudget || overCapital ? "NO" : plannedLossUsdt === null ? "unknown" : "ok";

  // --- the workflow -------------------------------------------------------------
  let primaryTarget: RuleVerdict = "unknown";
  const targetGap = pct(input.actualTakeProfit, input.plan?.measuredTarget ?? null);
  if (targetGap !== null) {
    primaryTarget = Math.abs(targetGap) > primaryTargetTolerancePct ? "NO" : "ok";
    if (primaryTarget === "NO") {
      flag(
        "TARGET_NOT_PRIMARY",
        `The take-profit set is ${targetGap.toFixed(2)}% from the primary target (${input.plan?.measuredTargetLabel ?? "measured target"}).`,
      );
    }
  } else if (input.actualTakeProfit !== null && input.plan !== null) {
    flag(
      "NO_PRIMARY_TARGET",
      "The setup has no measured target to compare the take-profit against.",
    );
  }

  let takenAfterFill: RuleVerdict = "unknown";
  if (input.openedAt !== null) {
    if (input.takenRecordedAt === null) {
      flag(
        "NO_TAKEN_RECORD",
        "The journal's history holds no Taken event, so when Taken was recorded cannot be checked.",
      );
    } else if (input.takenRecordedAt < input.openedAt - SAME_MOMENT_MS) {
      takenAfterFill = "NO";
      flag("TAKEN_BEFORE_FILL", "Taken was recorded before the recorded fill time.");
    } else if (input.takenRecordedAt < input.openedAt + SAME_MOMENT_MS) {
      flag(
        "TAKEN_AMBIGUOUS",
        "Taken was recorded within a minute of the recorded fill time, so which came first cannot be told.",
      );
    } else {
      takenAfterFill = "ok";
    }
  }

  const exitNotOnInvalidation = exitVerdict(input, flag);

  if (input.lateEntry) {
    flag(
      "LATE_ENTRY",
      "Recorded as a late entry on a closed setup; its entry time is self-reported, not verified.",
    );
  }

  return {
    rules: {
      potentialAndOpen,
      fresh,
      withinBudget,
      primaryTarget,
      takenAfterFill,
      exitNotOnInvalidation,
    },
    flags,
  };
}

type Flag = (code: TrialFlagCode, message: string) => void;

/** Ok only if the setup was Potential throughout the margin around the fill. */
function statusVerdict(around: StateAtEntry[], atFill: StateAtEntry, flag: Flag): RuleVerdict {
  const potential = around.filter((state) => state.status === "POTENTIAL_SETUP").length;
  if (potential === around.length) return "ok";
  if (potential > 0) {
    flag(
      "STATUS_AMBIGUOUS_AT_FILL",
      "The setup's status changed within a minute of the recorded fill time, so which state the fill met cannot be told.",
    );
    return "unknown";
  }
  if (around.some((state) => state.tracked && state.status === null)) {
    flag(
      "SETUP_HISTORY_INCOMPLETE",
      "The setup's event log holds no state for the fill time, so its status then cannot be told.",
    );
    return "unknown";
  }
  if (atFill.status === "INVALIDATED") {
    flag(
      "SETUP_CLOSED_AT_FILL",
      "The setup was already closed (invalidated or replaced) at the fill.",
    );
  } else {
    flag(
      "NOT_POTENTIAL_AT_FILL",
      atFill.status === null
        ? "SpotLens was not tracking this setup yet at the fill, so it was not a Potential setup."
        : `The setup was ${readable(atFill.status)} at the fill, not a Potential setup. Wait for confirmation is not an entry signal.`,
    );
  }
  return "NO";
}

/** Ok only if the analysis was fresh throughout the margin around the fill. */
function freshnessVerdict(around: StateAtEntry[], flag: Flag): RuleVerdict {
  const states = new Set(around.map((state) => state.freshness));
  if (states.size === 1 && states.has("FRESH")) return "ok";
  if (states.size === 1 && states.has("STALE")) {
    flag(
      "NOT_FRESH_AT_FILL",
      "The analysis was out of date at the fill: a newer candle had closed that no completed pass had read.",
    );
    return "NO";
  }
  if (states.has("UNKNOWN")) {
    flag(
      "FRESHNESS_UNKNOWN_AT_FILL",
      "No read naming its candle was available by the fill, so whether the analysis was fresh cannot be judged.",
    );
  } else {
    flag(
      "FRESHNESS_AMBIGUOUS_AT_FILL",
      "The analysis went out of date or was re-read within a minute of the recorded fill time, so whether it was fresh at the fill cannot be told.",
    );
  }
  return "unknown";
}

/**
 * Invalidation is not a stop-loss. An exit recorded as made because of it
 * breaks the rule; the position's own stop or take-profit keeps it. A manual
 * exit keeps it only when the setup provably was not invalidated by then —
 * otherwise whether invalidation drove it cannot be told. An open trade has no
 * exit to judge yet.
 */
function exitVerdict(input: TrialTradeInput, flag: Flag): RuleVerdict {
  const reason = input.exitReason;
  if (reason === "INVALIDATED") {
    flag(
      "EXITED_ON_INVALIDATION",
      "Exit reason recorded as invalidated. In this trial invalidation is not a stop-loss and does not by itself require closing a trade; the position's own stop and take-profit decide the exit. A rule flag only — the exit and its result are reported as recorded.",
    );
    return "NO";
  }
  if (reason === "TAKE_PROFIT" || reason === "STOP_LOSS") return "ok";
  if (input.decision !== "CLOSED") return "unknown";
  if (reason === null) {
    flag(
      "NO_EXIT_REASON",
      "Closed with no exit reason recorded, so whether the exit followed the trial's rules cannot be checked.",
    );
    return "unknown";
  }

  // A manual or other exit.
  const history = input.history;
  if (history === null || !history.events.some((e) => e.toStatus === "INVALIDATED")) return "ok";
  const invalidatedByClose =
    input.closedAt === null
      ? null
      : stateAt(history, input.timeframe, input.closedAt + SAME_MOMENT_MS).status === "INVALIDATED";
  if (invalidatedByClose === false) return "ok";
  flag(
    "EXIT_MAY_FOLLOW_INVALIDATION",
    input.closedAt === null
      ? "Closed by hand with no close time recorded, on a setup that was invalidated: whether the invalidation drove the exit cannot be told."
      : "Closed by hand after the setup was invalidated: whether the invalidation drove the exit cannot be told from the journal.",
  );
  return "unknown";
}

function readable(status: string): string {
  return status.toLowerCase().replace(/_/g, " ");
}
