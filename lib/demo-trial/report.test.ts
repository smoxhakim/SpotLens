import { describe, expect, it } from "vitest";

import { computeMetrics } from "@/lib/backtesting";
import { BACKTEST_DISCLAIMER } from "@/lib/constants/disclaimers";
import { engineFunnel } from "@/lib/research";

import { DEMO_TRIAL } from "./config";
import { scanCoverage } from "./coverage";
import { renderTrialReport, type TrialReportInput } from "./report";
import { reviewTrade, type TrialTradeInput } from "./trades";

const H = 60 * 60_000;
const FROM = Date.UTC(2026, 9, 30, 15);
const TO = Date.UTC(2026, 10, 2, 8);
const at = (h: number, m = 0) => Date.UTC(2026, 9, 31, h, m);

/** A compliant 4h trade: Potential and fresh at a 10:00 fill, Taken five minutes later. */
const trade = (overrides: Partial<TrialTradeInput> = {}): TrialTradeInput => ({
  entryId: "e1",
  symbol: "AAAUSDT",
  timeframe: "H4",
  decision: "CLOSED",
  statusAtDecision: "POTENTIAL_SETUP",
  decidedAt: at(10, 5),
  takenRecordedAt: at(10, 5),
  skipReason: null,
  lateEntry: false,
  plan: {
    entryLow: 100,
    entryHigh: 102,
    stopLoss: 97,
    measuredTarget: 110,
    measuredTargetLabel: "TP2",
    riskReward: 2.6,
    riskRewardIsSynthetic: false,
  },
  history: {
    createdAt: at(8, 2),
    events: [{ toStatus: "POTENTIAL_SETUP", at: at(8, 2) }],
    reads: [{ analysedAtCandle: at(4), availableAt: at(8, 2) }],
  },
  actualEntry: 101.5,
  actualStopLoss: 96.5,
  actualTakeProfit: 110,
  actualExit: 110,
  quantity: 0.19,
  fees: 0.04,
  slippage: null,
  exitReason: "TAKE_PROFIT",
  openedAt: at(10),
  closedAt: at(16),
  ...overrides,
});

const empty: TrialReportInput = {
  generatedAt: TO,
  from: FROM,
  to: TO,
  coverage: scanCoverage({
    from: FROM,
    to: TO,
    passStarts: [],
    failedPasses: 0,
    expectedEveryMs: H,
    toleranceMs: 15 * 60_000,
  }),
  engine: engineFunnel([]),
  notifications: [],
  decisions: [],
  unfilled: { cancelled: 0, skippedMissedEntry: 0 },
  trades: [],
  outcomes: computeMetrics([]),
};

