import { GOOD_RR, MIN_ACCEPTABLE_RR } from "@/lib/analysis";

import type { CoachContext, CoachReview, CoachSection, CoachVerdict } from "./types";

/**
 * The deterministic reading of a context.
 *
 * Pure: no clock, no randomness, no I/O, no network. The same context always
 * produces the identical review, which is what lets a historical setup be
 * reviewed a year later and read the same way it did at the time.
 *
 * Everything it says is a *selection* from facts the engine already recorded —
 * which reason to surface, which signal belongs under which heading — never a
 * new calculation. The thresholds below decide what to show, and change no
 * number: the score, the ratio and the levels pass through untouched, and every
 * reason is the engine's own sentence rather than a paraphrase of it.
 */

/**
 * When a score category is worth calling out.
 *
 * Fractions of the category's own maximum, so a 25-point trend category and a
 * 10-point RSI one are judged on the same footing. These pick what to say, not
 * what anything is worth — the totals they are drawn from are the engine's.
 */
const STRONG_CATEGORY = 0.7;
const WEAK_CATEGORY = 0.3;

/**
 * How the Coach reads the evidence, from states the engine already reached.
 *
 * Ordered the way the lifecycle orders them, so the reading cannot disagree
 * with the engine: contradiction outranks everything, a promoted setup is the
 * highest state on offer, and confirmation present without promotion is the
 * real and common middle. No new rule is introduced here — each branch names
 * a state that already exists.
 */
export function verdictFor(context: CoachContext): CoachVerdict {
  const { analysisStatus, confirmationStatus } = context.verdictInputs;

  // Nothing to read: a candidate the scanner recorded but never tracked has a
  // score and a verdict but no levels and no confirmation evidence.
  if (context.levels === null && confirmationStatus === null) return "INSUFFICIENT_DATA";

  if (confirmationStatus === "CONTRADICTED") return "CONTRADICTED";
  if (analysisStatus === "POTENTIAL_SETUP") return "STRONG_EVIDENCE";
  if (confirmationStatus === "PRESENT") return "PROMISING_NEEDS_CONFIRMATION";

  return "MIXED_EVIDENCE";
}

/**
 * A plain-language opening, assembled from what the verdict rests on.
 *
 * Deliberately flat in tone. A summary that sounded pleased about a setup would
 * be doing the reader's deciding for them, and the one thing this layer must
 * not do is decide.
 */
function summaryFor(context: CoachContext, verdict: CoachVerdict): string {
  const where = `${context.identity.symbol} on ${context.identity.timeframe}`;
  const quality = `SpotLens scores it ${context.quality.score}/100 (${context.quality.grade.toLowerCase()}) — a deterministic quality score, which ranks a list and forecasts nothing.`;

  switch (verdict) {
    case "STRONG_EVIDENCE":
      return `Every deterministic condition the engine checks currently holds for ${where}. ${quality} That is the highest state the engine offers, and it is still a candidate to review rather than an instruction.`;

    case "PROMISING_NEEDS_CONFIRMATION":
      return `The confirmation layer found its required evidence at this level on ${where}, but the analysis has not been promoted — another rule is still holding it back. ${quality} Evidence is not approval.`;

    case "CONTRADICTED":
      return `The market has answered at this level on ${where}, and in the wrong direction: a primary signal fired against the setup. ${quality} This is opposing evidence, not missing evidence.`;

    case "INSUFFICIENT_DATA":
      return `${where} was analysed and scored, but no setup was tracked for it, so no levels or confirmation evidence were recorded. ${quality} There is enough here to judge the context and not enough to review a trade.`;

    case "MIXED_EVIDENCE":
      return `The setup on ${where} has structure worth reading, but the evidence is not settled — some of what the engine checks supports it and some does not. ${quality}`;
  }
}

