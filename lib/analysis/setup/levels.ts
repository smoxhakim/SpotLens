import type { EntryZone, StopLoss, TakeProfitTarget } from "./types";

/**
 * Whether a long setup's levels are in the only order a long can have.
 *
 *   stop loss < entry low ≤ entry high < TP1 ≤ TP2 ≤ TP3
 *
 * Every calculator upstream is meant to produce this by construction, and this
 * is the check that they did — run once, on the finished set, before the
 * reward is measured against any of it. A set that fails is refused, never
 * re-sorted: sorting would quietly turn a structural TP2 into a TP3 (or the
 * reverse) and change which target the ratio describes, which is a different
 * setup from the one the engine reasoned about.
 *
 * Pure, and no tolerance: the targets are already de-duplicated upstream, so
 * equality is allowed only where the order above allows it.
 */
export type LevelProblem =
  | "NOT_A_NUMBER"
  | "ENTRY_ZONE_INVERTED"
  | "STOP_NOT_BELOW_ENTRY"
  | "NO_TARGETS"
  | "TARGET_NOT_ABOVE_ENTRY"
  | "TARGETS_OUT_OF_ORDER";

export type LevelCheck = { ok: true } | { ok: false; problem: LevelProblem; reason: string };

export function validateTradeLevels(input: {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  /** In ladder order: TP1, TP2, TP3. */
  targets: readonly number[];
}): LevelCheck {
  const { entryLow, entryHigh, stopLoss, targets } = input;

  if (![entryLow, entryHigh, stopLoss, ...targets].every(Number.isFinite)) {
    return refuse("NOT_A_NUMBER", "One of the levels is not a finite price.");
  }
  if (entryLow > entryHigh) {
    return refuse("ENTRY_ZONE_INVERTED", "The entry zone's floor sits above its ceiling.");
  }
  if (!(stopLoss < entryLow)) {
    return refuse("STOP_NOT_BELOW_ENTRY", "The stop loss is not below the entry zone.");
  }
  if (targets.length === 0) {
    return refuse("NO_TARGETS", "No target sits above the entry zone.");
  }
  if (!(targets[0] > entryHigh)) {
    return refuse("TARGET_NOT_ABOVE_ENTRY", "TP1 is not above the entry zone.");
  }
  for (let i = 1; i < targets.length; i += 1) {
    if (targets[i] < targets[i - 1]) {
      return refuse(
        "TARGETS_OUT_OF_ORDER",
        `TP${i + 1} sits below TP${i}, so the targets do not ascend.`,
      );
    }
  }

  return { ok: true };
}

/** The same check, on the engine's own objects. */
export function validateSetupLevels(
  entry: EntryZone,
  stopLoss: StopLoss,
  takeProfits: readonly TakeProfitTarget[],
): LevelCheck {
  return validateTradeLevels({
    entryLow: entry.low,
    entryHigh: entry.high,
    stopLoss: stopLoss.price,
    targets: takeProfits.map((t) => t.level),
  });
}

function refuse(problem: LevelProblem, reason: string): LevelCheck {
  return { ok: false, problem, reason };
}
