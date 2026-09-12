import { gradeFor, type SetupGrade, type TradeStatus } from "@/lib/analysis";

import { effectiveRiskReward, rankResults, type RankableResult } from "./ranking";

/**
 * The shortlist: which of a pass's results are worth a person's attention.
 *
 * A scan covers forty-five markets on two timeframes, and ninety analyses is
 * more than anyone reviews. This layer decides which few of them to put in
 * front of the reader — and it is a *prioritisation* of the engine's output,
 * not a second opinion about the market. Nothing here computes an indicator,
 * reads a clock, touches the network, or invents a number. Every input is a
 * fact the analysis already established and the scanner already stored.
 *
 * There is one canonical order. `top5`, `top10` and `top15` are prefixes of it,
 * so a candidate can never be fifth on one view and eleventh on another.
 */

/** Everything the shortlist reads. A projection of one stored scanner result. */
export interface ShortlistInput extends RankableResult {
  symbol: string;
  timeframe: string;
  analysisStatus: TradeStatus | null;
  score: number | null;
  riskReward: number | null;
  riskRewardIsSynthetic: boolean | null;
  /** OK, or a market that failed before the engine ran. */
  ok: boolean;
  /**
   * Where the tracked setup moved this pass, when it moved at all.
   *
   * Null is the common case and does *not* mean "no setup": the lifecycle
   * records a transition, so a setup that was re-observed unchanged reports
   * nothing. Used only as context on the explanation, never as a rank input,
   * precisely because its absence carries no information.
   */
  lifecycleStatus: string | null;
  /** The setup this result belongs to, so a candidate opens its own analysis. */
  trackedSetupId: string | null;
  /** Open time of the last closed candle the analysis ran on. Provenance. */
  analysedAtCandle: number | null;
  /** Context, carried for the explanation only. Null on older stored rows. */
  trend: string | null;
  mtfAgreement: string | null;
  regimeDirection: string | null;
}

/**
 * Why a result did not make the shortlist.
 *
 * Counted and reported rather than silently dropped: "ninety analysed, eight
 * eligible" is only meaningful next to what happened to the other eighty-two.
 */
export type ExclusionReason =
  "FAILED" | "AVOID" | "HIGH_RISK" | "BELOW_QUALITY_BAR" | "REWARD_NOT_MEASURED";

export interface ShortlistCandidate {
  symbol: string;
  timeframe: string;
  analysisStatus: TradeStatus;
  /** 1-based position in the canonical order. */
  rank: number;
  score: number;
  /** The engine's own grade for that score. Never a probability. */
  grade: SetupGrade;
  riskReward: number | null;
  riskRewardIsMeasured: boolean;
  lifecycleStatus: string | null;
  trackedSetupId: string | null;
  analysedAtCandle: number | null;
  trend: string | null;
  mtfAgreement: string | null;
  regimeDirection: string | null;
  /** Plain statements of the facts that put it here. Never a recommendation. */
  reasons: string[];
}

export interface Shortlist {
  totalAnalysed: number;
  totalEligible: number;
  excluded: Record<ExclusionReason, number>;
  /** The canonical order. Every view below is a prefix of this. */
  allEligible: ShortlistCandidate[];
  top5: ShortlistCandidate[];
  top10: ShortlistCandidate[];
  top15: ShortlistCandidate[];
  /**
   * Bumped when the rules below change, so a stored or cached shortlist can be
   * told apart from one built by a later version of them.
   */
  rankingVersion: number;
}

export const SHORTLIST_RANKING_VERSION = 1;

/**
 * The quality bar for a setup that has not been promoted.
 *
 * Expressed as a grade rather than a number so it cannot drift from the
 * engine's own thresholds: "at least moderate" is decided in one place, by
 * `gradeFor`, and this reads it. A WEAK setup still waiting for confirmation is
 * not something to spend one of five slots on.
 */
const MINIMUM_WAITING_GRADE: SetupGrade[] = ["STRONG", "MODERATE"];