/** Categories the engine scored well, in its own words. */
function strengthsFor(context: CoachContext): CoachSection {
  const points: string[] = [];

  for (const category of context.quality.breakdown) {
    if (category.max > 0 && category.score / category.max >= STRONG_CATEGORY) {
      points.push(`${readable(category.category)}: ${category.reason}`);
    }
  }

  for (const evidence of context.confirmation.evidence) {
    if (evidence.kind === "PRESENT") points.push(`${evidence.title}. ${evidence.detail}`);
  }

  const levels = context.levels;
  if (levels && !levels.riskRewardIsSynthetic && levels.riskReward >= GOOD_RR) {
    points.push(
      `Reward is measured against structure at 1:${levels.riskReward.toFixed(1)}, above the ${GOOD_RR}:1 the engine treats as good.`,
    );
  }

  return { title: "What looks good", points };
}

/**
 * Where the evidence is thin or points the other way.
 *
 * Missing and contradicting evidence are kept apart in the wording, because
 * they are different claims: one says nobody has answered yet, the other says
 * the answer was no.
 */
function concernsFor(context: CoachContext): CoachSection {
  const points: string[] = [];

  for (const category of context.quality.breakdown) {
    if (category.max > 0 && category.score / category.max <= WEAK_CATEGORY) {
      points.push(`${readable(category.category)}: ${category.reason}`);
    }
  }

  for (const evidence of context.confirmation.evidence) {
    if (evidence.kind === "CONTRADICTING") {
      points.push(`Against the setup — ${evidence.title.toLowerCase()}. ${evidence.detail}`);
    } else if (evidence.kind === "MISSING") {
      points.push(`Not established — ${evidence.title.toLowerCase()}. ${evidence.detail}`);
    }
  }

  const levels = context.levels;
  if (levels?.riskRewardIsSynthetic) {
    points.push(
      "The reward could not be measured against structure: no target far enough above the entry exists on this chart, so the ratio shown is a fallback rather than a measurement. Treat it as unmeasured.",
    );
  } else if (levels && levels.riskReward < MIN_ACCEPTABLE_RR) {
    points.push(
      `Measured reward is 1:${levels.riskReward.toFixed(1)}, below the ${MIN_ACCEPTABLE_RR}:1 the engine treats as the minimum worth taking.`,
    );
  }

  if (context.market.mtfAgreement === "MIXED") {
    points.push(
      "The higher timeframe gives no clear direction to lean on, so this setup is being read on its own timeframe alone.",
    );
  }

  return { title: "What concerns me", points };
}

/** Phase C's semantics, restated for a reader. No new confirmation system. */
function confirmationReviewFor(context: CoachContext): CoachSection {
  const { status, explanation } = context.confirmation;
  const points: string[] = [];

  if (status === null) {
    points.push("No confirmation evidence was recorded for this candidate.");
    return { title: "Confirmation", points };
  }

  points.push(
    status === "PRESENT"
      ? "Confirmation is PRESENT: the market has acted at this level, on more than one piece of evidence."
      : status === "CONTRADICTED"
        ? "Confirmation is CONTRADICTED: a primary signal fired against the setup. That is opposing evidence, and it is the one state that ends a setup rather than delaying it."
        : "Confirmation is NOT_PRESENT: the market has not answered here yet, or the evidence is too thin to rest on. An absence is not a refutation.",
  );

  if (explanation) points.push(explanation);

  const present = context.confirmation.evidence.filter((e) => e.kind === "PRESENT").length;
  const missing = context.confirmation.evidence.filter((e) => e.kind === "MISSING").length;
  const against = context.confirmation.evidence.filter((e) => e.kind === "CONTRADICTING").length;

  points.push(
    `Evidence recorded: ${present} supporting, ${missing} not established, ${against} against.`,
  );

  return { title: "Confirmation", points };
}

