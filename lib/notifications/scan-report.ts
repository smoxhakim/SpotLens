import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import { SUCCESSFUL_RUN_STATUSES } from "@/lib/scanner/runs";
import { LIFECYCLE_LABELS } from "@/lib/setups/labels";

/**
 * The hourly scan report: what one finished pass recorded for the 1h timeframe.
 *
 * A count, and nothing more. Every number is read off rows the scanner already
 * wrote, events it already emitted, or setups the lifecycle already holds —
 * nothing here computes an indicator, ranks a market or reaches a verdict of
 * its own. The verdicts are the engine's, counted.
 *
 * 1h only, always. A pass at a 4h close scans both timeframes in one run, and
 * adding the 4h analyses into an "hourly" report would make the same hour read
 * twice as busy every fourth time. The 4h rows and events are filtered out
 * here, and the message says the pass also covered 4h rather than hiding it.
 *
 * Pure: the clock, the database and Telegram are the caller's business.
 */

/** The timeframe this report is about. */
export const SCAN_REPORT_TIMEFRAME: Timeframe = "H1";

/** The run as stored. A report is only ever built from the stored record. */
export interface ReportedRun {
  id: string;
  status: string;
  timeframes: readonly string[];
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms; null while the run is RUNNING or was never finished. */
  completedAt: number | null;
  durationMs: number | null;
}

/** One stored `ScannerResult` row, as much of it as a count needs. */
export interface ReportedResult {
  timeframe: string;
  status: string;
  analysisStatus: string | null;
}

/** One scanner event from the same pass. Only the type and timeframe are read. */
export interface ReportedEvent {
  type: string;
  timeframe: string;
}

/** Open setups on the report's timeframe, as the lifecycle holds them now. */
export interface OpenSetupCount {
  status: string;
  count: number;
}

/**
 * Why a run gets no report. Each is a pass that did not finish successfully,
 * or one with nothing on 1h to report — never a guess at what it would have
 * said.
 */
export type ScanReportRefusal =
  /** No stored run to vouch for the pass. */
  | "NO_RUN_RECORD"
  /** Still RUNNING, or never closed: no reliable completion record. */
  | "NOT_FINISHED"
  /** FAILED — every market failed, or the pass was interrupted. */
  | "NOT_SUCCESSFUL"
  /** A pass that did not cover 1h — a 4h-only pass is never reported. */
  | "NO_HOURLY_TIMEFRAME"
  /** Covered 1h, but no 1h market was analysed successfully. */
  | "NO_HOURLY_ANALYSES";

/** The lifecycle states a setup can be open in, in the order a reader follows them. */
const OPEN_STATUSES = [
  "SETUP_FORMING",
  "WAITING_CONFIRMATION",
  "CONFIRMATION_DETECTED",
  "POTENTIAL_SETUP",
] as const;

export type OpenLifecycleStatus = (typeof OPEN_STATUSES)[number];

export interface ScanReportFacts {
  runId: string;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. */
  completedAt: number;
  /** The whole pass's duration — on a combined pass it covers 4h as well. */
  durationMs: number | null;
  /** The other timeframes this pass scanned, labelled. Not counted here. */
  alsoScanned: string[];
  /** 1h markets in the pass. */
  markets: number;
  succeeded: number;
  failed: number;
  /** The engine's own verdicts on the 1h markets it analysed. */
  verdicts: {
    potentialSetup: number;
    waitForConfirmation: number;
    highRisk: number;
    avoid: number;
  };
  /** 1h setups this pass created and invalidated, from its own events. */
  setupsCreated: number;
  setupsInvalidated: number;
  /** Every open-lifecycle state, zeros included, in `OPEN_STATUSES` order. */
  openSetups: { status: OpenLifecycleStatus; count: number }[];
  openTotal: number;
}

export type ScanReportPlan =
  { ok: true; facts: ScanReportFacts } | { ok: false; refusal: ScanReportRefusal };

/**
 * Whether this run may be reported, and what the report says.
 *
 * The run's stored status decides first: a report is a statement that a pass
 * finished, so a run with no completion record says nothing. COMPLETED and
 * PARTIAL qualify, by the same definition every other "did a pass happen?"
 * question uses (`SUCCESSFUL_RUN_STATUSES`); a PARTIAL pass is reported with
 * its failures counted, never dressed as complete.
 */
