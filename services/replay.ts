import { prisma } from "@/lib/db/prisma";
import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/market-data/provider";
import { coverageFor, markersUpTo, type ReplayCoverage, type ReplayMarker } from "@/lib/replay";

/**
 * Reconstructs what was knowable about a setup at a moment.
 *
 * Reads persisted candles only. It never calls the exchange, and that is a
 * design constraint rather than an optimisation: a reconstruction that fetches
 * is not a reconstruction, and it would stop being reproducible the moment the
 * provider changed what it serves for that range. Where the stored history is
 * short, the gap is reported.
 *
 * Every cutoff is applied in the database query, not after loading — so future
 * data is never in memory to leak through a bug downstream.
 */

/** Candles shown before the cutoff. Enough context to read the structure. */
const REPLAY_WINDOW_CANDLES = 200;

export interface ReplayFrame {
  setupId: string;
  symbol: string;
  timeframe: Timeframe;
  /** The moment being reconstructed, epoch ms. */
  at: number;
  candles: Candle[];
  coverage: ReplayCoverage;
  markers: ReplayMarker[];
  /**
   * What the engine recorded when the setup was created. Preferred over any
   * recomputation, and labelled as a snapshot so it is never confused with one.
   */
  snapshot: {
    source: "HISTORICAL_SNAPSHOT";
    entryLow: number;
    entryHigh: number;
    stopLoss: number;
    takeProfit1: number | null;
    takeProfit2: number | null;
    riskReward: number;
    riskRewardIsSynthetic: boolean;
    score: number;
    scoreGrade: string;
    analysisStatus: string;
    detail: unknown;
  };
  /** Lifecycle events that had happened by the cutoff, and no others. */
  events: {
    id: string;
    type: string;
    fromStatus: string | null;
    toStatus: string;
    detail: string;
    createdAt: string;
  }[];
  /** The decision, when one had been made by the cutoff. */
  decision: { decision: string; decidedAt: string; notes: string | null } | null;
}

/**
 * Builds the frame for one setup at one moment.
 *
 * `at` defaults to the journal decision when there is one, and otherwise to
 * the setup's creation — the two moments a reader actually wants to inspect.
 */
export async function buildReplayFrame(input: {
  userId: string;
  setupId: string;
  at?: number;
}): Promise<ReplayFrame | null> {
  const setup = await prisma.trackedSetup.findFirst({
    where: { id: input.setupId, userId: input.userId },
    include: {
      tradingPair: { select: { id: true, exchangeSymbol: true } },
      journalEntry: { select: { decision: true, decidedAt: true, notes: true } },
    },
  });

  if (!setup) return null;

  const decidedAt = setup.journalEntry?.decidedAt.getTime() ?? null;
  const at = input.at ?? decidedAt ?? setup.createdAt.getTime();

  const intervalMs = TIMEFRAME_MS[setup.timeframe];
  const windowStart = at - REPLAY_WINDOW_CANDLES * intervalMs;

  // The cutoff is in the query. Future candles never reach memory, so no bug
  // further down can accidentally reveal one.
  const rows = await prisma.candle.findMany({
    where: {
      tradingPairId: setup.tradingPair.id,
      timeframe: setup.timeframe,
      closeTime: { lte: new Date(at) },
      openTime: { gte: new Date(windowStart) },
    },
    orderBy: { openTime: "asc" },
    take: REPLAY_WINDOW_CANDLES,
  });

  const candles: Candle[] = rows.map((row) => ({
    openTime: row.openTime.getTime(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
    closeTime: row.closeTime.getTime(),
  }));

  // Same rule for the lifecycle: only what had already been written.
  const events = await prisma.setupEvent.findMany({
    where: { setupId: setup.id, createdAt: { lte: new Date(at) } },
    orderBy: { createdAt: "asc" },
  });

  return {
    setupId: setup.id,
    symbol: setup.tradingPair.exchangeSymbol,
    timeframe: setup.timeframe,
    at,
    candles,
    coverage: coverageFor({ candles, intervalMs, windowStart, cutoff: at }),
    markers: markersUpTo(
      events.map((e) => ({
        createdAt: e.createdAt.getTime(),
        toStatus: e.toStatus,
        type: e.type,
      })),
      decidedAt,
      at,
    ),
    snapshot: {
      // Named, so a reader is never left guessing whether these numbers were
      // recorded at the time or recalculated just now.
      source: "HISTORICAL_SNAPSHOT",
      entryLow: Number(setup.entryLow),
      entryHigh: Number(setup.entryHigh),
      stopLoss: Number(setup.stopLoss),
      takeProfit1: setup.takeProfit1 === null ? null : Number(setup.takeProfit1),
      takeProfit2: setup.takeProfit2 === null ? null : Number(setup.takeProfit2),
      riskReward: Number(setup.riskReward),
      riskRewardIsSynthetic: setup.riskRewardIsSynthetic,
      score: setup.score,
      scoreGrade: setup.scoreGrade,
      analysisStatus: setup.analysisStatus,
      detail: setup.snapshot,
    },
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      detail: event.detail,
      createdAt: event.createdAt.toISOString(),
    })),
    decision:
      setup.journalEntry && decidedAt !== null && decidedAt <= at
        ? {
            decision: setup.journalEntry.decision,
            decidedAt: setup.journalEntry.decidedAt.toISOString(),
            notes: setup.journalEntry.notes,
          }
        : null,
  };
}