/** The levels, discussed but never altered. */
function riskRewardReviewFor(context: CoachContext): CoachSection {
  const levels = context.levels;
  if (!levels) {
    return {
      title: "Risk and reward",
      points: [
        "No levels were recorded for this candidate, because no setup was tracked for it. SpotLens will not reconstruct an entry, stop or target after the fact — a level worked out from later candles is not the level that was on offer.",
      ],
    };
  }

  const points: string[] = [];
  if (levels.entryReason) points.push(`Entry — ${levels.entryReason}`);
  if (levels.stopLossReason) points.push(`Stop — ${levels.stopLossReason}`);

  points.push(
    levels.riskRewardIsSynthetic
      ? "Reward is not measurable against structure here. The engine found no target at least one R away, so the ratio is the fallback ladder's own constant and not something the chart supports. It should not be compared against a measured ratio."
      : `Reward is measured against structure at 1:${levels.riskReward.toFixed(1)}.${levels.riskRewardReason ? ` ${levels.riskRewardReason}` : ""}`,
  );

  for (const target of levels.takeProfits) {
    if (target.reason) points.push(`${target.label} — ${target.reason}`);
  }

  points.push(
    "These are SpotLens's numbers. This review discusses them and does not replace them — if you disagree with a level, that is a reason to look at the chart, not to take a different number from here.",
  );

  return { title: "Risk and reward", points };
}

/** What the engine itself says would end the setup. Nothing invented. */
function invalidationReviewFor(context: CoachContext): CoachSection {
  const points: string[] = [];

  if (context.invalidationReason) {
    points.push(`This setup has already been invalidated: ${context.invalidationReason}`);
    return { title: "What would invalidate it", points };
  }

  points.push(
    "Confirmation becoming CONTRADICTED ends it — a primary signal firing against the setup: the support zone closed through, local structure breaking down, or the zone rejecting price downward.",
  );

  if (context.levels) {
    points.push(
      `Price closing below the stop at ${context.levels.stopLoss} is where the engine's premise for this entry stops holding.`,
    );
  }

  points.push(
    "The entry no longer resting on this level also ends it: the engine re-anchors to a different support zone, which closes this setup and opens a separate one.",
  );

  return { title: "What would invalidate it", points };
}

/**
 * What to look at on the chart.
 *
 * Educational, and deliberately phrased as questions to answer rather than
 * conditions to act on. "Check whether volume supports the move" teaches a
 * reader to look; "buy when volume supports the move" is a trading instruction,
 * and this section must never become one.
 */
function chartChecksFor(context: CoachContext): CoachSection {
  const points: string[] = [
    "Is price still respecting the zone this setup rests on, or has it been left behind?",
    "Does the most recent closed candle still support the reading above — or has it changed the picture?",
  ];

  if (context.confirmation.status === "NOT_PRESENT") {
    points.push("What would have to happen at this level for the missing evidence to appear?");
  }
  if (context.market.mtfAgreement) {
    points.push("Does the higher timeframe still look the way it did when this was recorded?");
  }
  if (context.levels?.riskRewardIsSynthetic) {
    points.push(
      "Is there a structural level above the entry that the engine could not see — and if not, what does that say about the reward on offer?",
    );
  }

  points.push("What would you need to see before this stopped being worth watching?");

  return { title: "What I would verify on the chart", points };
}

function readable(category: string): string {
  const spaced = category
    .replace(/([A-Z])/g, " $1")
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The whole deterministic review.
 *
 * Exported separately from the provider so the same function can be used as the
 * shipped provider, as a fallback when another provider fails, and as the
 * fixture every test reads.
 */
export function buildDeterministicReview(context: CoachContext): CoachReview {
  const verdict = verdictFor(context);

  return {
    verdict,
    summary: summaryFor(context, verdict),
    strengths: strengthsFor(context),
    concerns: concernsFor(context),
    confirmationReview: confirmationReviewFor(context),
    riskRewardReview: riskRewardReviewFor(context),
    invalidationReview: invalidationReviewFor(context),
    chartChecks: chartChecksFor(context),
    providerId: "deterministic",
  };
}
