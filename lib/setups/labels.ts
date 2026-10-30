import { validateTradeLevels } from "@/lib/analysis/setup/levels";

import type { SetupLifecycleStatus } from "./types";

/**
 * How a lifecycle state and the confirmation behind it are worded to a reader.
 *
 * Kept here rather than in a component because these labels describe a
 * verdict, and a component must not be the thing that decides what a state
 * means. Notifications already say "confirmation evidence", never "detected";
 * the app's own pages said "Confirmation detected" in green, on HIGH_RISK
 * setups too, which reads as an approval the engine never gave.
 */
export const LIFECYCLE_LABELS: Record<SetupLifecycleStatus, string> = {
  SETUP_FORMING: "Forming",
  WAITING_CONFIRMATION: "Waiting for confirmation",
  CONFIRMATION_DETECTED: "Confirmation evidence present",
  POTENTIAL_SETUP: "Potential setup",
  INVALIDATED: "Invalidated",
};

/**
 * A closed setup — invalidated, or replaced by a new setup on a different level,
 * which invalidates the old one — is a record, not an opportunity.
 *
 * Said wherever its levels are still shown, because the levels never change
 * and look exactly like a live setup's. Nothing can reopen it: INVALIDATED is
 * terminal, and a level that comes back is a new setup with a new id.
 */
export function isClosedSetup(status: string | null | undefined): boolean {
  return status === "INVALIDATED";
}

export const CLOSED_SETUP_NOTE =
  "This setup is closed: it was invalidated, or replaced by a newer setup on a different level. Its levels are a record of what was on offer, not a plan — there is nothing left to watch or take.";

export function lifecycleLabel(status: string): string {
  return (
    LIFECYCLE_LABELS[status as SetupLifecycleStatus] ?? status.toLowerCase().replace(/_/g, " ")
  );
}

/**
 * What has to be said next to confirmation evidence, given the engine's verdict.
 *
 * Confirmation is a gate and only a gate: it can hold a setup at WAIT and can
 * never promote one past HIGH_RISK. So evidence on anything short of a
 * potential setup comes with the sentence saying so — and on HIGH_RISK, with
 * the verdict named, because that is where "confirmation" is easiest to read
 * as a green light. Null when the verdict is POTENTIAL_SETUP (every rule,
 * confirmation included, already holds) or unknown.
 *
 * `asOf: "creation"` is for a stored setup, whose `analysisStatus` is written
 * once when it is first tracked and never updated — the sentence then says
 * when the verdict was given rather than presenting it as current.
 */
export function confirmationCaveat(
  analysisStatus: string | null | undefined,
  options: { asOf?: "current" | "creation" } = {},
): string | null {
  const atCreation = options.asOf === "creation";
  switch (analysisStatus) {
    case "HIGH_RISK":
      return atCreation
        ? "Evidence is not approval: the engine rated this setup high risk when it was first tracked, and confirmation cannot change that."
        : "Evidence is not approval: the engine still rates this setup high risk, and confirmation cannot change that.";
    case "WAIT_FOR_CONFIRMATION":
      return atCreation
        ? "Evidence is not approval: the setup was not promoted to a potential setup."
        : "Evidence is not approval: another rule is still holding this setup at wait.";
    case "AVOID":
      return "Evidence is not approval: the engine advises avoiding this market.";
    default:
      return null;
  }
}

/**
 * A warning for a stored setup whose levels are not in long order, or null.
 *
 * Display only. A stored setup's numbers are never rewritten — they are the
 * record of what was on offer — so a ladder stored before targets were
 * validated (LTC/USDT 1h, TP3 below TP2) stays as it was, and this says so
 * beside it rather than letting it pass as a normal ladder. The same check the
 * engine now runs before it measures a reward, applied to the stored columns.
 */
export function storedLevelsWarning(setup: {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
}): string | null {
  const check = validateTradeLevels({
    entryLow: setup.entryLow,
    entryHigh: setup.entryHigh,
    stopLoss: setup.stopLoss,
    targets: [setup.takeProfit1, setup.takeProfit2, setup.takeProfit3].filter(
      (level): level is number => level !== null,
    ),
  });
  if (check.ok) return null;
  return `${check.reason} These levels were stored before targets were checked for order, and are kept exactly as recorded — the engine would refuse this set today.`;
}

/**
 * `storedLevelsWarning` for levels carried as a list in ladder order — the
 * Coach's `CoachLevels`, which the Coach page, the decision page and the
 * model's prompt all read. One check, so the three cannot disagree about which
 * stored setups are flagged.
 */
export function storedTargetsWarning(levels: {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  takeProfits: readonly { level: number }[];
}): string | null {
  const [tp1, tp2, tp3] = levels.takeProfits.map((target) => target.level);
  return storedLevelsWarning({
    entryLow: levels.entryLow,
    entryHigh: levels.entryHigh,
    stopLoss: levels.stopLoss,
    takeProfit1: tp1 ?? null,
    takeProfit2: tp2 ?? null,
    takeProfit3: tp3 ?? null,
  });
}