export function planScanReport(input: {
  run: ReportedRun | null;
  results: readonly ReportedResult[];
  events: readonly ReportedEvent[];
  openSetups: readonly OpenSetupCount[];
}): ScanReportPlan {
  const { run } = input;

  if (!run) return { ok: false, refusal: "NO_RUN_RECORD" };
  if (run.completedAt === null) return { ok: false, refusal: "NOT_FINISHED" };
  if (!(SUCCESSFUL_RUN_STATUSES as readonly string[]).includes(run.status)) {
    return { ok: false, refusal: "NOT_SUCCESSFUL" };
  }
  if (!run.timeframes.includes(SCAN_REPORT_TIMEFRAME)) {
    return { ok: false, refusal: "NO_HOURLY_TIMEFRAME" };
  }

  const hourly = input.results.filter((r) => r.timeframe === SCAN_REPORT_TIMEFRAME);
  const succeeded = hourly.filter((r) => r.status === "OK");

  // A pass that covered 1h and analysed none of it is a 1h failure, whatever
  // the 4h half did. Its failures already go out as scanner errors; a report
  // headed "completed" would be the wrong thing to say about it.
  if (succeeded.length === 0) return { ok: false, refusal: "NO_HOURLY_ANALYSES" };

  const verdict = (status: string) => succeeded.filter((r) => r.analysisStatus === status).length;
  const events = (type: string) =>
    input.events.filter((e) => e.type === type && e.timeframe === SCAN_REPORT_TIMEFRAME).length;

  const openSetups = OPEN_STATUSES.map((status) => ({
    status,
    count: input.openSetups
      .filter((group) => group.status === status)
      .reduce((total, group) => total + group.count, 0),
  }));

  return {
    ok: true,
    facts: {
      runId: run.id,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      durationMs: run.durationMs,
      alsoScanned: run.timeframes
        .filter((tf) => tf !== SCAN_REPORT_TIMEFRAME)
        .map((tf) => TIMEFRAME_LABELS[tf as Timeframe] ?? tf),
      markets: hourly.length,
      succeeded: succeeded.length,
      failed: hourly.length - succeeded.length,
      verdicts: {
        potentialSetup: verdict("POTENTIAL_SETUP"),
        waitForConfirmation: verdict("WAIT_FOR_CONFIRMATION"),
        highRisk: verdict("HIGH_RISK"),
        avoid: verdict("AVOID"),
      },
      setupsCreated: events("SETUP_CREATED"),
      setupsInvalidated: events("SETUP_INVALIDATED"),
      openSetups,
      openTotal: openSetups.reduce((total, group) => total + group.count, 0),
    },
  };
}

/** `2026-11-02 07:01:30 UTC` — to the second, because it names one pass. */
export function scanReportStamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** `5.2s`, or null when the run recorded no duration. */
export function scanReportDuration(ms: number | null): string | null {
  return ms === null ? null : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The stored row's title and body.
 *
 * Plain text, for the record: the report is Telegram-only and never listed
 * in-app, but the row is what says a report for this run exists, and it
 * should read as one.
 */
export function scanReportRecord(facts: ScanReportFacts): { title: string; body: string } {
  const v = facts.verdicts;
  return {
    title: `📋 ${TIMEFRAME_LABELS[SCAN_REPORT_TIMEFRAME]} scan report — ${scanReportStamp(facts.startedAt)}`,
    body: [
      `${facts.markets} markets · ${facts.succeeded} succeeded · ${facts.failed} failed.`,
      `Potential setup ${v.potentialSetup} · Wait for confirmation ${v.waitForConfirmation} · ` +
        `High risk ${v.highRisk} · Avoid ${v.avoid}.`,
      `Setups ${facts.setupsCreated} created · ${facts.setupsInvalidated} invalidated.`,
      `Open ${TIMEFRAME_LABELS[SCAN_REPORT_TIMEFRAME]} setups ${facts.openTotal}: ` +
        facts.openSetups.map((g) => `${LIFECYCLE_LABELS[g.status]} ${g.count}`).join(" · ") +
        ".",
    ].join(" "),
  };
}
