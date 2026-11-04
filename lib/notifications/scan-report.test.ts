import { describe, expect, it } from "vitest";

import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";

import { dedupeKeyForScanReport, telegramPriorityFor } from "./mapping";
import {
  planScanReport,
  scanReportRecord,
  type ReportedEvent,
  type ReportedResult,
  type ReportedRun,
  type ScanReportFacts,
} from "./scan-report";
import { escape, formatScanReport } from "./telegram-format";
import { DEFAULT_PREFERENCES, EVENT_PRIORITY, PREFERENCE_FOR_EVENT } from "./types";

/**
 * The hourly report's rules: which runs it may speak about, and that what it
 * says is exactly what the pass recorded for 1h — never 4h folded in.
 */

const STARTED = Date.UTC(2026, 10, 2, 7, 1, 30);

function run(overrides: Partial<ReportedRun> = {}): ReportedRun {
  return {
    id: "run-1",
    status: "COMPLETED",
    timeframes: ["H1"],
    startedAt: STARTED,
    completedAt: STARTED + 5_200,
    durationMs: 5_200,
    ...overrides,
  };
}

const ok = (timeframe: string, analysisStatus: string): ReportedResult => ({
  timeframe,
  status: "OK",
  analysisStatus,
});
const failed = (timeframe: string): ReportedResult => ({
  timeframe,
  status: "FAILED",
  analysisStatus: null,
});
const repeat = <T>(n: number, item: T): T[] => Array.from({ length: n }, () => item);

/** 45 1h markets: 1 potential, 15 wait, 16 high risk, 13 avoid. */
const HOURLY: ReportedResult[] = [
  ok("H1", "POTENTIAL_SETUP"),
  ...repeat(15, ok("H1", "WAIT_FOR_CONFIRMATION")),
  ...repeat(16, ok("H1", "HIGH_RISK")),
  ...repeat(13, ok("H1", "AVOID")),
];

/** 45 4h markets, deliberately lopsided so a leak into the 1h counts shows. */
const FOUR_HOURLY: ReportedResult[] = [
  ...repeat(3, ok("H4", "POTENTIAL_SETUP")),
  ...repeat(40, ok("H4", "AVOID")),
  ...repeat(2, failed("H4")),
];

const EVENTS: ReportedEvent[] = [
  { type: "SETUP_CREATED", timeframe: "H1" },
  { type: "SETUP_CREATED", timeframe: "H1" },
  { type: "SETUP_INVALIDATED", timeframe: "H1" },
  { type: "SETUP_STATE_CHANGED", timeframe: "H1" },
  { type: "ANALYSIS_FAILED", timeframe: "H1" },
  { type: "SETUP_CREATED", timeframe: "H4" },
  { type: "SETUP_INVALIDATED", timeframe: "H4" },
  { type: "SETUP_INVALIDATED", timeframe: "H4" },
];

const OPEN = [
  { status: "CONFIRMATION_DETECTED", count: 9 },
  { status: "SETUP_FORMING", count: 17 },
  { status: "WAITING_CONFIRMATION", count: 8 },
];

function plan(overrides: Partial<Parameters<typeof planScanReport>[0]> = {}) {
  return planScanReport({
    run: run(),
    results: HOURLY,
    events: EVENTS,
    openSetups: OPEN,
    ...overrides,
  });
}

function facts(overrides: Partial<Parameters<typeof planScanReport>[0]> = {}): ScanReportFacts {
  const result = plan(overrides);
  if (!result.ok) throw new Error(`expected a report, got ${result.refusal}`);
  return result.facts;
}

