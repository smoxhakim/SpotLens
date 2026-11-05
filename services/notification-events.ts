import type { SetupEvent, TrackedSetup } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { Timeframe } from "@/lib/market-data/provider";
import {
  EVENT_PRIORITY,
  dedupeKeyForDailySummary,
  dedupeKeyForSetupEvent,
  dedupeKeyForSystemError,
  eventTypeForTransition,
  type DailySummaryFacts,
  type NotificationEvent,
  type SetupFacts,
} from "@/lib/notifications";
import { buildShortlist, type ScannerEvent } from "@/lib/scanner";
import { closureCauseOf, type SetupLifecycleStatus } from "@/lib/setups";

/**
 * Turns what a scan observed into notification events.
 *
 * Every fact in the result is read back from what Phase D already wrote — the
 * immutable setup snapshot and the `SetupEvent` row for the transition — rather
 * than passed along from the scanner. Two reasons: the scanner's event is
 * deliberately thin and enriching it would mean changing Phase E, and reading
 * the stored row guarantees a notification describes exactly what was recorded,
 * not a re-derivation that could drift from it.
 *
 * Which row is not looked up — it is named. The lifecycle reports the id of
 * every `SetupEvent` it wrote, and this reads exactly those, scoped to the
 * owner in the query. It used to take "the newest event on the setup", which
 * another writer's later event could replace, and to find a replaced setup as
 * "the one invalidated most recently on this market", for any account. An
 * event the lifecycle did not name is not notified rather than guessed.
 *
 * The `SetupEvent` id also becomes the deduplication key, so identity comes
 * from the lifecycle rather than being invented here.
 */
export async function eventsFromScan(input: {
  userId: string;
  scannerEvents: ScannerEvent[];
  now?: number;
}): Promise<NotificationEvent[]> {
  const at = input.now ?? Date.now();
  const events: NotificationEvent[] = [];

  // Failures name no event, and nothing is looked up for them.
  const eventIds = input.scannerEvents
    .map((event) => event.eventId)
    .filter((id): id is string => typeof id === "string");

  const written =
    eventIds.length > 0
      ? await loadWrittenEvents(input.userId, eventIds)
      : new Map<string, StoredEvent>();

  for (const scannerEvent of input.scannerEvents) {
    if (scannerEvent.type === "ANALYSIS_FAILED") {
      events.push(systemErrorEvent(input.userId, scannerEvent, at));
      continue;
    }

    const stored = scannerEvent.eventId ? written.get(scannerEvent.eventId) : undefined;
    if (!stored) continue;

    // A setup replaced by one on a different level is reported by the scanner
    // with no `setupId` — that missing id is the scanner's own REPLACE signal
    // (`eventsForOutcome` emits the closing half without it and the opening
    // half with the new setup's), so nothing here has to re-derive replacement
    // semantics from prices or match on the wording of a reason. The closing
    // half still names its exact event, and the replacement's zone is read
    // from the opening half's row, loaded in the same query.
    const replacement =
      scannerEvent.type === "SETUP_INVALIDATED" && scannerEvent.setupId === null
        ? replacementContext(input.scannerEvents, scannerEvent, written)
        : NOT_A_REPLACEMENT;

    const transition = toTransition(stored.setup, stored, replacement);

    // Structure is only "changed" when the confirmation engine says a level
    // broke or was reclaimed — a state change on its own is not one.
    const type = eventTypeForTransition({
      lifecycleStatus: transition.facts.lifecycleStatus,
      confirmationSignals: transition.facts.confirmationSignals,
    });

    if (!type) continue;

    events.push({
      type,
      userId: input.userId,
      priority: EVENT_PRIORITY[type],
      asset: scannerEvent.symbol,
      timeframe: transition.timeframe,
      timestamp: transition.at,
      // Still Phase D's event id, so a replaced setup cannot be announced
      // twice however many passes observe it.
      dedupeKey: dedupeKeyForSetupEvent(transition.eventId),
      setup: transition.facts,
      summary: null,
      systemError: null,
      entryZone: null,
    });
  }

  return events;
}

type StoredEvent = SetupEvent & { setup: TrackedSetup };

/**
 * Exactly these events, with their setups — and only this owner's. One query
 * for the batch: a scan can touch dozens of setups.
 */
