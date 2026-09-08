import { formatPrice } from "@/lib/format";

import type { StructureRead } from "../structure";
import type { EmaCheck, EmaRead, TrendRead } from "../trend";

/**
 * Maps trend output to plain language.
 *
 * Deliberately templated and deterministic — the numbers and the verdict are
 * decided by the engine, and this layer only phrases them. An LLM rephrasing
 * pass could sit on top later without being able to change a single figure.
 */
export function explainTrend(read: TrendRead): string {
  const structure = explainStructure(read.structure);
  const ema = explainEmaAlignment(read.ema);

  if (read.conflict) {
    return `${structure} ${ema} Because market structure and the moving averages disagree, the trend is treated as unclear rather than picking a side.`;
  }

  if (read.structure.structure === "UNDETERMINED") {
    return `There are not enough confirmed swing points on this timeframe to read market structure yet. ${ema}`;
  }

  return `${structure} ${ema}`;
}

export function explainStructure(read: StructureRead): string {
  const { labels, lastHigh, lastLow, previousHigh, previousLow } = read;

  if (!labels.high || !labels.low) {
    return "There are not enough confirmed swing highs and lows on this timeframe to read market structure yet.";
  }

  const move = (from?: number, to?: number) => `(${formatPrice(from)} → ${formatPrice(to)})`;

  const highPhrase =
    labels.high === "HH"
      ? `a higher high ${move(previousHigh?.price, lastHigh?.price)}`
      : labels.high === "LH"
        ? `a lower high ${move(previousHigh?.price, lastHigh?.price)}`
        : `a high level with the previous one ${move(previousHigh?.price, lastHigh?.price)}`;

  const lowPhrase =
    labels.low === "HL"
      ? `a higher low ${move(previousLow?.price, lastLow?.price)}`
      : labels.low === "LL"
        ? `a lower low ${move(previousLow?.price, lastLow?.price)}`
        : `a low level with the previous one ${move(previousLow?.price, lastLow?.price)}`;

  switch (read.structure) {
    case "UPTREND":
      return `Price is forming ${highPhrase} and ${lowPhrase}, which is an uptrend structure.`;
    case "DOWNTREND":
      return `Price is forming ${highPhrase} and ${lowPhrase}, which is a downtrend structure.`;
    default:
      return `Price is forming ${highPhrase} and ${lowPhrase}. Highs and lows are not moving in the same direction, so the market is ranging rather than trending.`;
  }
}

export function explainEmaAlignment(ema: EmaRead): string {
  if (ema.alignment === "UNAVAILABLE") {
    return "There is not enough history on this timeframe to calculate the moving averages.";
  }

  const above: string[] = [];
  const below: string[] = [];
  const level: string[] = [];

  const record = (check: EmaCheck, subject: string, object: string) => {
    if (check === null) return;
    if (check === "ABOVE") above.push(`${subject} is above ${object}`);
    else if (check === "BELOW") below.push(`${subject} is below ${object}`);
    else level.push(`${subject} is level with ${object}`);
  };

  record(ema.checks.priceVsEma50, "price", "the EMA 50");
  record(ema.checks.ema20VsEma50, "the EMA 20", "the EMA 50");
  record(ema.checks.ema50VsEma200, "the EMA 50", "the EMA 200");

  if (ema.alignment === "BULLISH") return `The moving averages agree: ${joinList(above)}.`;
  if (ema.alignment === "BEARISH") return `The moving averages agree: ${joinList(below)}.`;

  if (above.length === 0 && below.length === 0) {
    return `The moving averages are flat — ${joinList(level)}, so they give no directional signal.`;
  }

  const parts = [...above, ...below, ...level];
  return `The moving averages are mixed — ${joinList(parts)}.`;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "no conditions apply";
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
