import { contextFromTrackedSetup } from "@/lib/coach";
import { prisma } from "@/lib/db/prisma";
import {
  renderTrialReport,
  reviewTrade,
  scanCoverage,
  type SetupHistory,
  type TrialPlan,
  type TrialTradeReview,
} from "@/lib/demo-trial";
import { readLateEntry } from "@/lib/journal";
import { TIMEFRAME_MS } from "@/lib/market-data/provider";
import { buildResearchReport, type ResearchEntry, type ResearchSetup } from "@/lib/research";
import { riskPrefillFrom } from "@/lib/risk";
import { SUCCESSFUL_RUN_STATUSES, successfulPassWhere } from "@/lib/scanner/runs";

import { runResearch } from "./research";

/**
 * The demo trial's report, read from the database.
 *
 * Read-only: every query here is a `findMany`, and nothing is written — a test
 * runs it against a database stub with no write method at all. Owner scoping
 * is in each `where`. The comparisons and the layout are pure and live in
 * `lib/demo-trial`; R comes from the journal's own `computeOutcome` and the
 * metrics from research's adapter, so a figure here means what it means on the
 * Research page.
 */

/** Slack for the settle delay and the pass itself — the entry-zone monitor's own allowance. */
const PASS_TOLERANCE_MS = 15 * 60_000;

type Decimalish = { toString(): string };

