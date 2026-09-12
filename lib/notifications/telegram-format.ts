import { isPrimarySignal, type ConfirmationSignalType } from "@/lib/analysis/confirmation";
import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";

import type { NotificationEvent, NotificationEventType, SetupFacts } from "./types";

/**
 * Telegram MarkdownV2 rendering.
 *
 * MarkdownV2 rather than HTML because its escaping rule is a fixed character
 * set that can be tested exhaustively, where HTML escaping tends to grow
 * exceptions. The cost is that the set is large and unforgiving — an unescaped
 * `.` in a price will make Telegram reject the whole message with a 400 — so
 * every dynamic value goes through `escape` without exception.
 *
 * This file presents facts. It does not produce any of them: every price, ratio
 * and score here is read off the immutable snapshot the engine wrote, and there
 * is no arithmetic in this module beyond choosing how many decimal places to
 * print.
 */

/**
 * The characters MarkdownV2 reserves. Straight from Telegram's specification;
 * missing one does not corrupt the formatting, it fails the send outright.
 */
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/**
 * Escapes a value for MarkdownV2.
 *
 * Applied to every interpolated value, including ones that "cannot" contain
 * markup: an asset symbol comes from a curated list today, but a formatter that
 * only escapes the fields someone remembered is one schema change away from
 * being an injection point.
 */
export function escape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value).replace(RESERVED, (char) => `\\${char}`);
}

// --- human vocabulary ------------------------------------------------------

/**
 * The titles a person reads.
 *
 * Deliberately separate from `NotificationEventType`, which is the vocabulary
 * the database and the code use. Renaming an enum to make a message read better
 * would mean every stored row disagreeing with every new one; renaming the
 * presentation costs nothing.
 */
export const TELEGRAM_TITLES: Record<NotificationEventType, string> = {
  SETUP_DETECTED: "🟢 Potential setup",
  CONFIRMATION_DETECTED: "🔵 Confirmation evidence",
  SETUP_INVALIDATED: "🔴 Setup invalidated",
  STRUCTURE_CHANGED: "🟠 Structure signal",
  DAILY_SUMMARY: "📊 Daily summary",
  SYSTEM_ERROR: "⚠️ Scanner error",
};

/** A replacement is not an invalidation, and must not wear its title. */
export const REPLACEMENT_TITLE = "🔄 Setup re-anchored";

/**
 * Last line of defence against an enum reaching a reader.
 *
 * Every known value has an entry in one of the tables below; this turns
 * anything that does not — a value added later, a row written by an older
 * version — into words rather than `WAITING_CONFIRMATION`.
 */
function humanise(value: string): string {
  const words = value.toLowerCase().replace(/_/g, " ").trim();
  return words.length === 0 ? "—" : words[0].toUpperCase() + words.slice(1);
}

function labelFrom(table: Record<string, string>, value: string): string {
  return table[value] ?? humanise(value);
}

/** Where a setup stood in its lifecycle. */
const LIFECYCLE_LABELS: Record<string, string> = {
  SETUP_FORMING: "Forming — price had not reached the level",
  WAITING_CONFIRMATION: "Waiting for confirmation",
  CONFIRMATION_DETECTED: "Confirmation evidence present",
  POTENTIAL_SETUP: "Potential setup",
  INVALIDATED: "Invalidated",
};

/** The engine's own verdict on the analysis. */
const ANALYSIS_LABELS: Record<string, string> = {
  POTENTIAL_SETUP: "Potential setup",
  WAIT_FOR_CONFIRMATION: "Wait for confirmation",
  HIGH_RISK: "High risk",
  AVOID: "Avoid",
};

const TREND_LABELS: Record<string, string> = {
  BULLISH: "Bullish",
  BEARISH: "Bearish",
  SIDEWAYS: "Sideways",
};