describe("which runs get a report", () => {
  it("reports a COMPLETED pass that covered 1h", () => {
    expect(plan().ok).toBe(true);
  });

  it("refuses a run with no stored record", () => {
    expect(plan({ run: null })).toEqual({ ok: false, refusal: "NO_RUN_RECORD" });
  });

  it("refuses a run that is still RUNNING, or was never closed", () => {
    expect(plan({ run: run({ status: "RUNNING", completedAt: null }) })).toEqual({
      ok: false,
      refusal: "NOT_FINISHED",
    });
    // A COMPLETED status without a completion time is not a reliable record.
    expect(plan({ run: run({ completedAt: null }) })).toEqual({
      ok: false,
      refusal: "NOT_FINISHED",
    });
  });

  it("refuses a FAILED pass — every market failed, or it was interrupted", () => {
    expect(plan({ run: run({ status: "FAILED" }) })).toEqual({
      ok: false,
      refusal: "NOT_SUCCESSFUL",
    });
  });

  it("refuses a 4h-only pass, so 4h is never reported on its own", () => {
    expect(plan({ run: run({ timeframes: ["H4"] }), results: FOUR_HOURLY })).toEqual({
      ok: false,
      refusal: "NO_HOURLY_TIMEFRAME",
    });
  });

  it("refuses a pass whose every 1h market failed, even if its 4h half succeeded", () => {
    const result = plan({
      run: run({ status: "PARTIAL", timeframes: ["H1", "H4"] }),
      results: [...repeat(45, failed("H1")), ...FOUR_HOURLY],
    });
    expect(result).toEqual({ ok: false, refusal: "NO_HOURLY_ANALYSES" });
  });

  it("refuses a 1h pass with no 1h rows recorded at all", () => {
    expect(plan({ results: [] })).toEqual({ ok: false, refusal: "NO_HOURLY_ANALYSES" });
  });

  it("reports a PARTIAL pass, counting its failures rather than hiding them", () => {
    const f = facts({
      run: run({ status: "PARTIAL" }),
      results: [...HOURLY.slice(0, 43), failed("H1"), failed("H1")],
    });
    expect(f.markets).toBe(45);
    expect(f.succeeded).toBe(43);
    expect(f.failed).toBe(2);
  });
});

describe("what a report counts", () => {
  it("counts the engine's 1h verdicts and the 1h markets", () => {
    const f = facts();
    expect(f.markets).toBe(45);
    expect(f.succeeded).toBe(45);
    expect(f.failed).toBe(0);
    expect(f.verdicts).toEqual({
      potentialSetup: 1,
      waitForConfirmation: 15,
      highRisk: 16,
      avoid: 13,
    });
  });

  it("counts only created and invalidated setups, from the pass's own 1h events", () => {
    const f = facts();
    expect(f.setupsCreated).toBe(2);
    expect(f.setupsInvalidated).toBe(1);
  });

  it("lists every open lifecycle state in order, zeros included, and totals them", () => {
    const f = facts();
    expect(f.openSetups).toEqual([
      { status: "SETUP_FORMING", count: 17 },
      { status: "WAITING_CONFIRMATION", count: 8 },
      { status: "CONFIRMATION_DETECTED", count: 9 },
      { status: "POTENTIAL_SETUP", count: 0 },
    ]);
    expect(f.openTotal).toBe(34);
  });

  it("never counts an invalidated setup as open", () => {
    const f = facts({ openSetups: [...OPEN, { status: "INVALIDATED", count: 50 }] });
    expect(f.openTotal).toBe(34);
  });

  it("keeps a combined 1h + 4h pass's 4h rows and events out of every count", () => {
    const hourlyOnly = facts();
    const combined = facts({
      run: run({ timeframes: ["H1", "H4"], status: "PARTIAL" }),
      results: [...HOURLY, ...FOUR_HOURLY],
    });

    expect(combined.markets).toBe(hourlyOnly.markets);
    expect(combined.failed).toBe(0);
    expect(combined.verdicts).toEqual(hourlyOnly.verdicts);
    expect(combined.setupsCreated).toBe(hourlyOnly.setupsCreated);
    expect(combined.setupsInvalidated).toBe(hourlyOnly.setupsInvalidated);
    // Said rather than hidden.
    expect(combined.alsoScanned).toEqual(["4h"]);
    expect(hourlyOnly.alsoScanned).toEqual([]);
  });

  it("takes the timestamp and duration from the stored run", () => {
    const f = facts();
    expect(f.runId).toBe("run-1");
    expect(f.startedAt).toBe(STARTED);
    expect(f.durationMs).toBe(5_200);
  });
});

describe("one report per run", () => {
  it("keys the report on the run id and nothing else", () => {
    expect(dedupeKeyForScanReport("run-1")).toBe("scan-report:run-1");
    expect(dedupeKeyForScanReport("run-1")).toBe(dedupeKeyForScanReport("run-1"));
    expect(dedupeKeyForScanReport("run-2")).not.toBe(dedupeKeyForScanReport("run-1"));
  });
});

