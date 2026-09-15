import type { ConfirmationSignalType } from "@/lib/analysis/confirmation";
import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import { escape } from "@/lib/notifications";

import type { ConfirmationAlert } from "./types";

/**
 * How a confirmation alert reads.
 *
 * Presents facts and produces none. Every price, ratio and score arrives on
 * `SetupNumbers`, read from the immutable `TrackedSetup` snapshot; there is no
 * arithmetic here beyond choosing decimal places. The evidence list is the
 * deterministic engine's own output, in the engine's own words.
 *
 * MarkdownV2, and `escape` is imported from the existing formatter rather than
 * reimplemented — one escaping rule for both bots, tested exhaustively in one
 * place. An unescaped `.` in a price makes Telegram reject the whole message.
 *
 * ## The one thing this must never do
 *
 * Say, or imply, that the reader should act. Confirmation being present is the
 * engine finishing a check, not an instruction, and a message that arrives on a
 * phone is exactly where that is easiest to forget. Every template below ends
 * on a review prompt and the shared disclaimers, and the words "buy", "enter",
 * "execute" and their relatives appear nowhere — which `format.test.ts` asserts
 * mechanically rather than trusting.
 */

/** The titles a person reads. Separate from the enum, as with the main bot. */
export const CONFIRMATION_TITLES = {
  DEVELOPING: "🟡 Confirmation developing",
  REACHED: "🟢 Confirmation reached",
} as const;

/** Human names for the engine's signal types, for the "not yet" list. */
const SIGNAL_LABELS: Record<ConfirmationSignalType, string> = {
  BULLISH_REJECTION: "Bullish rejection at the zone",
  HIGHER_LOW: "Higher low",
  STRUCTURE_BREAK: "Local structure break",
  RECLAIM: "Zone reclaim",
  VOLUME_CONFIRMATION: "Volume confirmation",
};

const LIFECYCLE_LABELS: Record<string, string> = {
  SETUP_FORMING: "Forming — price has not reached the level",
  WAITING_CONFIRMATION: "Waiting for confirmation",
  CONFIRMATION_DETECTED: "Confirmation evidence present",
  POTENTIAL_SETUP: "Potential setup",
  INVALIDATED: "Invalidated",
};

/**
 * The stored numbers a message may quote.
 *
 * Read from the `Decimal(24,8)` columns of the tracked setup, never
 * recomputed and never taken from a live analysis: the snapshot is what was
 * actually on offer when this setup was created, and quoting anything else
 * would show a different number than every other surface in the product.
 */
export interface SetupNumbers {
  entryLow: number;
  entryHigh: number;
  stopLoss: number;
  score: number;
  riskReward: number;
  /** Phase A's qualifier. An unmeasured reward must never be printed as measured. */
  riskRewardIsSynthetic: boolean;
}

/** A price at the precision the rest of the app uses, escaped. */
function price(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return escape(value.toFixed(decimals).replace(/\.?0+$/, ""));
}

