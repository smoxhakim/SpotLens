import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";

import type { NotificationEvent, SetupFacts } from "./types";

/**
 * Telegram MarkdownV2 rendering.
 *
 * MarkdownV2 rather than HTML because its escaping rule is a fixed character
 * set that can be tested exhaustively, where HTML escaping tends to grow
 * exceptions. The cost is that the set is large and unforgiving — an unescaped
 * `.` in a price will make Telegram reject the whole message with a 400 — so
 * every dynamic value goes through `escape` without exception.
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

/**
 * The line every setup message ends on.
 *
 * Not decoration. The product's whole position is that it analyses and the
 * person decides, and a message that arrives on a phone is exactly where that
 * is easiest to forget.
 */
function footer(): string {
  return `_${escape(ANALYSIS_DISCLAIMER)}_`;
}

function riskRewardLine(setup: SetupFacts): string {
  if (setup.riskRewardIsSynthetic) {
    // Phase A's rule, carried into the message. Reporting "1:2.5" without this
    // would present the fallback ladder's own constant as a measurement.
    return `${bold("Risk / reward")}: not measurable — no structural target far enough above the entry`;
  }
  return `${bold("Risk / reward")}: 1:${escape(setup.riskReward.toFixed(1))}`;
}

function levels(setup: SetupFacts): string[] {
  return [
    `${bold("Entry zone")}: ${price(setup.entryLow)} – ${price(setup.entryHigh)}`,
    `${bold("Stop loss")}: ${price(setup.stopLoss)}`,
    `${bold("Targets")}: ${price(setup.takeProfit1)}${
      setup.takeProfit2 === null ? "" : ` · ${price(setup.takeProfit2)}`
    }`,
    riskRewardLine(setup),
    // "Quality", never "probability". The score orders a list; it does not
    // predict an outcome, and a percentage sign here would say it does.
    `${bold("Setup quality")}: ${escape(setup.score)}/100 \\(${escape(setup.scoreGrade.toLowerCase())}\\)`,
  ];
}

function context(setup: SetupFacts): string[] {
  const lines = [
    `${bold("Trend")}: ${escape(setup.trend.toLowerCase())}`,
    `${bold("Support")}: ${price(setup.supportLow)} – ${price(setup.supportHigh)}`,
  ];

  if (setup.mtfAgreement) {
    lines.splice(
      1,
      0,
      `${bold("Higher timeframe")}: ${escape(setup.mtfAgreement.toLowerCase().replace(/_/g, " "))}`,
    );
  }

  return lines;
}

function confirmationLines(setup: SetupFacts): string[] {
  if (setup.confirmationSignals.length === 0) return [];

  const mark = (signal: string) =>
    signal === "positive" ? "✓" : signal === "negative" ? "✕" : "•";

  return [
    "",
    bold("Confirmation"),
    ...setup.confirmationSignals.map((s) => `${mark(s.signal)} ${escape(s.title)}`),
  ];
}

function header(event: NotificationEvent, label: string): string {
  return `${bold(label)} — ${escape(event.asset ?? "")} ${escape(event.timeframe ?? "")}`;
}

export function formatPotentialSetup(event: NotificationEvent): string {
  const setup = event.setup!;

  return [
    header(event, "Potential setup detected"),
    "",
    ...context(setup),
    "",
    ...levels(setup),
    ...confirmationLines(setup),
    "",
    `${bold("Why")}: ${escape(setup.statusReason)}`,
    "",
    escape(`Review the chart before deciding. ${SPOT_ONLY_NOTE}`),
    "",
    footer(),
  ].join("\n");
}

