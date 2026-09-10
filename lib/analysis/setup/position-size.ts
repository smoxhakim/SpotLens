import { RISK_DISCLAIMER } from "@/lib/constants/disclaimers";
import { calculateRisk } from "@/lib/risk";

export interface PositionSizeInput {
  /** Total account balance in quote currency. */
  balance: number;
  /** Maximum share of the balance to risk, as a percentage (e.g. 1 for 1%). */
  riskPercent: number;
  entry: number;
  stopLoss: number;
}

export interface PositionSizeResult {
  /** Units of the base asset to buy. */
  positionSize: number;
  /** Quote-currency cost of that position. */
  positionValue: number;
  /** Quote-currency loss if the stop is hit. */
  riskAmount: number;
  /** Share of the balance the position itself consumes. */
  positionPctOfBalance: number;
  note: string;
}

/**
 * Position size from the stop distance, not from a fixed fraction of balance.
 *
 * This is the calculation that decides whether a losing trade is survivable,
 * which is why it belongs beside the setup rather than in a separate tool.
 *
 * Since Phase H the arithmetic lives in `lib/risk`, and this is the adapter
 * that keeps the older, narrower shape its existing callers expect. Two
 * implementations of the same formula is exactly how a risk figure and a
 * position size start disagreeing, so there is only one.
 *
 * Deliberately reports the **uncapped** size and warns when it exceeds the
 * balance, rather than capping. That is the behaviour this function has always
 * had and what its callers render; the full calculator in `lib/risk` is where
 * the cap, the costs and the profit figures live.
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult | null {
  const result = calculateRisk({
    balance: input.balance,
    riskPercent: input.riskPercent,
    entry: input.entry,
    stopLoss: input.stopLoss,
    // No costs and no cap: this shape predates both, and adding either here
    // would silently change numbers already on screen elsewhere.
    feeRate: 0,
    slippageRate: 0,
  });

  if (!result.ok) return null;

  const { calculation } = result;
  const positionSize = calculation.uncappedQuantity;
  const positionValue = calculation.uncappedPositionQuote;
  const positionPctOfBalance = positionValue / input.balance;

  const notes = [
    `Risking ${input.riskPercent}% of ${input.balance} means a maximum loss of ${calculation.intendedRiskAmount.toFixed(2)} if the stop is hit.`,
  ];

  if (positionValue > input.balance) {
    notes.push(
      `This position would cost ${positionValue.toFixed(2)}, which is more than the whole balance. On spot you cannot buy it without leverage, which SpotLens does not support — either accept a smaller position and a smaller risk, or skip the trade.`,
    );
  } else if (positionPctOfBalance > 0.5) {
    notes.push(
      `It would take ${(positionPctOfBalance * 100).toFixed(0)}% of the balance to hold this position, because the stop is close to the entry.`,
    );
  }

  notes.push(RISK_DISCLAIMER);

  return {
    positionSize,
    positionValue,
    riskAmount: calculation.intendedRiskAmount,
    positionPctOfBalance,
    note: notes.join(" "),
  };
}