async function loadWrittenEvents(
  userId: string,
  eventIds: string[],
): Promise<Map<string, StoredEvent>> {
  const rows = await prisma.setupEvent.findMany({
    where: { id: { in: eventIds }, setup: { userId } },
    include: { setup: true },
  });

  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The other half of a REPLACE.
 *
 * `eventsForOutcome` emits the pair together for one market, and a pass
 * analyses each market and timeframe once, so the creation in this pass on the
 * same market is the replacement. Its zone comes from the row its own event id
 * resolved — not a second lookup. With no creation the invalidation stands
 * alone, which is the case the lifecycle produces when the level moved *and*
 * confirmation was contradicted: nothing replaced that setup.
 */
function replacementContext(
  scannerEvents: ScannerEvent[],
  closing: ScannerEvent,
  written: Map<string, StoredEvent>,
): ReplacementContext {
  const opening = scannerEvents.find(
    (event) =>
      event.type === "SETUP_CREATED" &&
      event.symbol === closing.symbol &&
      event.timeframe === closing.timeframe &&
      event.setupId !== null,
  );
  if (!opening) return NOT_A_REPLACEMENT;

  const created = opening.eventId ? written.get(opening.eventId) : undefined;

  return {
    isReplacement: true,
    replacementZoneLow: created ? Number(created.setup.originZoneLow) : null,
    replacementZoneHigh: created ? Number(created.setup.originZoneHigh) : null,
  };
}

interface LoadedTransition {
  eventId: string;
  at: number;
  timeframe: Timeframe;
  facts: SetupFacts;
}

/**
 * The most recent lifecycle transition for each setup, with its snapshot.
 *
 * For the entry-zone monitor only (`loadSetupFacts`), which wants where the
 * last closed-candle scan left a setup it is about to alert on. A scan's own
 * notifications never use it: they name their events.
 */
async function loadLatestTransitions(setupIds: string[]): Promise<Map<string, LoadedTransition>> {
  const setups = await prisma.trackedSetup.findMany({
    where: { id: { in: setupIds } },
    include: { events: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  const map = new Map<string, LoadedTransition>();

  for (const setup of setups) {
    const latest = setup.events[0];
    if (latest) map.set(setup.id, toTransition(setup, latest));
  }

  return map;
}

/**
 * Notification facts for stored setups, read the same way a scan's are.
 *
 * Exported for the entry-zone monitor, so an alert describes a setup with
 * exactly the fields, labels and snapshot reads every other message uses
 * rather than a second, drifting copy of this mapping. `lifecycleStatus` is the
 * latest transition's — where the last closed-candle scan left the setup.
 */
export async function loadSetupFacts(setupIds: string[]): Promise<Map<string, SetupFacts>> {
  if (setupIds.length === 0) return new Map();
  const transitions = await loadLatestTransitions(setupIds);
  return new Map([...transitions].map(([id, transition]) => [id, transition.facts]));
}

/** What the caller knows that the stored row does not say on its own. */
interface ReplacementContext {
  isReplacement: boolean;
  replacementZoneLow: number | null;
  replacementZoneHigh: number | null;
}

const NOT_A_REPLACEMENT: ReplacementContext = {
  isReplacement: false,
  replacementZoneLow: null,
  replacementZoneHigh: null,
};

/** Reads one stored setup and one of its transitions into notification facts. */
function toTransition(
  setup: TrackedSetup,
  event: SetupEvent,
  replacement: ReplacementContext = NOT_A_REPLACEMENT,
): LoadedTransition {
  const snapshot = (setup.snapshot ?? {}) as {
    entryReason?: string;
    statusReason?: string;
    trend?: string;
    mtfAgreement?: string | null;
    regime?: { direction: string; volatility: string } | null;
  };

  const payload = (event.payload ?? null) as {
    signals?: { type: string; signal: string; title: string; detail: string }[];
    explanation?: string;
  } | null;

  return {
    eventId: event.id,
    at: event.createdAt.getTime(),
    timeframe: setup.timeframe,
    facts: {
      setupId: setup.id,
      lifecycleStatus: event.toStatus as SetupLifecycleStatus,
      previousStatus: (event.fromStatus as SetupLifecycleStatus | null) ?? null,
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
      trend: snapshot.trend ?? "UNKNOWN",
      mtfAgreement: snapshot.mtfAgreement ?? null,
      supportLow: Number(setup.originZoneLow),
      supportHigh: Number(setup.originZoneHigh),
      entryReason: snapshot.entryReason ?? "",
      statusReason: snapshot.statusReason ?? event.detail,
      confirmationSignals: payload?.signals ?? [],
      confirmationExplanation: payload?.explanation ?? null,
      invalidationReason: setup.invalidationReason,
      regime: snapshot.regime ?? null,
      isReplacement: replacement.isReplacement,
      replacementZoneLow: replacement.replacementZoneLow,
      replacementZoneHigh: replacement.replacementZoneHigh,
      closureCause: closureCauseOf(event.payload),
      // Phase D stamps `confirmedAt` the first time a setup reaches
      // CONFIRMATION_DETECTED or POTENTIAL_SETUP and never clears it, so this
      // is "did this level ever get going" read straight off the record.
      everConfirmed: setup.confirmedAt !== null,
    },
  };
}

function systemErrorEvent(
  userId: string,
  scannerEvent: ScannerEvent,
  at: number,
): NotificationEvent {
  const category = scannerEvent.failureCategory ?? "UNKNOWN";

  return {
    type: "SYSTEM_ERROR",
    userId,
    priority: EVENT_PRIORITY.SYSTEM_ERROR,
    asset: scannerEvent.symbol,
    timeframe: scannerEvent.timeframe as Timeframe,
    timestamp: at,
    dedupeKey: dedupeKeyForSystemError({ category, symbol: scannerEvent.symbol, at }),
    setup: null,
    summary: null,
    systemError: {
      category,
      symbol: scannerEvent.symbol,
      timeframe: scannerEvent.timeframe,
      // Already sanitised by the scanner's failure classifier.
      message: scannerEvent.detail,
      affectedMarkets: 1,
    },
    entryZone: null,
  };
}

/**
 * The daily summary, built from scanner runs rather than re-scanning.
 *
 * Ranking is not recomputed: the top entries come from the scanner results that
 * were already ordered by Phase E's rules and stored.
 */
export async function buildDailySummary(input: {
  userId: string;
  date?: Date;
}): Promise<NotificationEvent | null> {
  const day = input.date ?? new Date();
  const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const to = new Date(from.getTime() + 24 * 60 * 60_000);
  const date = from.toISOString().slice(0, 10);

  const runs = await prisma.scannerRun.findMany({
    where: { startedAt: { gte: from, lt: to } },
    include: { results: { where: { status: "OK" }, orderBy: { score: "desc" }, take: 5 } },
  });

  if (runs.length === 0) return null;

  const sum = (pick: (r: (typeof runs)[number]) => number) =>
    runs.reduce((total, run) => total + pick(run), 0);

  const byTimeframe = new Map<string, number>();
  for (const run of runs) {
    for (const timeframe of run.timeframes) {
      byTimeframe.set(timeframe, (byTimeframe.get(timeframe) ?? 0) + run.marketCount);
    }
  }

  // Ranked by the shortlist's own rules rather than by a second ordering in
  // SQL. The query that used to do this sorted on status and score alone, so a
  // setup whose reward was never measured could outrank one measured against
  // structure — the exact distortion Phase A removed from the engine. Ordering
  // lives in `buildShortlist` now, and this reads it.
  //
  // Day-scoped on purpose: a daily summary is an aggregate over the day's
  // passes, not a single pass. The same market appearing once per pass is
  // collapsed here, which is why the first real summary listed one symbol three
  // times out of five places.
  const dayRows = await prisma.scannerResult.findMany({
    where: { scannerRun: { startedAt: { gte: from, lt: to } }, status: "OK" },
    include: { tradingPair: { select: { exchangeSymbol: true } } },
    orderBy: { createdAt: "desc" },
  });

  const latestPerMarket = new Map<string, (typeof dayRows)[number]>();
  for (const row of dayRows) {
    // Newest first, so the first row seen for a market is its most recent read.
    const market = `${row.tradingPair.exchangeSymbol}:${row.timeframe}`;
    if (!latestPerMarket.has(market)) latestPerMarket.set(market, row);
  }

  const daily = buildShortlist(
    [...latestPerMarket.values()].map((row) => ({
      symbol: row.tradingPair.exchangeSymbol,
      timeframe: row.timeframe as string,
      analysisStatus: row.analysisStatus,
      score: row.score,
      riskReward: row.riskReward === null ? null : Number(row.riskReward),
      riskRewardIsSynthetic: row.riskRewardIsSynthetic,
      ok: true,
      lifecycleStatus: row.lifecycleStatus,
      trackedSetupId: row.trackedSetupId,
      analysedAtCandle: row.analysedAtCandle === null ? null : Number(row.analysedAtCandle),
      trend: row.trend,
      mtfAgreement: row.mtfAgreement,
      regimeDirection: row.regimeDirection,
    })),
  );

  const topRows = daily.top5;

  const summary: DailySummaryFacts = {
    date,
    runs: runs.length,
    marketsScanned: Math.max(...runs.map((r) => r.marketCount)),
    analysesByTimeframe: [...byTimeframe.entries()].map(([timeframe, count]) => ({
      timeframe,
      count,
    })),
    potentialSetups: sum((r) => r.potentialSetups),
    waiting: sum((r) => r.waiting),
    highRisk: sum((r) => r.highRisk),
    avoided: sum((r) => r.avoided),
    failures: sum((r) => r.failed),
    setupsCreated: sum((r) => r.setupsCreated),
    confirmations: sum((r) => r.stateChanges),
    invalidations: sum((r) => r.invalidations),
    topRanked: topRows.map((candidate) => ({
      symbol: candidate.symbol,
      timeframe: candidate.timeframe,
      analysisStatus: candidate.analysisStatus,
      score: candidate.score,
    })),
  };

  return {
    type: "DAILY_SUMMARY",
    userId: input.userId,
    priority: EVENT_PRIORITY.DAILY_SUMMARY,
    asset: null,
    timeframe: null,
    timestamp: Date.now(),
    dedupeKey: dedupeKeyForDailySummary(date),
    setup: null,
    summary,
    systemError: null,
    entryZone: null,
  };
}
