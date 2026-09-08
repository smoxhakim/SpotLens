import { RISK_DISCLAIMER } from "@/lib/constants/disclaimers";

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
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult | null {
  const { balance, riskPercent, entry, stopLoss } = input;

  if (!Number.isFinite(balance) || balance <= 0) return null;
  if (!Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 100) return null;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(stopLoss) || stopLoss <= 0 || stopLoss >= entry) return null;

  const riskAmount = balance * (riskPercent / 100);
  const riskPerUnit = entry - stopLoss;
  const positionSize = riskAmount / riskPerUnit;
  const positionValue = positionSize * entry;
  const positionPctOfBalance = positionValue / balance;

  const notes = [
    `Risking ${riskPercent}% of ${balance} means a maximum loss of ${riskAmount.toFixed(2)} if the stop is hit.`,
  ];

  if (positionValue > balance) {
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
    riskAmount,
    positionPctOfBalance,
    note: notes.join(" "),
  };
}
