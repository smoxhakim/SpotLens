import type { EntryZone, RiskReward, StopLoss, TakeProfitTarget } from "./types";
import { GOOD_RR, MIN_ACCEPTABLE_RR } from "./types";

/**
 * Risk/reward, measured to TP2 where one exists.
 *
 * TP1 alone flatters nothing — it is usually the nearest resistance and often
 * sits under 1R, which would condemn perfectly good setups. TP3 flatters
 * everything, since it is the most speculative target. TP2 is the level a
 * trade is realistically managed toward, so that is what the status engine
 * judges the setup by.
 */
export function calculateRiskReward(
  entry: EntryZone,
  stopLoss: StopLoss,
  takeProfits: TakeProfitTarget[],
): RiskReward | null {
  const risk = entry.mid - stopLoss.price;
  if (risk <= 0 || takeProfits.length === 0) return null;

  const target = takeProfits[1] ?? takeProfits[0];
  const reward = target.level - entry.mid;
  const ratio = reward / risk;
  const isPoor = ratio < MIN_ACCEPTABLE_RR;

  const reasons = [
    `Risking ${format(risk)} per unit to make ${format(reward)} at ${target.label} — a ratio of 1:${ratio.toFixed(
      1,
    )}.`,
  ];

  if (isPoor) {
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
    isPoor,
    reason: reasons.join(" "),
  };
}

function format(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}