describe("renderTrialReport", () => {
  it("states the trial's terms, its fee estimate and the disclaimer on every report", () => {
    const report = renderTrialReport(empty);
    expect(report).toContain(DEMO_TRIAL.venue);
    expect(report).toContain(
      "at most 1 USDT per trade, with estimated fees (0.1% a side — the risk calculator's assumption, not a verified Binance Demo fee)",
    );
    expect(report).toContain("The fees actually charged count only where you recorded them");
    for (const rule of DEMO_TRIAL.rules) expect(report).toContain(rule);
    expect(report).toContain(BACKTEST_DISCLAIMER);
  });

  it("says plainly when nothing happened, rather than printing zeros as results", () => {
    const report = renderTrialReport(empty);
    expect(report).toContain("Nothing was journaled in this window.");
    expect(report).toContain("No position was taken in this window.");
    expect(report).toContain("there is no R to report");
    expect(report).not.toContain("## 5. Trial rules");
  });

  it("names a stretch with no successful pass as one in which analyses were out of date", () => {
    const report = renderTrialReport(empty);
    expect(report).toContain("long enough for a candle to close unread");
    expect(report).toContain("2026-10-30 15:00 UTC to 2026-11-02 08:00 UTC (65h 00m)");
  });

  it("counts orders that never filled apart from trades", () => {
    const report = renderTrialReport({
      ...empty,
      decisions: [
        { decision: "CANCELLED", count: 2 },
        { decision: "SKIPPED", count: 1 },
      ],
      unfilled: { cancelled: 2, skippedMissedEntry: 1 },
    });
    expect(report).toContain(
      "Orders that never filled: 2 cancelled · 1 skipped as a missed entry.",
    );
    expect(report).toContain("No position was taken in this window.");
  });

  it("lists each trade with its planned loss and R, and keeps the net result in USDT apart from R", () => {
    const win = reviewTrade(trade());
    const loss = reviewTrade(
      trade({ entryId: "e2", symbol: "BBBUSDT", actualExit: 96.2, exitReason: "STOP_LOSS" }),
    );
    const open = reviewTrade(
      trade({
        entryId: "e3",
        symbol: "CCCUSDT",
        decision: "TAKEN",
        actualExit: null,
        exitReason: null,
        closedAt: null,
      }),
    );
    const report = renderTrialReport({
      ...empty,
      decisions: [
        { decision: "CLOSED", count: 2 },
        { decision: "TAKEN", count: 1 },
      ],
      trades: [win, loss, open],
    });

    expect(report).toContain(
      "| 1 | AAAUSDT H4 | closed | 101.5000 | 96.5000 | 110.0000 | 110.0000 |",
    );
    expect(report).toContain("| 0.9876 |");
    expect(report).toContain(`+${(1.575 / 0.95).toFixed(2)}R`);
    expect(report).toContain(`-${(1.047 / 0.95).toFixed(2)}R`);
    // 1.575 − 1.047 = 0.528 USDT, on 100 of notional capital; the open trade adds nothing.
    expect(report).toContain("Net result: 0.5280 USDT · capital 100.5280 USDT");
    expect(report).toContain("Still open at the end of the window: 1");
  });

  it("checks each trade against the trial rules: ok, NO, or unknown — never a guess", () => {
    const report = renderTrialReport({
      ...empty,
      trades: [
        reviewTrade(trade()),
        reviewTrade(trade({ entryId: "e2", quantity: 0.2 })),
        reviewTrade(trade({ entryId: "e3", openedAt: null })),
      ],
    });
    expect(report).toContain("| 1 | ok | ok | ok | ok | ok | ok |");
    expect(report).toContain("| 2 | ok | ok | NO | ok | ok | ok |");
    expect(report).toContain("| 3 | unknown | unknown | ok | ok | unknown | ok |");
    expect(report).toContain(
      "- #2 Planned loss at the stop 1.0396 USDT with estimated fees (0.1% a side — the risk calculator's assumption, not a verified Binance Demo fee)",
    );
  });

  it("reports an exit on invalidation as a rule flag, beside an exit and result left as recorded", () => {
    const review = reviewTrade(trade({ exitReason: "INVALIDATED", actualExit: 103 }));
    const report = renderTrialReport({
      ...empty,
      decisions: [{ decision: "CLOSED", count: 1 }],
      trades: [review],
    });
    // Section 4: the recorded exit, its reason and its result — (103 − 101.5) × 0.19 − 0.04.
    expect(report).toContain("| 103.0000 | invalidated | 0.19 |");
    expect(report).toContain("| 0.2450 |");
    // Section 5: the rule, and why.
    expect(report).toContain("| 1 | ok | ok | ok | ok | ok | NO |");
    expect(report).toContain("does not by itself require closing a trade");
    expect(report).toContain("they never change an exit, a net result or an R");
  });

  it("leaves an open trade's exit rule unknown, and says why", () => {
    const open = reviewTrade(
      trade({ decision: "TAKEN", actualExit: null, exitReason: null, closedAt: null }),
    );
    const report = renderTrialReport({ ...empty, trades: [open] });
    expect(report).toContain("| 1 | ok | ok | ok | ok | ok | unknown |");
    expect(report).toContain("An open trade has no exit to judge yet.");
  });

  it("shows — for an exit with no recorded stop or take-profit, and leaves it out of the averages", () => {
    const stopOut = (overrides: Partial<TrialTradeInput>) =>
      trade({ actualExit: 96.2, exitReason: "STOP_LOSS", ...overrides });
    const trades = [
      // Recorded stop 96.5, out at 96.2: −0.31%.
      stopOut({ entryId: "e1", symbol: "AAAUSDT" }),
      // No stop recorded. Against the plan's 97 this would read −0.82%.
      stopOut({ entryId: "e2", symbol: "BBBUSDT", actualStopLoss: null }),
      // Recorded take-profit 110, out at 110.2: +0.18%.
      trade({ entryId: "e3", symbol: "CCCUSDT", actualExit: 110.2 }),
      // No take-profit recorded. Against the plan's 110 this would read +0.91%.
      trade({ entryId: "e4", symbol: "DDDUSDT", actualTakeProfit: null, actualExit: 111 }),
    ].map(reviewTrade);

    const report = renderTrialReport({ ...empty, trades });
    const planVsFills = report.slice(report.indexOf("## 7."), report.indexOf("## 8."));

    expect(planVsFills).toContain("exit against the stop that was set: average -0.31% over 1.");
    expect(planVsFills).toContain("exit against the target that was set: average +0.18% over 1.");
    expect(planVsFills).not.toMatch(/-0\.82%|\+0\.91%/);
    // Rows 2 and 4: stop vs plan, take-profit vs primary, stop fill, take-profit fill.
    expect(planVsFills).toMatch(/^\| 2 \| [^\n]* \| — \| \+0\.00% \| — \| — \|$/m);
    expect(planVsFills).toMatch(/^\| 4 \| [^\n]* \| -0\.52% \| — \| — \| — \|$/m);
    // The trades table shows the blank level as blank, not as the plan's.
    expect(report).toContain("| 2 | BBBUSDT H4 | closed | 101.5000 | — | 110.0000 | 96.2000 |");
    expect(report).toContain("| 4 | DDDUSDT H4 | closed | 101.5000 | 96.5000 | — | 111.0000 |");
  });

  it("warns that a handful of trades is not evidence", () => {
    expect(renderTrialReport(empty)).toContain("is not evidence about the method");
  });
});