export async function buildTrialReport(input: {
  userId: string;
  from: number;
  to: number;
  generatedAt: number;
}): Promise<string> {
  const { userId, from, to } = input;
  const window = { gte: new Date(from), lte: new Date(to) };

  const [entries, runs, notifications, engine] = await Promise.all([
    prisma.journalEntry.findMany({
      // Decided in the window, closed in it, or changed in it. `decidedAt` is
      // the first decision and never moves, so a watch from before the window
      // that was Taken inside it is found only by its events.
      where: {
        userId,
        OR: [
          { decidedAt: window },
          { closedAt: window },
          { events: { some: { createdAt: window } } },
        ],
      },
      orderBy: { decidedAt: "asc" },
      include: {
        tradingPair: { select: { exchangeSymbol: true } },
        events: {
          select: { toDecision: true, createdAt: true, payload: true },
          orderBy: { createdAt: "asc" },
        },
        trackedSetup: {
          include: {
            tradingPair: { select: { exchangeSymbol: true } },
            events: { select: { toStatus: true, createdAt: true }, orderBy: { createdAt: "asc" } },
          },
        },
      },
    }),
    prisma.scannerRun.findMany({
      where: { startedAt: window },
      select: { status: true, startedAt: true },
    }),
    prisma.notification.findMany({
      where: { userId, createdAt: window },
      select: { type: true, dedupeKey: true },
    }),
    // Setups first seen in the window: what the engine produced, as counts.
    runResearch({ userId, filters: { from, to } }),
  ]);

  const successful = new Set<string>(SUCCESSFUL_RUN_STATUSES);
  const coverage = scanCoverage({
    from,
    to,
    passStarts: runs
      .filter((run) => successful.has(run.status))
      .map((run) => run.startedAt.getTime()),
    failedPasses: runs.filter((run) => run.status === "FAILED").length,
    expectedEveryMs: TIMEFRAME_MS.H1,
    toleranceMs: PASS_TOLERANCE_MS,
  });

  const positions = entries.filter(
    (entry) => entry.decision === "TAKEN" || entry.decision === "CLOSED",
  );

  // Every successful pass whose analysis was reconciled against a traded setup
  // (the scanner writes the setup's id on the result — the existing id when
  // nothing changed): the reads its freshness at the fill is judged from. The
  // entry-zone monitor's and the Setups page's provenance. Scoped to the owner
  // by the ids, which come only from this owner's journal entries.
  const setupIds = positions.flatMap((entry) =>
    entry.trackedSetupId ? [entry.trackedSetupId] : [],
  );
  const passReads =
    setupIds.length === 0
      ? []
      : await prisma.scannerResult.findMany({
          where: {
            trackedSetupId: { in: setupIds },
            status: "OK",
            scannerRun: successfulPassWhere(),
          },
          select: {
            trackedSetupId: true,
            analysedAtCandle: true,
            scannerRun: { select: { completedAt: true } },
          },
        });

  const trades: TrialTradeReview[] = [];
  const researchSetups: ResearchSetup[] = [];
  const researchEntries: ResearchEntry[] = [];

  for (const entry of positions) {
    const setup = entry.trackedSetup;
    const number = (value: Decimalish | null) => (value === null ? null : Number(value));
    const takenAt = entry.events.find((event) => event.toDecision === "TAKEN")?.createdAt;

    const history: SetupHistory | null = setup
      ? {
          createdAt: setup.createdAt.getTime(),
          events: setup.events.map((e) => ({ toStatus: e.toStatus, at: e.createdAt.getTime() })),
          reads: [
            {
              analysedAtCandle: createdFromCandle(setup.snapshot),
              availableAt: setup.createdAt.getTime(),
            },
            ...passReads
              .filter((read) => read.trackedSetupId === setup.id && read.scannerRun.completedAt)
              .map((read) => ({
                analysedAtCandle:
                  read.analysedAtCandle === null ? null : Number(read.analysedAtCandle),
                // A pass's rows are shown only once the pass has completed.
                availableAt: (read.scannerRun.completedAt as Date).getTime(),
              })),
          ],
        }
      : null;

    const review = reviewTrade({
      entryId: entry.id,
      symbol: setup?.tradingPair.exchangeSymbol ?? entry.tradingPair?.exchangeSymbol ?? "—",
      timeframe: setup?.timeframe ?? entry.timeframe ?? "—",
      decision: entry.decision,
      statusAtDecision: entry.setupStatusAtDecision,
      decidedAt: entry.decidedAt.getTime(),
      takenRecordedAt: takenAt?.getTime() ?? null,
      skipReason: entry.skipReason,
      lateEntry: entry.events.some((event) => readLateEntry(event.payload) !== null),
      plan: setup ? planOf(setup) : null,
      history,
      actualEntry: number(entry.actualEntry),
      actualStopLoss: number(entry.actualStopLoss),
      actualTakeProfit: number(entry.actualTakeProfit),
      actualExit: number(entry.actualExit),
      quantity: number(entry.quantity),
      fees: number(entry.fees),
      slippage: number(entry.slippage),
      exitReason: entry.exitReason,
      openedAt: entry.openedAt?.getTime() ?? null,
      closedAt: entry.closedAt?.getTime() ?? null,
    });
    trades.push(review);

    // R metrics go through research's own adapter, for tracked trades only —
    // exactly the rows the Research page would measure.
    if (setup && entry.setupStatusAtDecision !== null) {
      const reached = new Set(setup.events.map((e) => e.toStatus));
      const regime = (
        (setup.snapshot ?? {}) as { regime?: { direction?: string; volatility?: string } }
      ).regime;
      researchSetups.push({
        id: setup.id,
        symbol: setup.tradingPair.exchangeSymbol,
        timeframe: setup.timeframe,
        lifecycleStatus: setup.status,
        score: setup.score,
        riskReward: Number(setup.riskReward),
        riskRewardIsSynthetic: setup.riskRewardIsSynthetic,
        confirmationStatus: reached.has("CONFIRMATION_DETECTED") ? "PRESENT" : null,
        regimeDirection: regime?.direction ?? null,
        regimeVolatility: regime?.volatility ?? null,
        createdAt: setup.createdAt.getTime(),
        everConfirmed: reached.has("CONFIRMATION_DETECTED") || reached.has("POTENTIAL_SETUP"),
        everPotentialSetup: reached.has("POTENTIAL_SETUP"),
      });
      researchEntries.push({
        setupId: setup.id,
        decision: entry.decision,
        statusAtDecision: entry.setupStatusAtDecision,
        skipReason: entry.skipReason,
        decidedAt: review.decidedAt,
        actualEntry: review.actualEntry,
        actualStopLoss: review.actualStopLoss,
        actualExit: review.actualExit,
        quantity: review.quantity,
        fees: review.fees,
        slippage: review.slippage,
        openedAt: review.openedAt,
        closedAt: review.closedAt,
      });
    }
  }

  const decidedInWindow = entries.filter(
    (entry) => entry.decidedAt.getTime() >= from && entry.decidedAt.getTime() <= to,
  );

  return renderTrialReport({
    generatedAt: input.generatedAt,
    from,
    to,
    coverage,
    engine: engine.engine,
    notifications: countBy(
      // One event per dedupe key, whichever channels carried it.
      [...new Map(notifications.map((n) => [n.dedupeKey, n.type])).values()],
    ).map(([type, count]) => ({ type, count })),
    decisions: countBy(decidedInWindow.map((entry) => entry.decision)).map(([decision, count]) => ({
      decision,
      count,
    })),
    unfilled: {
      cancelled: decidedInWindow.filter((entry) => entry.decision === "CANCELLED").length,
      skippedMissedEntry: decidedInWindow.filter(
        (entry) => entry.decision === "SKIPPED" && entry.skipReason === "MISSED_ENTRY",
      ).length,
    },
    trades,
    outcomes: buildResearchReport({
      setups: researchSetups,
      entries: researchEntries,
      filters: { from, to },
    }).outcomes,
  });
}