export function formatConfirmation(event: NotificationEvent): string {
  const setup = event.setup!;

  return [
    header(event, "Confirmation detected"),
    "",
    escape(
      "The deterministic confirmation layer found the evidence it requires. That is not an approval to trade — it means the market has acted at this level.",
    ),
    ...confirmationLines(setup),
    "",
    ...levels(setup),
    "",
    `${bold("Status")}: ${escape(setup.analysisStatus.toLowerCase().replace(/_/g, " "))}`,
    `${bold("Support")}: ${price(setup.supportLow)} – ${price(setup.supportHigh)}`,
    "",
    escape("Review the chart before making any decision."),
    "",
    footer(),
  ].join("\n");
}

export function formatInvalidation(event: NotificationEvent): string {
  const setup = event.setup!;

  return [
    header(event, "Setup invalidated"),
    "",
    `${bold("Was")}: ${escape((setup.previousStatus ?? "—").toLowerCase().replace(/_/g, " "))}`,
    `${bold("Reason")}: ${escape(setup.invalidationReason ?? setup.statusReason)}`,
    `${bold("Level")}: ${price(setup.supportLow)} – ${price(setup.supportHigh)}`,
    "",
    `${bold("Seen at")}: ${escape(new Date(event.timestamp).toISOString())}`,
    "",
    footer(),
  ].join("\n");
}

export function formatStructureChange(event: NotificationEvent): string {
  const setup = event.setup!;
  const structural = setup.confirmationSignals.filter(
    (s) => s.type === "STRUCTURE_BREAK" || s.type === "RECLAIM",
  );

  return [
    header(event, "Structure changed"),
    "",
    ...structural.map((s) => `• ${escape(s.title)}`),
    "",
    `${bold("Level")}: ${price(setup.supportLow)} – ${price(setup.supportHigh)}`,
    `${bold("Status")}: ${escape(setup.analysisStatus.toLowerCase().replace(/_/g, " "))}`,
    "",
    escape("Review the chart before deciding."),
    "",
    footer(),
  ].join("\n");
}

export function formatDailySummary(event: NotificationEvent): string {
  const s = event.summary!;

  const lines = [
    `${bold("Daily scanner summary")} — ${escape(s.date)}`,
    "",
    `${bold("Markets scanned")}: ${escape(s.marketsScanned)} across ${escape(s.runs)} ${s.runs === 1 ? "pass" : "passes"}`,
    ...s.analysesByTimeframe.map(
      (t) => `${bold(t.timeframe)}: ${escape(t.count)} ${t.count === 1 ? "analysis" : "analyses"}`,
    ),
    "",
    bold("What the markets said"),
    `Potential setups: ${escape(s.potentialSetups)}`,
    `Waiting: ${escape(s.waiting)}`,
    `High risk: ${escape(s.highRisk)}`,
    `Avoid: ${escape(s.avoided)}`,
    "",
    bold("What changed"),
    `Setups created: ${escape(s.setupsCreated)}`,
    `Confirmations: ${escape(s.confirmations)}`,
    `Invalidations: ${escape(s.invalidations)}`,
  ];

  if (s.topRanked.length > 0) {
    lines.push("", bold("Best ranked"));
    for (const r of s.topRanked) {
      lines.push(
        `${escape(r.symbol)} ${escape(r.timeframe)} — ${escape(
          r.analysisStatus.toLowerCase().replace(/_/g, " "),
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
    bold("Scanner error"),
    "",
    `${bold("Category")}: ${escape(e.category)}`,
    ...(e.symbol ? [`${bold("Market")}: ${escape(e.symbol)} ${escape(e.timeframe ?? "")}`] : []),
    ...(e.affectedMarkets > 1 ? [`${bold("Affected markets")}: ${escape(e.affectedMarkets)}`] : []),
    "",
    // Already sanitised upstream by the scanner's failure classifier; escaped
    // here as well, because a formatter should not depend on its caller.
    escape(e.message),
    "",
    `${bold("At")}: ${escape(new Date(event.timestamp).toISOString())}`,
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
    bold("SpotLens Telegram connection test successful"),
    "",
    escape("Notifications for this account will arrive here."),
  ].join("\n");
}
