import type { JournalDecision, JournalSkipReason } from "@/lib/journal";

/**
 * The decision surface's shared vocabulary.
 *
 * The states are `lib/journal`'s and are imported, never restated: the journal
 * owns what a decision can be and which moves are legal, and a component that
 * declared its own list would be free to offer one the service then refuses.
 * What lives here is presentation — the words on the buttons, and the sentence
 * under each one.
 */

/**
 * The three decisions a reader makes at this point, in the order they are
 * offered.
 *
 * `CANCELLED` and `CLOSED` are deliberately absent. Both describe something
 * that happened to a position afterwards — abandoning it, or finishing it —
 * and neither is a judgement about an opportunity in front of you. They are
 * reached from the journal entry, where the position already exists.
 */
export const OFFERED_DECISIONS = [
  "WATCHING",
  "SKIPPED",
  "TAKEN",
] as const satisfies readonly JournalDecision[];

export type OfferedDecision = (typeof OFFERED_DECISIONS)[number];

/**
 * What each decision means, said plainly.
 *
 * The wording for TAKEN is the load-bearing one. It records an intention and
 * nothing else — SpotLens has no order path, and a reader who thought pressing
 * it did something on an exchange would have been misled by this screen rather
 * than by the market.
 */
export const DECISION_COPY: Record<OfferedDecision, { label: string; meaning: string }> = {
  WATCHING: {
    label: "Watch",
    meaning: "Keep it on the record and come back to it. No position, no commitment.",
  },
  SKIPPED: {
    label: "Skip",
    meaning: "Pass on this one. Worth recording — the setups you turn down are half the record.",
  },
  TAKEN: {
    label: "Take",
    meaning: "You have decided to take this setup. SpotLens does not place the order; you do.",
  },
};

export const SKIP_REASON_LABELS: Record<JournalSkipReason, string> = {
  LOW_CONFIDENCE: "Not convinced by the evidence",
  POOR_RR: "Reward does not justify the risk",
  BAD_REGIME: "Wrong market environment",
  NO_CONFIRMATION: "Waiting for confirmation that has not come",
  PERSONAL_RULE: "Against one of my own rules",
  MARKET_CONDITION: "Something else about the market",
  MISSED_ENTRY: "Price has already left the entry",
  OTHER: "Another reason",
};