/** The candle the creating analysis read, as the lifecycle stored it on the snapshot. */
function createdFromCandle(snapshot: unknown): number | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>).createdFromCandleTime;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The plan as the risk calculator offered it: the stored levels, and the
 * target the ratio was measured to — selected by the engine's own rule through
 * `riskPrefillFrom`, never re-derived here.
 */
function planOf(setup: {
  id: string;
  tradingPair: { exchangeSymbol: string };
  timeframe: string;
  status: string;
  analysisStatus: string;
  score: number;
  scoreGrade: string;
  entryLow: Decimalish;
  entryHigh: Decimalish;
  stopLoss: Decimalish;
  takeProfit1: Decimalish | null;
  takeProfit2: Decimalish | null;
  takeProfit3: Decimalish | null;
  riskReward: Decimalish;
  riskRewardIsSynthetic: boolean;
  invalidationReason: string | null;
  createdAt: Date;
  snapshot: unknown;
}): TrialPlan {
  const level = (value: Decimalish | null) => (value === null ? null : Number(value));
  const { levels } = contextFromTrackedSetup(
    {
      setupId: setup.id,
      symbol: setup.tradingPair.exchangeSymbol,
      timeframe: setup.timeframe,
      lifecycleStatus: setup.status,
      analysisStatus: setup.analysisStatus,
      score: setup.score,
      scoreGrade: setup.scoreGrade,
      entryLow: Number(setup.entryLow),
      entryHigh: Number(setup.entryHigh),
      stopLoss: Number(setup.stopLoss),
      takeProfit1: level(setup.takeProfit1),
      takeProfit2: level(setup.takeProfit2),
      takeProfit3: level(setup.takeProfit3),
      riskReward: Number(setup.riskReward),
      riskRewardIsSynthetic: setup.riskRewardIsSynthetic,
      invalidationReason: setup.invalidationReason,
      createdAt: setup.createdAt.getTime(),
      snapshot: (setup.snapshot ?? {}) as Record<string, unknown>,
      confirmationPayload: null,
    },
    "",
  );

  if (!levels) {
    return {
      entryLow: Number(setup.entryLow),
      entryHigh: Number(setup.entryHigh),
      stopLoss: Number(setup.stopLoss),
      measuredTarget: null,
      measuredTargetLabel: null,
      riskReward: Number(setup.riskReward),
      riskRewardIsSynthetic: setup.riskRewardIsSynthetic,
    };
  }

  const prefill = riskPrefillFrom(levels);
  return {
    entryLow: levels.entryLow,
    entryHigh: levels.entryHigh,
    stopLoss: levels.stopLoss,
    measuredTarget: prefill.takeProfit,
    measuredTargetLabel: prefill.takeProfitLabel,
    riskReward: levels.riskReward,
    riskRewardIsSynthetic: levels.riskRewardIsSynthetic,
  };
}

function countBy(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