/**
 * Whether a result is worth putting in front of the reader.
 *
 * Deliberately strict, in the same spirit as the status rules it sits behind:
 * the engine already prefers to say wait, and a shortlist that relaxed that
 * would undo it.
 *
 *  - POTENTIAL_SETUP is the engine's highest state and is always eligible.
 *  - WAIT_FOR_CONFIRMATION is eligible only when the setup is at least moderate
 *    *and* its reward was measured against structure. A strong setup waiting on
 *    one specific confirmation is exactly what a reviewer wants to see; a weak
 *    one, or one whose reward is the fallback ladder's own constant, is not.
 *  - HIGH_RISK is excluded. The engine has already qualified against it, and a
 *    high raw score does not undo that — letting one in would mean a setup the
 *    tool warned about outranking a structurally healthier candidate.
 *  - AVOID is excluded, and carries no levels to review in any case.
 *
 * Returns the reason for exclusion, or null when the result is eligible, so the
 * caller can count both without asking twice.
 */
export function exclusionFor(result: ShortlistInput): ExclusionReason | null {
  // The engine's verdict is read before the score, because an AVOID often has
  // no score at all: the run stops before building one when it has already
  // decided there is no responsible long here. Testing the score first
  // reported thirty-seven such markets as failures on a pass where nothing
  // failed — the same exclusion, described as the wrong thing.
  if (!result.ok || result.analysisStatus === null) return "FAILED";
  if (result.analysisStatus === "AVOID") return "AVOID";
  if (result.analysisStatus === "HIGH_RISK") return "HIGH_RISK";

  // Everything past here is a status the engine only reaches with a score.
  if (result.score === null) return "FAILED";

  if (result.analysisStatus === "WAIT_FOR_CONFIRMATION") {
    if (!MINIMUM_WAITING_GRADE.includes(gradeFor(result.score))) return "BELOW_QUALITY_BAR";
    // Phase A's rule, applied as a gate rather than only as a sort key. A
    // reward measured to an R-multiple is the ladder restating its own
    // constant, and a candidate offered for review on that basis would be
    // offering a number nothing in the chart supports.
    if (result.riskReward === null || result.riskRewardIsSynthetic !== false) {
      return "REWARD_NOT_MEASURED";
    }
  }

  return null;
}

/** Convenience form of `exclusionFor`, for callers that only need the verdict. */
export function isShortlistEligible(result: ShortlistInput): boolean {
  return exclusionFor(result) === null;
}

/**
 * Spreads the order across markets before it doubles up on one.
 *
 * A pass analyses each market on every scheduled timeframe, so one symbol can
 * hold two adjacent places on merit alone. That is not wrong — the two
 * timeframes are genuinely different reads — but five slots filled by two
 * symbols is a worse review list than five filled by five, and the reader loses
 * the discovery the broad scan was for.
 *
 * So: every symbol's best-ranked entry first, in rank order, then the entries
 * those displaced, still in rank order. Nothing is dropped and nothing is
 * re-scored; a second timeframe simply waits until every other market has had
 * its turn. Applied once, to the canonical order itself, so the prefixes stay
 * consistent with each other.
 */
export function spreadAcrossMarkets<T extends { symbol: string }>(ranked: readonly T[]): T[] {
  const seen = new Set<string>();
  const first: T[] = [];
  const rest: T[] = [];

  for (const entry of ranked) {
    if (seen.has(entry.symbol)) rest.push(entry);
    else {
      seen.add(entry.symbol);
      first.push(entry);
    }
  }

  return [...first, ...rest];
}

/**
 * What put this candidate where it is, in plain statements.
 *
 * Every line restates a fact already on the result. Nothing is inferred, and
 * nothing predicts an outcome — this explains a position in a list, which is
 * all the list is.
 */