function bold(text: string): string {
  return `*${escape(text)}*`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The candle this was judged on, as a person would say it.
 *
 * Built from the UTC parts by hand: a locale-dependent string would render the
 * same event differently on two machines, and the scanner's whole vocabulary is
 * UTC. The input is always the engine's own `evaluatedAt` — the close time of a
 * candle that has finished — never a clock, so re-rendering a stored alert a
 * year later produces the identical line.
 */
function clock(at: number): string {
  const d = new Date(at);
  return (
    `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ` +
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
  );
}

function rewardLine(numbers: SetupNumbers): string {
  if (numbers.riskRewardIsSynthetic) {
    return `${bold("R:R")}: not measurable — no structural target far enough above the entry`;
  }
  return `${bold("R:R")}: 1:${escape(numbers.riskReward.toFixed(1))}`;
}

/** Levels and quality, identical in both messages so they can be compared at a glance. */
function numbersBlock(numbers: SetupNumbers | null): string[] {
  if (!numbers) {
    // A tracked setup always has a snapshot, so this is defensive rather than
    // expected — and saying so is better than printing a zero.
    return ["", escape("Levels are not available for this setup.")];
  }

  return [
    "",
    `${bold("Entry zone")}: ${price(numbers.entryLow)} – ${price(numbers.entryHigh)}`,
    `${bold("Invalidation")}: ${price(numbers.stopLoss)}`,
    `${bold("Quality")}: ${escape(numbers.score)}/100`,
    rewardLine(numbers),
  ];
}

function footer(extra: string): string[] {
  return [
    "",
    escape(extra),
    "",
    escape(`⚠️ ${SPOT_ONLY_NOTE}`),
    "",
    `_${escape(ANALYSIS_DISCLAIMER)}_`,
  ];
}

function header(alert: ConfirmationAlert, title: string): string[] {
  const [emoji, ...words] = title.split(" ");
  return [`${emoji} ${bold(words.join(" "))}`, escape(`${alert.symbol} · ${alert.timeframe}`)];
}

/**
 * Evidence has appeared, and is not yet sufficient.
 *
 * The three groups are kept apart on purpose, for the same reason the main
 * bot's confirmation block does it: a reader seeing one undifferentiated list
 * cannot tell what just happened from what was already true, and "not yet" must
 * not read as a refutation. Nothing the engine reported negative and primary
 * can reach here at all — that is a contradiction, and the watcher refuses it.
 */
export function formatDeveloping(alert: ConfirmationAlert, numbers: SetupNumbers | null): string {
  const lines = [...header(alert, CONFIRMATION_TITLES.DEVELOPING), ""];

  lines.push(bold("NEW EVIDENCE"));
  for (const signal of alert.newEvidence) lines.push(`✓ ${escape(signal.title)}`);

  if (alert.knownEvidence.length > 0) {
    lines.push("", `${bold("Already present")}:`);
    for (const signal of alert.knownEvidence) lines.push(`✓ ${escape(signal.title)}`);
  }

  if (alert.missingEvidence.length > 0) {
    lines.push("", `${bold("Not yet")}:`);
    for (const type of alert.missingEvidence) lines.push(`○ ${escape(SIGNAL_LABELS[type])}`);
  }

  if (alert.caveats.length > 0) {
    // An absence of corroboration, stated as such. Thin volume does not refute
    // a rejection wick that visibly happened; it leaves it unaccompanied.
    lines.push("", `${bold("Worth noting")}:`);
    for (const signal of alert.caveats) lines.push(`• ${escape(signal.title)}`);
  }

  lines.push(
    ...numbersBlock(numbers),
    "",
    `${bold("Lifecycle")}: ${escape(LIFECYCLE_LABELS[alert.lifecycleStatus] ?? alert.lifecycleStatus)}`,
    `${bold("Judged on the candle closing")}: ${escape(clock(alert.evaluatedAt))}`,
    ...footer(
      "The deterministic confirmation layer does not have what it requires yet. Evidence is " +
        "not approval — review this setup in SpotLens before deciding anything.",
    ),
  );

  return lines.join("\n");
}

/**
 * The engine's confirmation check has everything it requires.
 *
 * Says precisely that, and no more. It is not a status, it is not a promotion,
 * and it is certainly not an instruction: the analysis may still be held back
 * by any of the rules that run after confirmation, and the reader's decision is
 * the only thing that ever puts money at risk — SpotLens has no order path.
 */
export function formatReached(alert: ConfirmationAlert, numbers: SetupNumbers | null): string {
  const evidence = [...alert.knownEvidence, ...alert.newEvidence];

  const lines = [...header(alert, CONFIRMATION_TITLES.REACHED), "", bold("CONFIRMATION EVIDENCE")];

  for (const signal of evidence) lines.push(`✓ ${escape(signal.title)}`);

  if (alert.caveats.length > 0) {
    lines.push("", `${bold("Worth noting")}:`);
    for (const signal of alert.caveats) lines.push(`• ${escape(signal.title)}`);
  }

  lines.push(
    ...numbersBlock(numbers),
    "",
    `${bold("Lifecycle")}: ${escape(LIFECYCLE_LABELS[alert.lifecycleStatus] ?? alert.lifecycleStatus)}`,
    `${bold("Judged on the candle closing")}: ${escape(clock(alert.evaluatedAt))}`,
    ...footer(
      "The deterministic confirmation layer now has the evidence it requires. That is a check " +
        "finishing, not a recommendation — review this setup in SpotLens, and the decision " +
        "stays yours.",
    ),
  );

  return lines.join("\n");
}

/** Dispatches on level. The single entry point the delivery service calls. */
export function formatConfirmationAlert(
  alert: ConfirmationAlert,
  numbers: SetupNumbers | null,
): string {
  return alert.level === "REACHED"
    ? formatReached(alert, numbers)
    : formatDeveloping(alert, numbers);
}

/** The short form for the in-app list. No escaping — React renders it as text. */
export function renderConfirmationInApp(
  alert: ConfirmationAlert,
  numbers: SetupNumbers | null,
): { title: string; body: string } {
  const where = `${alert.symbol} ${alert.timeframe}`;
  const quality = numbers ? ` Quality ${numbers.score}/100.` : "";

  if (alert.level === "REACHED") {
    const evidence = [...alert.knownEvidence, ...alert.newEvidence].map((s) => s.title).join("; ");
    return {
      title: `🟩 Confirmation reached — ${where}`,
      body:
        `${evidence}.${quality} The deterministic confirmation check has what it requires. ` +
        "Review the setup before deciding.",
    };
  }

  return {
    title: `🟡 Confirmation developing — ${where}`,
    body:
      `New: ${alert.newEvidence.map((s) => s.title).join("; ")}.${quality} ` +
      "Not yet sufficient — evidence is not approval.",
  };
}

/** The confirmation bot's connection test. Says nothing about any market. */
export function formatConfirmationConnectionTest(): string {
  return [
    `✅ ${bold("SpotLens confirmation alerts connected")}`,
    "",
    escape(
      "Confirmation evidence for the setups SpotLens is tracking will arrive here. Lifecycle " +
        "notifications stay on the main SpotLens bot.",
    ),
    "",
    escape(SPOT_ONLY_NOTE),
  ].join("\n");
}