const MTF_LABELS: Record<string, string> = {
  ALIGNED_BULLISH: "Aligned bullish",
  ALIGNED_BEARISH: "Aligned bearish",
  PULLBACK_IN_UPTREND: "Pullback in an uptrend",
  COUNTER_TREND_BOUNCE: "Counter-trend bounce",
  MIXED: "Mixed",
};

const REGIME_DIRECTION_LABELS: Record<string, string> = {
  TRENDING_UP: "Trending up",
  TRENDING_DOWN: "Trending down",
  RANGE: "Range",
  UNCLEAR: "Unclear",
};

const REGIME_VOLATILITY_LABELS: Record<string, string> = {
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low",
};

/** A price, at the precision the rest of the app uses, escaped. */
function price(value: number | null): string {
  if (value === null) return "—";
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  return escape(value.toFixed(decimals).replace(/\.?0+$/, ""));
}

/** A heading that is already escaped, so callers cannot forget. */
function bold(text: string): string {
  return `*${escape(text)}*`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * When something happened, as a person would say it.
 *
 * Built by hand from the UTC parts rather than through `toLocaleString`, for
 * two reasons: a locale-dependent string would make the same event render
 * differently on two machines, and the scanner's whole vocabulary is UTC
 * already. The input is always the event's own timestamp — never a clock — so
 * re-rendering a stored event a year later produces the identical line.
 */
function clock(at: number): string {
  const d = new Date(at);
  const day = d.getUTCDate();
  const month = MONTHS[d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month}, ${hh}:${mm} UTC`;
}

/**
 * The line every market-facing message ends on.
 *
 * Not decoration. The product's whole position is that it analyses and the
 * person decides, and a message that arrives on a phone is exactly where that
 * is easiest to forget.
 */
function footer(): string {
  return `_${escape(ANALYSIS_DISCLAIMER)}_`;
}

/**
 * Title block: the emoji headline, then the market on its own line.
 *
 * The emoji is split off and left unescaped — it is not markup and not in
 * MarkdownV2's reserved set — while the words go through `bold`, which escapes.
 */
function header(event: NotificationEvent, title: string): string[] {
  const [emoji, ...words] = title.split(" ");
  const where = [event.asset, event.timeframe].filter(Boolean).map(String);

  const lines = [`${emoji} ${bold(words.join(" "))}`];
  if (where.length > 0) lines.push(escape(where.join(" · ")));
  return lines;
}

// --- shared blocks ---------------------------------------------------------

/**
 * Quality, reward, environment: the four lines that decide whether the rest is
 * worth reading.
 *
 * "Quality", never "probability". The score orders a list; it does not predict
 * an outcome, and a percentage sign here would say that it does.
 */
function summaryBlock(setup: SetupFacts): string[] {
  const lines = [
    `${bold("Quality")}: ${escape(setup.score)}/100 · ${escape(humanise(setup.scoreGrade))}`,
    rewardLine(setup),
  ];

  if (setup.regime) {
    lines.push(
      `${bold("Regime")}: ${escape(
        labelFrom(REGIME_DIRECTION_LABELS, setup.regime.direction),
      )} · ${escape(labelFrom(REGIME_VOLATILITY_LABELS, setup.regime.volatility))} volatility`,
    );
  }

  lines.push(`${bold("Trend")}: ${escape(labelFrom(TREND_LABELS, setup.trend))}`);

  if (setup.mtfAgreement) {
    lines.push(`${bold("HTF")}: ${escape(labelFrom(MTF_LABELS, setup.mtfAgreement))}`);
  }

  return lines;
}

function rewardLine(setup: SetupFacts): string {
  if (setup.riskRewardIsSynthetic) {
    // Phase A's rule, carried into the message. Reporting "1:2.5" without this
    // would present the fallback ladder's own constant as a measurement.
    return `${bold("R:R")}: not measurable — no structural target far enough above the entry`;
  }
  return `${bold("R:R")}: 1:${escape(setup.riskReward.toFixed(1))}`;
}

/**
 * The levels, one labelled block each.
 *
 * The support zone is deliberately absent: the entry zone *is* the support
 * zone by construction — `entry.low === sourceZone.low` in the engine — so
 * printing both was the same two numbers under two headings.
 */
function levelBlocks(setup: SetupFacts): string[] {
  const targets = [setup.takeProfit1, setup.takeProfit2].filter(
    (value): value is number => value !== null,
  );

  return [
    "",
    bold("ENTRY"),
    `${price(setup.entryLow)} – ${price(setup.entryHigh)}`,
    "",
    bold("STOP"),
    price(setup.stopLoss),
    "",
    bold("TARGETS"),
    ...(targets.length > 0 ? targets.map((t) => price(t)) : [escape("None measured.")]),
  ];
}

/**
 * Confirmation evidence, split by what it actually says.
 *
 * Three groups rather than a single list with mixed marks. A `✕` under a
 * heading that reads "Confirmation" invites the reader to see a refutation
 * where the engine saw an absence — and the difference between those two is the
 * whole reason `NOT_PRESENT` and `CONTRADICTED` are separate statuses.
 *
 * A negative *primary* signal is opposing evidence and gets its own heading. A
 * negative supporting signal — thin volume, in practice — is missing evidence,
 * because nobody showing up is not proof that the level failed.
 */
function confirmationBlock(setup: SetupFacts): string[] {
  if (setup.confirmationSignals.length === 0) return [];

  const present: string[] = [];
  const missing: string[] = [];
  const opposing: string[] = [];

  for (const signal of setup.confirmationSignals) {
    const primary = isPrimarySignal(signal.type as ConfirmationSignalType);

    if (signal.signal === "positive") present.push(`✓ ${escape(signal.title)}`);
    else if (signal.signal === "negative" && primary) opposing.push(`✕ ${escape(signal.title)}`);
    else missing.push(`• ${escape(signal.title)}`);
  }

  const lines: string[] = ["", bold("CONFIRMATION")];

  if (present.length > 0) lines.push(...present);
  else lines.push(escape("No supporting evidence yet."));

  if (missing.length > 0) lines.push("", `${bold("Not yet")}:`, ...missing);
  if (opposing.length > 0) lines.push("", `${bold("Against")}:`, ...opposing);

  return lines;
}

/** The closing advice every setup message carries. */
function reviewFooter(extra?: string): string[] {
  return [
    "",
    escape(`⚠️ ${extra ? `${extra} ` : ""}Review the chart before deciding. ${SPOT_ONLY_NOTE}`),
    "",
    footer(),
  ];
}

// --- messages --------------------------------------------------------------

export function formatPotentialSetup(event: NotificationEvent): string {
  const setup = event.setup!;

  return [
    ...header(event, TELEGRAM_TITLES.SETUP_DETECTED),
    "",
    ...summaryBlock(setup),
    ...levelBlocks(setup),
    ...confirmationBlock(setup),
    "",
    bold("WHY"),
    escape(setup.statusReason),
    ...reviewFooter(),
  ].join("\n");
}

/**
 * Confirmation evidence — deliberately not "confirmation detected".
 *
 * Reaching this lifecycle state means something precise: the confirmation layer
 * found its evidence *and* the analysis was not promoted to a potential setup,
 * because `lifecycleStatusFor` tests POTENTIAL_SETUP first. So evidence exists
 * and a different rule is still holding the setup back — both halves are true
 * at once, and a message that announces only the first half reads as an
 * approval the engine never gave.
 *
 * The old `Status:` line is gone. It printed `TrackedSetup.analysisStatus`,
 * which is written once at creation and never updated, so it could report a
 * verdict from days earlier as though it were current. What replaces it says
 * which is which: "Held at" is the fact this transition proves, "At creation"
 * is the frozen snapshot value, labelled as frozen.
 */
export function formatConfirmation(event: NotificationEvent): string {
  const setup = event.setup!;

  return [
    ...header(event, TELEGRAM_TITLES.CONFIRMATION_DETECTED),
    "",
    ...summaryBlock(setup),
    "",
    escape(
      "The confirmation layer found supporting evidence, but the analysis has not been promoted — another rule is still holding this setup back. Evidence is not approval.",
    ),
    ...levelBlocks(setup),
    ...confirmationBlock(setup),
    "",
    bold("HELD AT"),
    escape("Not promoted to a potential setup."),
    "",
    bold("AT CREATION"),
    `${escape(labelFrom(ANALYSIS_LABELS, setup.analysisStatus))}${
      setup.statusReason ? escape(` — ${setup.statusReason}`) : ""
    }`,
    ...reviewFooter(),
  ].join("\n");
}

/**
 * A level that was being waited on has failed.
 *
 * A replacement is routed away from Telegram before it reaches here, but the
 * branch exists anyway: a formatter that produces the wrong words when called
 * with the wrong facts is a bug waiting for the routing rules to change.
 */
export function formatInvalidation(event: NotificationEvent): string {
  const setup = event.setup!;

  if (setup.isReplacement) return formatReplacement(event);

  return [
    ...header(event, TELEGRAM_TITLES.SETUP_INVALIDATED),
    "",
    `${bold("Was")}: ${escape(labelFrom(LIFECYCLE_LABELS, setup.previousStatus ?? "—"))}`,
    "",
    bold("REASON"),
    escape(setup.invalidationReason ?? setup.statusReason),
    "",
    `${bold("Invalidation level")}: ${price(setup.supportLow)} – ${price(setup.supportHigh)}`,
    `${bold("Seen at")}: ${escape(clock(event.timestamp))}`,
    "",
    escape("This setup is no longer valid. No trade was placed — SpotLens never places one."),
    "",
    footer(),
  ].join("\n");
}

/**
 * The engine moved its entry to a different support zone.
 *
 * Bookkeeping, not a market event: a replacement setup was created in the same
 * pass, on an adjacent level, and nothing about the old one failed. In-app
 * only, which is why this says what happened rather than sounding an alarm.
 */
export function formatReplacement(event: NotificationEvent): string {
  const setup = event.setup!;

  const newZone =
    setup.replacementZoneLow !== null && setup.replacementZoneHigh !== null
      ? `${price(setup.replacementZoneLow)} – ${price(setup.replacementZoneHigh)}`
      : escape("recorded with the replacement setup");

  return [
    ...header(event, REPLACEMENT_TITLE),
    "",
    escape(
      "The engine anchored to a different support zone, so the previous setup was closed and replaced. Nothing about the market invalidated it.",
    ),
    "",
    `${bold("Previous zone")}: ${price(setup.supportLow)} – ${price(setup.supportHigh)}`,
    `${bold("New zone")}: ${newZone}`,
    `${bold("Seen at")}: ${escape(clock(event.timestamp))}`,
    "",
    escape("No trade was placed — SpotLens never places one."),
    "",
    footer(),
  ].join("\n");
}

/**
 * One piece of structural evidence appeared at a tracked level.
 *
 * In-app only. It is not "structure changed": a negative structural signal is a
 * primary signal, so it makes confirmation CONTRADICTED and arrives as an
 * invalidation instead — meaning this message can only ever carry evidence in
 * the setup's favour, and has fired on setups being seen for the first time.
 */
export function formatStructureChange(event: NotificationEvent): string {
  const setup = event.setup!;
  const structural = setup.confirmationSignals.filter(
    (s) => s.type === "STRUCTURE_BREAK" || s.type === "RECLAIM",
  );

  return [
    ...header(event, TELEGRAM_TITLES.STRUCTURE_CHANGED),
    "",
    ...structural.map((s) => `• ${escape(s.title)}`),
    "",
    `${bold("Level")}: ${price(setup.supportLow)} – ${price(setup.supportHigh)}`,
    `${bold("Lifecycle")}: ${escape(labelFrom(LIFECYCLE_LABELS, setup.lifecycleStatus))}`,
    "",
    escape("A signal at the level, not a confirmation and not an approval."),
    "",
    footer(),
  ].join("\n");
}

export function formatDailySummary(event: NotificationEvent): string {
  const s = event.summary!;

  const lines = [
    ...header(event, TELEGRAM_TITLES.DAILY_SUMMARY),
    escape(s.date),
    "",
    `${bold("Markets scanned")}: ${escape(s.marketsScanned)} across ${escape(s.runs)} ${s.runs === 1 ? "pass" : "passes"}`,
    ...s.analysesByTimeframe.map(
      (t) => `${bold(t.timeframe)}: ${escape(t.count)} ${t.count === 1 ? "analysis" : "analyses"}`,
    ),
    "",
    bold("WHAT THE MARKETS SAID"),
    `Potential setups: ${escape(s.potentialSetups)}`,
    `Waiting: ${escape(s.waiting)}`,
    `High risk: ${escape(s.highRisk)}`,
    `Avoid: ${escape(s.avoided)}`,
    "",
    bold("WHAT CHANGED"),
    `Setups created: ${escape(s.setupsCreated)}`,
    `Confirmations: ${escape(s.confirmations)}`,
    `Invalidations: ${escape(s.invalidations)}`,
  ];

  if (s.topRanked.length > 0) {
    lines.push("", bold("BEST RANKED"));
    for (const r of s.topRanked) {
      lines.push(
        `${escape(r.symbol)} ${escape(r.timeframe)} — ${escape(
          labelFrom(ANALYSIS_LABELS, r.analysisStatus),
        )}${r.score === null ? "" : `, quality ${escape(r.score)}/100`}`,
      );
    }
  }

  if (s.failures > 0) {
    lines.push("", `${bold("Failures")}: ${escape(s.failures)}`);
  }

  // Said plainly, because a day of nothing is the common case and the one most
  // likely to be misread as the tool being broken.
  if (s.potentialSetups === 0) {
    lines.push("", escape("No market met every condition today. That is a normal outcome."));
  }

  lines.push("", footer());

  return lines.join("\n");
}

export function formatSystemError(event: NotificationEvent): string {
  const e = event.systemError!;

  return [
    ...header(event, TELEGRAM_TITLES.SYSTEM_ERROR),
    "",
    `${bold("Category")}: ${escape(humanise(e.category))}`,
    ...(e.affectedMarkets > 1 ? [`${bold("Affected markets")}: ${escape(e.affectedMarkets)}`] : []),
    "",
    // Already sanitised upstream by the scanner's failure classifier; escaped
    // here as well, because a formatter should not depend on its caller.
    escape(e.message),
    "",
    `${bold("At")}: ${escape(clock(event.timestamp))}`,
  ].join("\n");
}

/** Dispatches on event type. The single entry point a provider should call. */
export function formatForTelegram(event: NotificationEvent): string {
  switch (event.type) {
    case "SETUP_DETECTED":
      return formatPotentialSetup(event);
    case "CONFIRMATION_DETECTED":
      return formatConfirmation(event);
    case "SETUP_INVALIDATED":
      return formatInvalidation(event);
    case "STRUCTURE_CHANGED":
      return formatStructureChange(event);
    case "DAILY_SUMMARY":
      return formatDailySummary(event);
    case "SYSTEM_ERROR":
      return formatSystemError(event);
  }
}

/** The connection test message. Deliberately says nothing about a market. */
export function formatConnectionTest(): string {
  return [
    `✅ ${bold("SpotLens Telegram connection test successful")}`,
    "",
    escape("Notifications for this account will arrive here."),
  ].join("\n");
}
