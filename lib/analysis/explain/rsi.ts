/**
 * RSI commentary.
 *
 * Framed strictly as confirmation. Per the PRD, RSI must never produce a buy
 * or sell call on its own — an overbought reading in a strong uptrend is a sign
 * of strength, not a reason to sell, and this wording keeps that honest.
 */
export function explainRsi(rsi: number | null): string {
  if (rsi === null) {
    return "There is not enough history on this timeframe to calculate RSI.";
  }

  const value = rsi.toFixed(1);

  if (rsi >= 70) {
    return `RSI is ${value}, which is technically overbought. On its own that is not a sell signal — in a strong trend RSI can stay above 70 for a long time — but it does mean the move is extended and entries here carry worse risk/reward.`;
  }
  if (rsi <= 30) {
    return `RSI is ${value}, which is technically oversold. On its own that is not a buy signal — price can stay oversold throughout a downtrend — but combined with support and a bullish trend it can add confirmation.`;
  }
  if (rsi >= 55) {
    return `RSI is ${value}, in the upper half of its range, which leans bullish without being stretched.`;
  }
  if (rsi <= 45) {
    return `RSI is ${value}, in the lower half of its range, which leans bearish without being stretched.`;
  }
  return `RSI is ${value}, close to neutral, so it offers no meaningful confirmation either way.`;
}