describe("the switches and routing around it", () => {
  it("is off by default, and so is Telegram", () => {
    expect(DEFAULT_PREFERENCES.scanReport).toBe(false);
    expect(DEFAULT_PREFERENCES.telegramEnabled).toBe(false);
  });

  it("has its own switch, which governs no other event", () => {
    expect(PREFERENCE_FOR_EVENT.SCAN_REPORT).toBe("scanReport");
    const others = Object.entries(PREFERENCE_FOR_EVENT).filter(
      ([type, key]) => key === "scanReport" && type !== "SCAN_REPORT",
    );
    expect(others).toEqual([]);
  });

  it("leaves the Potential alert on its own switch, still pushed at HIGH", () => {
    expect(PREFERENCE_FOR_EVENT.SETUP_DETECTED).toBe("setupDetected");
    expect(telegramPriorityFor({ type: "SETUP_DETECTED", setup: null })).toBe("HIGH");
  });

  it("can never be pushed by the alert routing rules", () => {
    expect(telegramPriorityFor({ type: "SCAN_REPORT", setup: null })).toBe("LOW");
    expect(EVENT_PRIORITY.SCAN_REPORT).toBe("LOW");
  });
});

describe("the Telegram message", () => {
  it("carries every required field", () => {
    const text = formatScanReport(facts());

    expect(text).toContain("📋 *1h scan report*");
    expect(text).toContain(escape("2026-11-02 07:01:30 UTC · took 5.2s"));
    expect(text).toContain("*Timeframe*: 1h");
    expect(text).toContain("*Markets*: 45 · 45 succeeded · 0 failed");
    expect(text).toContain("Potential setup: 1");
    expect(text).toContain("Wait for confirmation: 15");
    expect(text).toContain("High risk: 16");
    expect(text).toContain("Avoid: 13");
    expect(text).toContain("*Setups*: 2 created · 1 invalidated");
    expect(text).toContain("*Open 1h setups*: 34");
    expect(text).toContain("Forming: 17");
    expect(text).toContain("Waiting for confirmation: 8");
    expect(text).toContain("Confirmation evidence present: 9");
    expect(text).toContain(escape(ANALYSIS_DISCLAIMER));
  });

  it("says a partial pass is partial", () => {
    const text = formatScanReport(
      facts({
        run: run({ status: "PARTIAL" }),
        results: [...HOURLY.slice(0, 44), failed("H1")],
      }),
    );
    expect(text).toContain(`*${escape("1h scan report — some markets failed")}*`);
    expect(text).toContain("*Markets*: 45 · 44 succeeded · 1 failed");
    expect(text).toContain(escape("The counts below cover the markets that were analysed."));
  });

  it("names the other timeframe of a combined pass, and that its counts are not here", () => {
    const text = formatScanReport(
      facts({ run: run({ timeframes: ["H1", "H4"] }), results: [...HOURLY, ...FOUR_HOURLY] }),
    );
    expect(text).toContain(escape("This pass also scanned 4h; those analyses are not counted"));
    expect(text).toContain("Potential setup: 1");
  });

  it("omits the duration when the run recorded none", () => {
    const text = formatScanReport(facts({ run: run({ durationMs: null }) }));
    expect(text).not.toContain("took");
  });

  it("leaves no reserved character unescaped", () => {
    for (const f of [
      facts(),
      facts({ run: run({ timeframes: ["H1", "H4"] }), results: [...HOURLY, ...FOUR_HOURLY] }),
      facts({ run: run({ status: "PARTIAL" }), results: [...HOURLY.slice(0, 44), failed("H1")] }),
    ]) {
      // Every unescaped reserved character must be deliberate markup: * for
      // bold, _ for italic, \ for an escape.
      const stray = formatScanReport(f)
        .replace(/\\./g, "")
        .match(/[[\]()~`>#+=|{}.!-]/g);
      expect(stray).toBeNull();
    }
  });

  it("never uses instruction language", () => {
    const text = formatScanReport(facts()).toLowerCase();
    for (const banned of ["buy", "sell", "enter now", "place order", "execute"]) {
      expect(text).not.toContain(banned);
    }
  });
});

describe("the stored row", () => {
  it("records the same counts in plain text", () => {
    const { title, body } = scanReportRecord(facts());
    expect(title).toBe("📋 1h scan report — 2026-11-02 07:01:30 UTC");
    expect(body).toContain("45 markets · 45 succeeded · 0 failed.");
    expect(body).toContain(
      "Potential setup 1 · Wait for confirmation 15 · High risk 16 · Avoid 13.",
    );
    expect(body).toContain("Setups 2 created · 1 invalidated.");
    expect(body).toContain(
      "Open 1h setups 34: Forming 17 · Waiting for confirmation 8 · " +
        "Confirmation evidence present 9 · Potential setup 0.",
    );
  });
});
