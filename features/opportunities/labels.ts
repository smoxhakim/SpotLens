import { MTF_AGREEMENT_LABELS, STATUS_LABELS, type MtfAgreement } from "@/lib/analysis";

/**
 * Presentation labels for a shortlist candidate.
 *
 * Presentation only. Every value here is a *name* for a fact Phase L already
 * decided — nothing is derived, compared or computed. The page must never work
 * out for itself whether a setup is eligible, how good it is, or where it
 * ranks; it receives all of that and puts words to it.
 *
 * Where the application already names one of these things, that name is reused
 * rather than restated: a status called "Wait for confirmation" on the analysis
 * page must not become "Waiting" here.
 */

export { STATUS_LABELS };

/** The engine's grade, in the register the rest of the UI uses. */
export const GRADE_LABELS: Record<string, string> = {
  STRONG: "Strong",
  MODERATE: "Moderate",
  WEAK: "Weak",
  AVOID: "Avoid",
};

/** Matches `RegimePanel`, so the same market reads the same way in both places. */
export const REGIME_DIRECTION_LABELS: Record<string, string> = {
  TRENDING_UP: "Trending up",
  TRENDING_DOWN: "Trending down",
  RANGE: "Range",
  UNCLEAR: "Unclear",
};

export const TREND_LABELS: Record<string, string> = {
  BULLISH: "Bullish",
  BEARISH: "Bearish",
  SIDEWAYS: "Sideways",
};

/**
 * A value with no entry in any table above.
 *
 * Turns anything unmapped into words rather than letting `WAITING_CONFIRMATION`
 * reach a reader. A row written by an older version is data, not a defect, and
 * it should still be legible.
 */
export function humanise(value: string): string {
  const words = value.toLowerCase().replace(/_/g, " ").trim();
  return words.length === 0 ? "—" : words[0].toUpperCase() + words.slice(1);
}

/**
 * A label, or nothing at all.
 *
 * Absent and null are both "not supplied", and both have to be tolerated: a
 * scanner row written before the context columns existed stores null, and
 * `JSON.stringify` drops an undefined field from the response entirely, so the
 * same missing fact arrives in two shapes depending on where it came from. A
 * card that renders context is not a card that may crash when there is none.
 */
export function labelFor(
  table: Record<string, string>,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return table[value] ?? humanise(value);
}

/** The higher-timeframe read, using the engine's own wording for it. */
export function mtfLabel(agreement: string | null | undefined): string | null {
  if (agreement === null || agreement === undefined || agreement === "") return null;
  return MTF_AGREEMENT_LABELS[agreement as MtfAgreement] ?? humanise(agreement);
}

/**
 * Risk/reward, or the plain statement that it could not be measured.
 *
 * Phase A's rule reaches the screen here: a ratio the engine could not measure
 * against structure is never printed as a ratio, because the number it would
 * print is the fallback ladder restating its own constant.
 */
export function riskRewardLabel(candidate: {
  riskReward: number | null | undefined;
  riskRewardIsMeasured: boolean | undefined;
}): string {
  // Anything other than a measured number reads as not measurable. Erring this
  // way is the only safe direction: presenting an unmeasured reward as measured
  // is the one mistake Phase A exists to prevent.
  if (
    candidate.riskRewardIsMeasured !== true ||
    candidate.riskReward === null ||
    candidate.riskReward === undefined
  ) {
    return "Not measurable";
  }
  return `1:${candidate.riskReward.toFixed(1)} · Measured`;
}

/**
 * Quality, always out of 100 and never as a percentage.
 *
 * The score orders a list. It does not predict an outcome, and a percent sign
 * here would say that it does.
 */
export function qualityLabel(score: number, grade: string | null | undefined): string {
  const named = labelFor(GRADE_LABELS, grade);
  // The score alone is still true and still useful; a missing grade is a
  // missing adjective, not a reason to withhold the number.
  return named === null ? `${score}/100` : `${score}/100 · ${named}`;
}
