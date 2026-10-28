import { selectMeasuredTarget } from "@/lib/analysis";
import type { CoachLevels } from "@/lib/coach";

/**
 * Carrying a stored setup's levels into the calculator.
 *
 * Pure, and deliberately a *selection* rather than a calculation: every number
 * below is read straight off the levels the engine froze at creation. Nothing
 * is recomputed, rounded or re-derived, because the calculator's whole value is
 * that it sizes the position the analysis page described — and a prefill that
 * quietly produced a slightly different entry would make the two disagree
 * about the same setup.
 *
 * The one judgement here is which target to offer first, and even that is not a
 * judgement made here: `selectMeasuredTarget` is the engine's own rule,
 * imported rather than restated. The ratio on the panel is measured to one
 * particular target, and prefilling a different one would size against a reward
 * the reader was never shown.
 */

export interface RiskPrefill {
  entry: number;
  stopLoss: number;
  /** The target the stored ratio was measured to, when one can be identified. */
  takeProfit: number | null;
  takeProfitLabel: string | null;
  /** Every target, so the reader can size against a different one deliberately. */
  targets: { label: string; level: number }[];
  riskReward: number;
  /** Phase A's qualifier, carried the whole way into the calculator. */
  riskRewardIsSynthetic: boolean;
}

/**
 * The entry the calculator sizes from: the top of the zone.
 *
 * A zone is not a price and the calculator needs one number. Price reaches a
 * support zone from above, so its top is where a fill is likeliest — the
 * entry-zone alert fires on exactly that touch — and it is the worst fill inside
 * the zone. Sizing from it means a fill anywhere lower risks less than the
 * calculator said, never more. The midpoint, used before, understated the loss
 * on a top-of-zone fill by about a third.
 *
 * The engine's own ratio is still measured from the midpoint; the calculator
 * reports the ratio from this entry instead, so its size, loss and reward all
 * describe the same fill. The field stays editable for the price actually paid.
 */
export function entryPriceOf(levels: Pick<CoachLevels, "entryLow" | "entryHigh">): number {
  return levels.entryHigh;
}

export function riskPrefillFrom(levels: CoachLevels): RiskPrefill {
  // Only targets that kept their `kind` can take part in the engine's rule.
  // A record written before `kind` was carried yields no measured target
  // rather than the wrong one — the reader picks, and the page says why.
  const identifiable = levels.takeProfits.flatMap((target) =>
    target.kind === null || target.rr === null
      ? []
      : [{ label: target.label, level: target.level, kind: target.kind, rr: target.rr }],
  );

  const measured =
    identifiable.length === levels.takeProfits.length ? selectMeasuredTarget(identifiable) : null;

  return {
    entry: entryPriceOf(levels),
    stopLoss: levels.stopLoss,
    takeProfit: measured?.target.level ?? null,
    takeProfitLabel: measured?.target.label ?? null,
    targets: levels.takeProfits.map((target) => ({ label: target.label, level: target.level })),
    riskReward: levels.riskReward,
    riskRewardIsSynthetic: levels.riskRewardIsSynthetic,
  };
}

/**
 * The query string the calculator reads.
 *
 * Built from the resolved levels on the server, never from what a caller sent:
 * the references travel in the URL and the numbers come out of the database, so
 * an edited link can change *which* setup is sized but not what its levels are.
 */
export function riskCalculatorParams(
  prefill: RiskPrefill,
  context: { symbol: string; timeframe: string; runId: string; setupId: string | null },
  takeProfitOverride?: number | null,
): URLSearchParams {
  const takeProfit = takeProfitOverride ?? prefill.takeProfit;

  const params = new URLSearchParams({
    entry: String(prefill.entry),
    stop: String(prefill.stopLoss),
    symbol: context.symbol,
    tf: context.timeframe,
    runId: context.runId,
  });

  if (takeProfit !== null) params.set("tp", String(takeProfit));
  if (prefill.riskRewardIsSynthetic) params.set("unmeasured", "1");
  if (context.setupId) params.set("setupId", context.setupId);

  return params;
}
