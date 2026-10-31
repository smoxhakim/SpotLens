import type { BacktestMetrics } from "@/lib/backtesting";
import { BACKTEST_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import { formatPercent, formatPrice } from "@/lib/format";
import type { EngineFunnel } from "@/lib/research";

import { DEMO_TRIAL, FEE_ESTIMATE } from "./config";
import type { Coverage } from "./coverage";
import type { RuleVerdicts, TrialTradeReview } from "./trades";

/**
 * The paper-trading report, as Markdown.
 *
 * Pure: every number arrives computed — R by the journal, the metrics by the
 * backtester through research — and this only lays them out. It keeps
 * research's split: what the engine did is counted, what the trades did is
 * measured in R, and no figure combines the two.
 */
export interface TrialReportInput {
  generatedAt: number;
  from: number;
  to: number;
  coverage: Coverage;
  /** Setups first seen inside the window. Counts, not trades. */
  engine: EngineFunnel;
  notifications: readonly { type: string; count: number }[];
  /** Every journal entry decided inside the window, by its current decision. */
  decisions: readonly { decision: string; count: number }[];
  /**
   * Orders that never filled. Under the trial rules they are never Taken, so
   * they show up as a cancelled entry or a skip for a missed entry.
   */
  unfilled: { cancelled: number; skippedMissedEntry: number };
  /** Entries that hold or held a position: TAKEN and CLOSED. */
  trades: readonly TrialTradeReview[];
  /** Over the closed trades with a tracked setup, through research's own adapter. */
  outcomes: BacktestMetrics;
}

export function renderTrialReport(input: TrialReportInput): string {
  return [
    `# SpotLens demo trial report`,
    "",
    `Window: ${time(input.from)} to ${time(input.to)} · generated ${time(input.generatedAt)}`,
    "",
    terms(),
    freshness(input),
    engineSection(input),
    decisionsSection(input),
    tradesSection(input.trades),
    rulesSection(input.trades),
    resultsSection(input),
    executionSection(input.trades),
    caveats(input),
  ].join("\n");
}

// --- sections ----------------------------------------------------------------

function terms(): string {
  return [
    `## Terms`,
    "",
    `- Venue: ${DEMO_TRIAL.venue}. No real money.`,
    `- Capital: ${DEMO_TRIAL.capitalUsdt} USDT (notional) · planned loss at the stop: at most ${DEMO_TRIAL.maxRiskUsdt} USDT per trade, with ${FEE_ESTIMATE}. The fees actually charged count only where you recorded them, in the net result.`,
    `- Execution: ${DEMO_TRIAL.execution}`,
    `- ${SPOT_ONLY_NOTE}`,
    ...DEMO_TRIAL.rules.map((rule) => `- Rule: ${rule}`),
    "",
  ].join("\n");
}

function freshness({ coverage }: TrialReportInput): string {
  const lines = [
    `## 1. Market data freshness`,
    "",
    `- Successful scanner passes: ${coverage.successfulPasses} · failed: ${coverage.failedPasses}`,
    `- Longest stretch without a successful pass: ${duration(coverage.longestGapMs)}`,
  ];
  if (coverage.gaps.length === 0) {
    lines.push(`- No stretch long enough for an hourly candle to close unread.`);
  } else {
    lines.push(
      `- ${coverage.gaps.length} stretch(es) long enough for a candle to close unread. While each lasted, every analysis shown was out of date and entry-zone alerts were withheld:`,
      ...coverage.gaps.map(
        (gap) => `  - ${time(gap.from)} to ${time(gap.to)} (${duration(gap.durationMs)})`,
      ),
    );
  }
  return [...lines, ""].join("\n");
}

function engineSection({ engine, notifications }: TrialReportInput): string {
  const lines = [
    `## 2. What the engine did (counts, not trades)`,
    "",
    `- Setups first seen: ${engine.setupsDetected} · reached confirmation evidence: ${engine.reachedConfirmation} · reached potential setup: ${engine.reachedPotentialSetup}`,
    `- Invalidated or replaced: ${engine.invalidated} · still open: ${engine.stillOpen}`,
  ];
  lines.push(
    notifications.length === 0
      ? `- Notifications: none`
      : `- Notifications: ${notifications.map((n) => `${n.type} ${n.count}`).join(" · ")}`,
  );
  return [...lines, ""].join("\n");
}

function decisionsSection({ decisions, unfilled }: TrialReportInput): string {
  const total = decisions.reduce((sum, d) => sum + d.count, 0);
  return [
    `## 3. What you decided`,
    "",
    total === 0
      ? `Nothing was journaled in this window.`
      : `${total} journaled: ${decisions.map((d) => `${d.decision.toLowerCase()} ${d.count}`).join(" · ")}`,
    "",
    `Orders that never filled: ${unfilled.cancelled} cancelled · ${unfilled.skippedMissedEntry} skipped as a missed entry. Under the trial rules an unfilled order is never Taken, so it has no result and no R.`,
    "",
  ].join("\n");
}

function tradesSection(trades: readonly TrialTradeReview[]): string {
  if (trades.length === 0) {
    return [`## 4. Trades`, "", `No position was taken in this window.`, ""].join("\n");
  }

  return [
    `## 4. Trades`,
    "",
    `| # | Market | Decision | Fill | Stop | Take-profit | Exit | Exit reason | Qty | Position | Planned loss | Net | R |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|---|`,
    ...trades.map((t, i) =>
      row([
        String(i + 1),
        `${t.symbol} ${t.timeframe}`,
        t.decision.toLowerCase(),
        formatPrice(t.actualEntry),
        formatPrice(t.actualStopLoss),
        formatPrice(t.actualTakeProfit),
        formatPrice(t.actualExit),
        t.exitReason ? readable(t.exitReason) : "—",
        t.quantity === null ? "—" : String(t.quantity),
        usdt(t.positionUsdt),
        usdt(t.plannedLossUsdt),
        usdt(t.outcome?.netPnl ?? null),
        r(t.outcome?.realizedR ?? null),
      ]),
    ),
    "",
    `Position, planned loss and net are in USDT. Planned loss is the loss at the stop with ${FEE_ESTIMATE} on both legs; net is after the fees and slippage you recorded. Qty is the quantity recorded — on a partial fill, the part that filled. A trade with no exit is still open and has no result.`,
    "",
  ].join("\n");
}

/** The trial rules, in the order the table shows them. Each verdict is decided in `reviewTrade`. */
const RULE_COLUMNS: readonly { header: string; rule: keyof RuleVerdicts }[] = [
  { header: "Potential and open at fill", rule: "potentialAndOpen" },
  { header: "Fresh at fill", rule: "fresh" },
  { header: "Within budget", rule: "withinBudget" },
  { header: "Primary target", rule: "primaryTarget" },
  { header: "Taken after fill", rule: "takenAfterFill" },
  { header: "Exit not on invalidation", rule: "exitNotOnInvalidation" },
];

function rulesSection(trades: readonly TrialTradeReview[]): string {
  if (trades.length === 0) return "";

  const lines = [
    `## 5. Trial rules`,
    "",
    `| # | ${RULE_COLUMNS.map((c) => c.header).join(" | ")} |`,
    `|---|${RULE_COLUMNS.map(() => "---").join("|")}|`,
    ...trades.map((t, i) => row([String(i + 1), ...RULE_COLUMNS.map((c) => t.rules[c.rule])])),
    "",
    `Status and freshness are rebuilt at the recorded fill time from the setup's event log and the scanner passes completed by then, and must hold for a minute either side of it — a typed-in time is no more exact than that. "unknown" means the journal does not hold what the rule needs, or the record is too close to call — never that it passed. An open trade has no exit to judge yet. These are rule checks only: they never change an exit, a net result or an R.`,
    "",
  ];

  const flagged = trades.flatMap((t, i) => t.flags.map((f) => `- #${i + 1} ${f.message}`));
  if (flagged.length > 0) lines.push(`Flags:`, "", ...flagged, "");
  return lines.join("\n");
}

function resultsSection({ outcomes, trades }: TrialReportInput): string {
  const closed = trades.filter((t) => t.decision === "CLOSED");
  const open = trades.filter((t) => t.decision === "TAKEN");
  const net = closed.reduce((sum, t) => sum + (t.outcome?.netPnl ?? 0), 0);
  const untracked = closed.filter((t) => t.plan === null).length;

  const lines = [`## 6. Results (closed trades)`, ""];
  if (outcomes.closedTrades === 0) {
    lines.push(
      `No closed trade with a tracked setup and a recorded result, so there is no R to report.`,
    );
  } else {
    lines.push(
      `- Closed: ${outcomes.closedTrades} · wins ${outcomes.wins} · losses ${outcomes.losses} · breakeven ${outcomes.breakeven}`,
      `- Win rate ${outcomes.winRate.toFixed(0)}% (wins over wins plus losses) · total ${r(outcomes.totalR)} · average ${r(outcomes.averageR)} · expectancy ${r(outcomes.expectancyR)}`,
      `- Profit factor ${outcomes.profitFactor === null ? "— (no losses)" : outcomes.profitFactor.toFixed(2)} · max drawdown ${outcomes.maxDrawdownR.toFixed(2)}R`,
    );
  }
  lines.push(
    `- Net result: ${usdt(net)} USDT · capital ${usdt(DEMO_TRIAL.capitalUsdt + net)} USDT after the trial (notional)`,
    `- Still open at the end of the window: ${open.length} (no exit recorded, so no result and no R)`,
  );
  if (untracked > 0) {
    lines.push(
      `- ${untracked} closed trade(s) had no tracked setup: counted in the net result, left out of the R metrics, as research does.`,
    );
  }
  if (outcomes.smallSample) {
    lines.push(
      "",
      `A sample this small describes these trades and nothing more. A win rate or expectancy over a handful of trades is not evidence about the method.`,
    );
  }
  return [...lines, ""].join("\n");
}

function executionSection(trades: readonly TrialTradeReview[]): string {
  const values = (pick: (t: TrialTradeReview) => number | null) =>
    trades.map(pick).filter((v): v is number => v !== null);
  const mean = (xs: number[]) =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

  const entryVsTop = values((t) => t.vsPlan.entryVsZoneTopPct);
  const stopFills = values((t) => t.vsPlan.stopFillPct);
  const targetFills = values((t) => t.vsPlan.targetFillPct);
  const aboveZone = trades.filter((t) => t.vsPlan.entryVsZone === "ABOVE_ZONE").length;
  const costs = trades.reduce((sum, t) => sum + (t.outcome?.costs ?? 0), 0);
  const risk = trades.reduce((sum, t) => sum + (t.outcome?.riskAmount ?? 0), 0);

  const lines = [
    `## 7. SpotLens plan against Demo fills`,
    "",
    `- Fill against the top of the zone (where the calculator sizes from): ${avg(mean(entryVsTop), entryVsTop.length)}. Filled above the zone: ${aboveZone}.`,
    `- Stop-outs, exit against the stop that was set: ${avg(mean(stopFills), stopFills.length)}. Negative is a fill below the stop.`,
    `- Take-profits, exit against the target that was set: ${avg(mean(targetFills), targetFills.length)}.`,
    `- Recorded costs: ${usdt(costs)} USDT against ${usdt(risk)} USDT of risk taken.`,
    `- SpotLens's levels come from live-exchange candles; Demo fills come from Demo's own simulated book. The price check (\`npm run demo:prices\`) measures the gap between the two.`,
    "",
  ];

  if (trades.length > 0) {
    lines.push(
      `| # | Fill vs zone | Fill vs zone top | Stop vs plan | Take-profit vs primary | Stop fill | Take-profit fill |`,
      `|---|---|---|---|---|---|---|`,
      ...trades.map((t, i) =>
        row([
          String(i + 1),
          t.vsPlan.entryVsZone ? readable(t.vsPlan.entryVsZone) : "—",
          formatPercent(t.vsPlan.entryVsZoneTopPct),
          formatPercent(t.vsPlan.stopVsPlanPct),
          formatPercent(t.vsPlan.targetVsPlanPct),
          formatPercent(t.vsPlan.stopFillPct),
          formatPercent(t.vsPlan.targetFillPct),
        ]),
      ),
      "",
    );
  }
  return lines.join("\n");
}

function caveats({ trades }: TrialReportInput): string {
  const late = trades.filter((t) => t.lateEntry).length;
  return [
    `## 8. Caveats`,
    "",
    `- Demo Trading is a simulation. Binance describes its prices and order books as similar to the live exchange, not the same; a result here says nothing certain about a live one.`,
    `- Every price, quantity, fee and time in the trades table is what was typed into the journal. SpotLens has no order path and cannot verify a fill.`,
    `- The journal holds one quantity and one exit price per trade. A partial fill is the filled quantity; an exit taken in parts can only be recorded as one average price. The budget is judged on the quantity that filled — the journal does not hold the quantity ordered, so an order sized over budget that only partly filled can read as within it.`,
    ...(late > 0
      ? [
          `- ${late} trade(s) were recorded as late entries on closed setups. Their entry times are self-reported, and research groups them with ordinary takes.`,
        ]
      : []),
    `- ${BACKTEST_DISCLAIMER}`,
    "",
  ].join("\n");
}

// --- formatting ----------------------------------------------------------------

function row(cells: string[]): string {
  return `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
}

function readable(value: string): string {
  return value.toLowerCase().replace(/_/g, " ");
}

function time(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function duration(ms: number | null): string {
  if (ms === null) return "—";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}

function usdt(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : value.toFixed(4);
}

function r(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`;
}

function avg(value: number | null, n: number): string {
  return value === null ? "no data" : `average ${formatPercent(value)} over ${n}`;
}
