import type { EntryZone, RiskReward, StopLoss, TakeProfitTarget } from "./types";
import { GOOD_RR, MIN_ACCEPTABLE_RR } from "./types";

/**
 * How far a structural target must sit from the entry before the ratio to it
 * means anything.
 *
 * A resistance zone 0.2R above the entry is a real level, but a trade measured
 * to it is risking one to make a fifth — which is not a description of the
 * opportunity, it is a description of the level being almost on top of the
 * entry. One R is the natural line because it is where reward first equals
 * risk, and it is already the threshold the status engine treats as
 * disqualifying.
 */
export const MIN_MEANINGFUL_TARGET_R = 1;

/**
 * Risk/reward, measured to the second structural target where one exists.
 *
 * TP1 alone flatters nothing — it is usually the nearest resistance and often
 * sits under 1R, which would condemn perfectly good setups. TP3 flatters
 * everything, since it is the most speculative target. The second target is
 * the level a trade is realistically managed toward, so that is what the
 * status engine judges the setup by.
 *
 * ## Why the target has to be a meaningful structural one
 *
 * An R-multiple target is `entry + risk × n`, so measuring reward to it
 * returns `n` — the number the fallback ladder chose, not a fact about the
 * market. Measuring to TP2 blindly meant a chart with no resistance above it
 * scored a tidy 1:2.5 every single time, and scored *better* than a real setup
 * whose nearest structural target happened to sit at 1.8R. That is exactly
 * backwards: no visible target is less information, not more.
 *
 * The correction has to cut both ways, though. Falling back to the nearest
 * structural target regardless of distance is the same error inverted — a
 * resistance zone a fifth of an R above the entry would report 1:0.2 and
 * condemn a setup for the crime of having a level near it. So a structural
 * target only counts once it is at least `MIN_MEANINGFUL_TARGET_R` away.
 *
 * When nothing qualifies, the ratio is still reported — the ladder has to be
 * measured to something — but flagged `isSynthetic` so the score and the
 * status can decline to treat arithmetic as evidence.
 */
export function calculateRiskReward(
  entry: EntryZone,
  stopLoss: StopLoss,
  takeProfits: TakeProfitTarget[],
): RiskReward | null {
  const risk = entry.mid - stopLoss.price;
  if (risk <= 0 || takeProfits.length === 0) return null;

  const structural = takeProfits.filter(
    (t) => t.kind === "STRUCTURAL" && t.rr >= MIN_MEANINGFUL_TARGET_R,
  );

  // The second qualifying structural target where the chart offers two, the
  // only one where it offers one, and the plain TP2 fallback where it offers
  // none — the last of which is the case that gets flagged below.
  const target = structural[1] ?? structural[0] ?? takeProfits[1] ?? takeProfits[0];
  const isSynthetic = !structural.includes(target);

  const reward = target.level - entry.mid;
  const ratio = reward / risk;
  const isPoor = ratio < MIN_ACCEPTABLE_RR;

  const reasons = [
    `Risking ${format(risk)} per unit to make ${format(reward)} at ${target.label} — a ratio of 1:${ratio.toFixed(
      1,
    )}.`,
  ];

  if (isSynthetic) {
    reasons.push(
      `That figure is arithmetic rather than evidence: this timeframe shows no resistance zone or prior high at least ${MIN_MEANINGFUL_TARGET_R}× the risk above the entry, so ${target.label} sits at a fixed multiple of the risk instead. The ratio restates that multiple and says nothing about where sellers are waiting. Treat the reward on this trade as unmeasured.`,
    );
  } else if (isPoor) {
    reasons.push(
      `That is below the 1:${MIN_ACCEPTABLE_RR} minimum this tool treats as worthwhile. At this ratio you need to be right more often than not just to break even, which is the wrong way round.`,
    );
  } else if (ratio >= GOOD_RR) {
    reasons.push(
      `At 1:${GOOD_RR} or better, the setup pays for a losing trade with a single winner, which is what makes a strategy survivable.`,
    );
  } else {
    reasons.push("That clears the minimum this tool treats as worthwhile, without being generous.");
  }

  const tp1 = takeProfits[0];
  if (tp1 && tp1.rr < 1) {
    reasons.push(
      `Note that TP1 sits at only ${tp1.rr.toFixed(1)}R, so taking the whole position off there would lose money over time.`,
    );
  }

  return {
    ratio,
    risk,
    reward,
    measuredTo: target.label,
    isSynthetic,
    isPoor,
    reason: reasons.join(" "),
  };
}

function format(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}