export function reasonsFor(result: ShortlistInput): string[] {
  const reasons: string[] = [];
  const score = result.score ?? 0;

  if (result.analysisStatus === "POTENTIAL_SETUP") {
    reasons.push("Every deterministic condition the engine checks now holds.");
  } else {
    reasons.push("Waiting on confirmation — the engine has not promoted it.");
  }

  reasons.push(`Quality ${score}/100 (${gradeFor(score).toLowerCase()}).`);

  if (result.riskRewardIsSynthetic === false && result.riskReward !== null) {
    reasons.push(`Reward measured against structure at 1:${result.riskReward.toFixed(1)}.`);
  } else {
    reasons.push("Reward is not measurable against structure.");
  }

  if (result.lifecycleStatus === "CONFIRMATION_DETECTED") {
    reasons.push("Confirmation evidence appeared at this level on this pass.");
  } else if (result.lifecycleStatus === "SETUP_FORMING") {
    reasons.push("Price has not reached the entry zone yet.");
  }

  if (result.trend) reasons.push(`Trend is ${humanise(result.trend)}.`);
  if (result.mtfAgreement) reasons.push(`Higher timeframe: ${humanise(result.mtfAgreement)}.`);
  if (result.regimeDirection) reasons.push(`Regime: ${humanise(result.regimeDirection)}.`);

  return reasons;
}

function humanise(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}

/**
 * The whole pipeline, as one pure function.
 *
 * Filter, rank, spread, number, slice — in that order and nowhere else, so the
 * service, the API and any UI are all reading the same list rather than three
 * lists that happen to agree today.
 */
export function buildShortlist(results: readonly ShortlistInput[]): Shortlist {
  const excluded: Record<ExclusionReason, number> = {
    FAILED: 0,
    AVOID: 0,
    HIGH_RISK: 0,
    BELOW_QUALITY_BAR: 0,
    REWARD_NOT_MEASURED: 0,
  };

  const eligible: ShortlistInput[] = [];

  for (const result of results) {
    const reason = exclusionFor(result);
    if (reason === null) eligible.push(result);
    else excluded[reason] += 1;
  }

  const canonical = spreadAcrossMarkets(rankResults(eligible)).map((result, index) =>
    toCandidate(result, index + 1),
  );

  return {
    totalAnalysed: results.length,
    totalEligible: canonical.length,
    excluded,
    allEligible: canonical,
    // Prefixes of one array, never three separate sorts — which is what makes
    // top5 ⊂ top10 ⊂ top15 ⊂ all true by construction rather than by test.
    top5: canonical.slice(0, 5),
    top10: canonical.slice(0, 10),
    top15: canonical.slice(0, 15),
    rankingVersion: SHORTLIST_RANKING_VERSION,
  };
}

function toCandidate(result: ShortlistInput, rank: number): ShortlistCandidate {
  const score = result.score ?? 0;

  return {
    symbol: result.symbol,
    timeframe: result.timeframe,
    analysisStatus: result.analysisStatus!,
    rank,
    score,
    grade: gradeFor(score),
    riskReward: result.riskRewardIsSynthetic === false ? result.riskReward : null,
    riskRewardIsMeasured: result.riskRewardIsSynthetic === false && result.riskReward !== null,
    lifecycleStatus: result.lifecycleStatus,
    trackedSetupId: result.trackedSetupId,
    analysedAtCandle: result.analysedAtCandle,
    trend: result.trend,
    mtfAgreement: result.mtfAgreement,
    regimeDirection: result.regimeDirection,
    reasons: reasonsFor(result),
  };
}

/** The named views, so a caller asks for a size rather than a slice index. */
export const SHORTLIST_SIZES = { PRIMARY: 5, EXPANDED: 10, EXTENDED: 15 } as const;
export type ShortlistSize = "PRIMARY" | "EXPANDED" | "EXTENDED" | "ALL";

export function viewOf(shortlist: Shortlist, size: ShortlistSize): ShortlistCandidate[] {
  switch (size) {
    case "PRIMARY":
      return shortlist.top5;
    case "EXPANDED":
      return shortlist.top10;
    case "EXTENDED":
      return shortlist.top15;
    case "ALL":
      return shortlist.allEligible;
  }
}

export { effectiveRiskReward };
