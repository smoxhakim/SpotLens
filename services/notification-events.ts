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
import type { ScannerEvent } from "@/lib/scanner";
import type { SetupLifecycleStatus } from "@/lib/setups";

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

  const setupIds = input.scannerEvents
    .map((event) => event.setupId)
    .filter((id): id is string => id !== null);

  // A setup replaced by one on a different level is reported by the scanner
  // with no id — the lifecycle hands back the *new* setup's id, and the old
  // one's is not part of that outcome. Skipping those would drop the single
  // most important thing this layer says: the level you were waiting on is
  // gone. Resolved here from what Phase D already stored, so neither the
  // scanner nor the lifecycle needs changing.
  //
  // That missing id is also how a replacement is *identified*. It is the
  // scanner's own REPLACE signal — `eventsForOutcome` emits the closing half
  // with `setupId: null` and the opening half with the new setup's id — so
  // nothing here has to re-derive replacement semantics from prices, or match
  // on the wording of a reason string.
  const orphaned = input.scannerEvents
    .filter((event) => event.type === "SETUP_INVALIDATED" && event.setupId === null)
    .map((event) => ({
      symbol: event.symbol,
      timeframe: event.timeframe,
      replacementSetupId: replacementFor(input.scannerEvents, event.symbol, event.timeframe),
    }));

  const resolved = orphaned.length > 0 ? await resolveInvalidated(orphaned) : new Map();

  const transitions =
    setupIds.length > 0
      ? await loadLatestTransitions(setupIds)
      : new Map<string, LoadedTransition>();

  for (const [key, value] of resolved) transitions.set(key, value);

  for (const scannerEvent of input.scannerEvents) {
    if (scannerEvent.type === "ANALYSIS_FAILED") {
      events.push(systemErrorEvent(input.userId, scannerEvent, at));
      continue;
    }

    const lookupKey =
      scannerEvent.setupId ?? orphanKey(scannerEvent.symbol, scannerEvent.timeframe);

    const transition = transitions.get(lookupKey);
    if (!transition) continue;

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
    });
  }

  return events;
}

/** Key for a setup identified by market rather than by id. */
function orphanKey(symbol: string, timeframe: string): string {
  return `orphan:${symbol}:${timeframe}`;
}

/**
 * The other half of a REPLACE.
 *
 * `eventsForOutcome` emits the pair together for one market, so the creation
 * that accompanies an id-less invalidation is the replacement setup. Returns
 * null when the invalidation stands alone, which is the case the lifecycle
 * produces when the level moved *and* confirmation was contradicted — nothing
 * replaced that setup, and it is a genuine invalidation.
 */
function replacementFor(
  scannerEvents: ScannerEvent[],
  symbol: string,
  timeframe: string,
): string | null {
  const created = scannerEvents.find(
    (event) =>
      event.type === "SETUP_CREATED" &&
      event.symbol === symbol &&
      event.timeframe === timeframe &&
      event.setupId !== null,
  );

  return created?.setupId ?? null;
}

/**
 * Finds the setup behind an invalidation the scanner could not name.
 *
 * Matched on the market and timeframe, taking the most recently invalidated
 * one — which is the setup the replacement just closed. The notification's
 * identity is still the `SetupEvent` id, so this cannot produce a duplicate.
 */
async function resolveInvalidated(
  scannerEvents: { symbol: string; timeframe: string; replacementSetupId: string | null }[],
): Promise<Map<string, LoadedTransition>> {
  const map = new Map<string, LoadedTransition>();

  for (const scannerEvent of scannerEvents) {
    const setup = await prisma.trackedSetup.findFirst({
      where: {
        status: "INVALIDATED",
        timeframe: scannerEvent.timeframe as Timeframe,
        tradingPair: { exchangeSymbol: scannerEvent.symbol },
      },
      orderBy: { invalidatedAt: "desc" },
      include: { events: { orderBy: { createdAt: "desc" }, take: 1 } },
    });

    if (!setup) continue;

    // The zone the replacement anchored to, read from the row Phase D just
    // wrote. Shown to the reader so "re-anchored" names both levels rather
    // than asking them to go and look.
    const replacement = scannerEvent.replacementSetupId
      ? await prisma.trackedSetup.findUnique({
          where: { id: scannerEvent.replacementSetupId },
          select: { originZoneLow: true, originZoneHigh: true },
        })
      : null;

    const loaded = toTransition(setup, {
      isReplacement: scannerEvent.replacementSetupId !== null,
      replacementZoneLow: replacement === null ? null : Number(replacement.originZoneLow),
      replacementZoneHigh: replacement === null ? null : Number(replacement.originZoneHigh),
    });

    if (loaded) map.set(orphanKey(scannerEvent.symbol, scannerEvent.timeframe), loaded);
  }

  return map;
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
 * One query for the batch rather than one per event: a scan can touch dozens of
 * setups, and the alternative is dozens of round trips for data that is already
 * indexed together.
 */
async function loadLatestTransitions(setupIds: string[]): Promise<Map<string, LoadedTransition>> {
  const setups = await prisma.trackedSetup.findMany({
    where: { id: { in: setupIds } },
    include: { events: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  const map = new Map<string, LoadedTransition>();

  for (const setup of setups) {
    const loaded = toTransition(setup);
    if (loaded) map.set(setup.id, loaded);
  }

  return map;
}

type SetupWithLatestEvent = Awaited<
  ReturnType<typeof prisma.trackedSetup.findFirst<{ include: { events: true } }>>
>;

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

/** Reads one stored setup and its latest transition into notification facts. */
function toTransition(
  setup: NonNullable<SetupWithLatestEvent>,
  replacement: ReplacementContext = NOT_A_REPLACEMENT,
): LoadedTransition | null {
  {
    const event = setup.events[0];
    if (!event) return null;

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
        // Phase D stamps `confirmedAt` the first time a setup reaches
        // CONFIRMATION_DETECTED or POTENTIAL_SETUP and never clears it, so this
        // is "did this level ever get going" read straight off the record.
        everConfirmed: setup.confirmedAt !== null,
      },
    };
  }
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

  // Over-fetched and then deduplicated by market, because a day contains
  // several passes and the same market appears once per pass — the first real
  // summary listed VETUSDT H1 three times out of five places. The order is
  // untouched: the first row for a market is already its best-ranked one under
  // Phase E's ordering, so keeping it and dropping the repeats re-ranks
  // nothing.
  const topCandidates = await prisma.scannerResult.findMany({
    where: {
      scannerRun: { startedAt: { gte: from, lt: to } },
      status: "OK",
      analysisStatus: { in: ["POTENTIAL_SETUP", "WAIT_FOR_CONFIRMATION"] },
    },
    orderBy: [{ analysisStatus: "asc" }, { score: "desc" }],
    take: 100,
    include: { tradingPair: { select: { exchangeSymbol: true } } },
  });

  const seenMarkets = new Set<string>();
  const topRows: typeof topCandidates = [];

  for (const row of topCandidates) {
    const market = `${row.tradingPair.exchangeSymbol}:${row.timeframe}`;
    if (seenMarkets.has(market)) continue;
    seenMarkets.add(market);
    topRows.push(row);
    if (topRows.length === 5) break;
  }

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
    topRanked: topRows.map((row) => ({
      symbol: row.tradingPair.exchangeSymbol,
      timeframe: row.timeframe,
      analysisStatus: row.analysisStatus ?? "UNKNOWN",
      score: row.score,
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
  };
}
