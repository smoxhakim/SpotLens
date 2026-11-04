import type { Prisma } from "@prisma/client";

import type { AnalysisResult } from "@/lib/analysis";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import type { Timeframe } from "@/lib/market-data/provider";
import type { AnalysisRead } from "@/lib/scanner/freshness";
import { successfulPassWhere } from "@/lib/scanner/runs";
import {
  classifyLifecycleError,
  isStaleAnalysis,
  LifecycleConflictError,
  lifecycleLockKey,
  readsCanonicalContext,
  reconcileSetup,
  type ExistingSetup,
  type LifecycleFailure,
  type NoActionCause,
  type PlannedCreate,
  type PlannedTransition,
  type RecordedCandles,
  type SetupEventType,
  type SetupLifecycleStatus,
  type SetupPlan,
  type TransactionPhase,
} from "@/lib/setups";

/**
 * Executes what `lib/setups` decides.
 *
 * The split is deliberate: every rule about identity and transitions lives in
 * the pure planner, and this file only performs the writes. That keeps
 * `lib/analysis` free of I/O, and it means the lifecycle can be tested properly
 * without standing up a database.
 */

export interface TrackSetupInput {
  userId: string;
  tradingPairId: string;
  timeframe: Timeframe;
  result: AnalysisResult;
  /** Links the setup to the run that produced it, rather than copying it. */
  analysisSnapshotId?: string | null;
}

/** One `SetupEvent` a call wrote, so a notification can name it exactly. */
export interface WrittenSetupEvent {
  setupId: string;
  eventId: string;
  type: SetupEventType;
  toStatus: SetupLifecycleStatus;
}

export interface TrackSetupOutcome {
  action: SetupPlan["action"];
  setupId: string | null;
  status: SetupLifecycleStatus | null;
  /** Why nothing was written, when nothing was. */
  reason: string | null;
  /**
   * The same, typed — set only on a NONE plan. Null on NOTHING: no plan was
   * made, so there is no cause to report (`untrackedReasonOf` says unknown).
   */
  cause: NoActionCause | null;
  /** The setup a REPLACE closed; null for every other action. */
  replacedSetupId: string | null;
  /**
   * Every event this call wrote, in the order it wrote them — the old setup's
   * INVALIDATED before the new one's CREATED on a REPLACE. Empty when nothing
   * was written. A notification resolves these ids, never a guess at "the
   * newest event" or "the setup invalidated most recently on this market".
   */
  events: WrittenSetupEvent[];
}

const NOTHING: TrackSetupOutcome = {
  action: "NONE",
  setupId: null,
  status: null,
  reason: null,
  cause: null,
  replacedSetupId: null,
  events: [],
};

/**
 * How every reconciliation runs.
 *
 * READ COMMITTED is required, not incidental: each statement takes a fresh
 * snapshot, so the reads after the lock see whatever its previous holder
 * committed. Under REPEATABLE READ the snapshot would date from the first
 * statement — before the lock — and the re-read could miss that commit. The
 * timeout exceeds the lock wait, so a wait is reported as a lock timeout.
 */
const TRANSACTION_OPTIONS = {
  isolationLevel: "ReadCommitted",
  maxWait: 5_000,
  timeout: 10_000,
} as const;

/** The first try, and one retry after a failure that certainly rolled back. */
const MAX_ATTEMPTS = 2;

/** How long a writer waits for another writer's lock on the same setup. */
const LOCK_TIMEOUT = "5s";

/**
 * How long a transaction may sit idle before Postgres ends it. Without it a
 * client that vanishes mid-transaction (a laptop sleeping against a remote
 * database) holds the setup's lock until TCP keepalive notices — over two
 * hours with the server defaults — and every writer for it times out.
 */
const IDLE_IN_TRANSACTION_TIMEOUT = "30s";

/**
 * Reconciles one analysis run against the stored setup for that pair and
 * timeframe.
 *
 * One transaction per call, holding an advisory lock on the setup's identity
 * for its whole length: two writers for the same setup — the scanner and a
 * manual run, say — are serialised, and the second plans against what the
 * first committed rather than against a row it read before. Every write is on
 * that transaction and guarded on the state it was planned from, so a
 * replacement and its events commit together or not at all.
 *
 * Never throws. Losing lifecycle history must not fail the analysis the user
 * asked for — the same rule the snapshot writer follows. A failure that
 * certainly rolled back is retried once; anything else is reported in one line
 * and returns NOTHING.
 *
 * Writes nothing at all when the state has not moved, which is what stops a
 * scanner re-running every few minutes from filling the table with identical
 * rows.
 */
export async function trackSetup(input: TrackSetupInput): Promise<TrackSetupOutcome> {
  if (!isDatabaseConfigured) return NOTHING;

  // A property of the analysis rather than of the stored state, so it is judged
  // before any transaction: a read that does not speak for this setup should
  // not even queue behind the writers that do.
  if (!readsCanonicalContext(input.timeframe, input.result)) {
    return {
      ...NOTHING,
      reason:
        "Read against a higher timeframe other than this timeframe's own, so it does not speak for the setup tracked here.",
      cause: "NON_CANONICAL_CONTEXT",
    };
  }

  for (let attempt = 1; ; attempt += 1) {
    let phase: TransactionPhase = "BEGIN";

    try {
      return await prisma.$transaction(async (tx) => {
        phase = "BODY";
        const outcome = await reconcileLocked(tx, input, new Date());
        phase = "COMMIT";
        return outcome;
      }, TRANSACTION_OPTIONS);
    } catch (err) {
      const failure = classifyLifecycleError(err, phase);
      if (failure.kind === "RETRY" && attempt < MAX_ATTEMPTS) continue;
      reportFailure(input, failure);
      return NOTHING;
    }
  }
}

/**
 * One attempt, inside the transaction. Nothing here touches the global client:
 * a statement outside `tx` would run on another connection, outside the lock,
 * and commit on its own.
 */
async function reconcileLocked(
  tx: Prisma.TransactionClient,
  input: TrackSetupInput,
  now: Date,
): Promise<TrackSetupOutcome> {
  // This transaction's only (`is_local`), so a pooled connection goes back to
  // the pool with the server's defaults.
  await tx.$executeRaw`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`;

  // Keyed on exactly the identity `findOpenSetup` reads on, and 64-bit. Held
  // until COMMIT or ROLLBACK and released by them — or by the backend exiting —
  // so it can never outlive this call. `$executeRaw`, because the function
  // returns void, which `$queryRaw` cannot deserialise.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lifecycleLockKey(input)}, 0))`;

  const existing = await findOpenSetup(input, tx);

  // A stale *read* is impossible under the lock; a stale *analysis* is not. An
  // older candle must not move a setup back, nor re-create a level a newer
  // analysis has just closed.
  if (
    isStaleAnalysis({
      timeframe: input.timeframe,
      analysedCandleOpen: input.result.read.lastCandleTime,
      recorded: await recordedCandles(input, tx),
    })
  ) {
    return {
      ...NOTHING,
      reason: "An older candle than one already recorded for this setup; nothing was changed.",
      cause: "STALE_ANALYSIS",
    };
  }

  const plan = reconcileSetup({ existing, result: input.result });

  switch (plan.action) {
    case "NONE":
      return {
        action: "NONE",
        setupId: existing?.id ?? null,
        status: null,
        reason: plan.reason,
        cause: plan.cause,
        replacedSetupId: null,
        events: [],
      };

    case "CREATE": {
      const created = await createSetup(tx, input, plan.create, now);
      return {
        action: "CREATE",
        setupId: created.setupId,
        status: plan.create.status,
        reason: null,
        cause: null,
        replacedSetupId: null,
        events: [created],
      };
    }

    case "TRANSITION": {
      const moved = await applyTransition(tx, input.userId, plan.transition, now);
      return {
        action: "TRANSITION",
        setupId: plan.transition.setupId,
        status: plan.transition.to,
        reason: null,
        cause: null,
        replacedSetupId: null,
        events: [moved],
      };
    }

    case "REPLACE": {
      // Ordered, and in this one transaction: the old setup is closed before
      // the new one exists, so a reader can never see two open setups on the
      // same level — and neither half can commit without the other.
      const closed = await applyTransition(tx, input.userId, plan.invalidate, now);
      const created = await createSetup(tx, input, plan.create, now);
      return {
        action: "REPLACE",
        setupId: created.setupId,
        status: plan.create.status,
        reason: null,
        cause: null,
        replacedSetupId: plan.invalidate.setupId,
        events: [closed, created],
      };
    }
  }
}

/**
 * One line per failure, naming what it means. A code, never the provider's
 * message, which can carry query text. "May have been committed" is the one
 * case where a change can exist without its notification — said, not hidden.
 */
function reportFailure(input: TrackSetupInput, failure: LifecycleFailure): void {
  const market = `${input.tradingPairId} ${input.timeframe}`;
  console.warn(
    failure.kind === "UNCERTAIN"
      ? `[setups] lifecycle outcome unknown for ${market} (${failure.code}) — the change may have been committed; its notification will not be sent.`
      : `[setups] lifecycle not updated for ${market} (${failure.code}) — nothing was written; the next analysis reconciles it.`,
  );
}

/**
 * The open setup for this user, pair and timeframe.
 *
 * Scoped by `userId` at the query, not filtered afterwards — one person's setup
 * history must never be reachable from another account. Most recent wins if
 * more than one is somehow open; `trackSetup` closes the old one whenever the
 * level changes, so that should not happen.
 */
async function findOpenSetup(
  input: TrackSetupInput,
  db: Prisma.TransactionClient,
): Promise<ExistingSetup | null> {
  const row = await db.trackedSetup.findFirst({
    where: {
      userId: input.userId,
      tradingPairId: input.tradingPairId,
      timeframe: input.timeframe,
      status: { not: "INVALIDATED" },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      originZoneLow: true,
      originZoneHigh: true,
      confirmedAt: true,
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    status: row.status as SetupLifecycleStatus,
    origin: { zoneLow: Number(row.originZoneLow), zoneHigh: Number(row.originZoneHigh) },
    hasConfirmedAt: row.confirmedAt !== null,
  };
}

/**
 * The newest candle times recorded for this identity, across every setup it
 * has had — an invalidated one included, since that is the state an older
 * analysis must not undo. One aggregate; no row is returned.
 */
async function recordedCandles(
  input: TrackSetupInput,
  db: Prisma.TransactionClient,
): Promise<RecordedCandles> {
  const [row] = await db.$queryRaw<
    { evaluated: bigint | number | null; unstamped: Date | null }[]
  >`SELECT
      max(("e"."payload"->>'evaluatedAt')::bigint) FILTER (WHERE "e"."payload" ? 'evaluatedAt') AS "evaluated",
      max("e"."createdAt") FILTER (WHERE "e"."payload" IS NULL OR NOT ("e"."payload" ? 'evaluatedAt')) AS "unstamped"
    FROM "SetupEvent" "e"
    JOIN "TrackedSetup" "s" ON "s"."id" = "e"."setupId"
    WHERE "s"."userId" = ${input.userId}
      AND "s"."tradingPairId" = ${input.tradingPairId}
      AND "s"."timeframe" = ${input.timeframe}::"Timeframe"`;

  return {
    newestEvaluatedAt: row?.evaluated === null || row === undefined ? null : Number(row.evaluated),
    newestUnstampedAt: row?.unstamped ? row.unstamped.getTime() : null,
  };
}

async function createSetup(
  db: Prisma.TransactionClient,
  input: TrackSetupInput,
  create: PlannedCreate,
  now: Date,
): Promise<WrittenSetupEvent> {
  const { snapshot } = create;

  const row = await db.trackedSetup.create({
    data: {
      userId: input.userId,
      tradingPairId: input.tradingPairId,
      timeframe: input.timeframe,
      status: create.status,
      entryLow: snapshot.entryLow,
      entryHigh: snapshot.entryHigh,
      stopLoss: snapshot.stopLoss,
      takeProfit1: snapshot.takeProfit1,
      takeProfit2: snapshot.takeProfit2,
      takeProfit3: snapshot.takeProfit3,
      riskReward: snapshot.riskReward,
      riskRewardIsSynthetic: snapshot.riskRewardIsSynthetic,
      score: snapshot.score,
      scoreGrade: snapshot.scoreGrade,
      analysisStatus: snapshot.analysisStatus,
      snapshot: toJson(snapshot.detail),
      originZoneLow: create.origin.zoneLow,
      originZoneHigh: create.origin.zoneHigh,
      analysisSnapshotId: input.analysisSnapshotId ?? null,
      confirmedAt: create.marksConfirmed ? now : null,
      events: {
        create: {
          type: create.event.type,
          fromStatus: null,
          toStatus: create.status,
          detail: create.event.detail,
          payload: create.event.payload ? toJson(create.event.payload) : undefined,
        },
      },
    },
    select: { id: true, events: { select: { id: true } } },
  });

  const event = row.events[0];
  if (!event) throw new Error("A created setup came back without its CREATED event.");

  return { setupId: row.id, eventId: event.id, type: create.event.type, toStatus: create.status };
}

/**
 * Applies one transition and appends its event.
 *
 * The snapshot columns are never named here — that is what makes them
 * immutable. The status write is guarded on the state the plan was made from,
 * so an INVALIDATED row can never be moved again and a plan that no longer
 * matches the row is refused (and retried from a fresh read) rather than
 * applied. `confirmedAt` is stamped only when the planner marks it — only while
 * the row read for this plan had none — and only where it is still null, so a
 * setup that loses and regains confirmation keeps the time of the first one.
 */
async function applyTransition(
  db: Prisma.TransactionClient,
  userId: string,
  transition: PlannedTransition,
  now: Date,
): Promise<WrittenSetupEvent> {
  const invalidating = transition.to === "INVALIDATED";

  const moved = await db.trackedSetup.updateMany({
    where: { id: transition.setupId, userId, status: transition.from },
    data: {
      status: transition.to,
      ...(invalidating
        ? { invalidatedAt: now, invalidationReason: transition.invalidationReason }
        : {}),
    },
  });
  if (moved.count !== 1) throw new LifecycleConflictError(transition.setupId, transition.from);

  if (transition.marksConfirmed) {
    await db.trackedSetup.updateMany({
      where: { id: transition.setupId, confirmedAt: null },
      data: { confirmedAt: now },
    });
  }

  const event = await db.setupEvent.create({
    data: {
      setupId: transition.setupId,
      type: transition.event.type,
      fromStatus: transition.from,
      toStatus: transition.to,
      detail: transition.event.detail,
      payload: transition.event.payload ? toJson(transition.event.payload) : undefined,
    },
    select: { id: true },
  });

  return {
    setupId: transition.setupId,
    eventId: event.id,
    type: transition.event.type,
    toStatus: transition.to,
  };
}

export interface ListSetupsQuery {
  userId: string;
  status?: SetupLifecycleStatus;
  tradingPairId?: string;
  timeframe?: Timeframe;
  limit: number;
}

/** Setup history for one user, newest first. Always scoped by owner. */
export async function listSetups(query: ListSetupsQuery) {
  const rows = await prisma.trackedSetup.findMany({
    where: {
      userId: query.userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.tradingPairId ? { tradingPairId: query.tradingPairId } : {}),
      ...(query.timeframe ? { timeframe: query.timeframe } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: query.limit,
    include: {
      tradingPair: { select: { exchangeSymbol: true, asset: { select: { symbol: true } } } },
      _count: { select: { events: true } },
    },
  });

  const lastScans = await lastScanReads(rows.map((row) => row.id));

  return rows.map((row) => ({ ...serialiseSetup(row), lastScan: lastScans.get(row.id) ?? null }));
}

/**
 * The latest successful scanner pass that read each setup's market, by setup.
 *
 * A setup's snapshot is its creation's and never changes, so it cannot say
 * whether the setup is still current; the passes after it can. The provenance
 * is the entry-zone monitor's: a `ScannerResult` with `status = OK` and this
 * `trackedSetupId` — written on every pass that leaves the setup open, the
 * existing id when nothing changed — on a run that finished as COMPLETED or
 * PARTIAL (`successfulPassWhere`). A run still in progress, or one that failed,
 * vouches for nothing.
 *
 * `analysedAtCandle` is the newest candle any such pass read, and `recordedAt`
 * when the newest result was written — both rise with every pass, so they are
 * the latest pass's. A setup no pass has read is absent, and the caller falls
 * back to the creation read. Read-only, one query however many setups.
 */
export async function lastScanReads(setupIds: string[]): Promise<Map<string, AnalysisRead>> {
  const reads = new Map<string, AnalysisRead>();
  if (setupIds.length === 0) return reads;

  const groups = await prisma.scannerResult.groupBy({
    by: ["trackedSetupId"],
    where: { trackedSetupId: { in: setupIds }, status: "OK", scannerRun: successfulPassWhere() },
    _max: { analysedAtCandle: true, createdAt: true },
  });

  for (const group of groups) {
    if (!group.trackedSetupId) continue;
    const candle = group._max.analysedAtCandle;
    reads.set(group.trackedSetupId, {
      analysedAtCandle: candle === null ? null : Number(candle),
      recordedAt: group._max.createdAt?.getTime() ?? null,
    });
  }

  return reads;
}

/**
 * One setup with its full event history.
 *
 * Returns null for a setup belonging to someone else rather than throwing, so
 * the route answers 404 and the endpoint cannot be used to probe for another
 * account's rows — the same rule every other user-scoped handler follows.
 */
export async function findSetup(userId: string, id: string) {
  const row = await prisma.trackedSetup.findFirst({
    where: { id, userId },
    include: {
      tradingPair: { select: { exchangeSymbol: true, asset: { select: { symbol: true } } } },
      events: { orderBy: { createdAt: "asc" } },
      _count: { select: { events: true } },
    },
  });

  if (!row) return null;

  return {
    ...serialiseSetup(row),
    events: row.events.map((event) => ({
      id: event.id,
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      detail: event.detail,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    })),
  };
}

type SetupRow = Prisma.TrackedSetupGetPayload<{
  include: {
    tradingPair: { select: { exchangeSymbol: true; asset: { select: { symbol: true } } } };
    _count: { select: { events: true } };
  };
}>;

function serialiseSetup(row: SetupRow) {
  return {
    id: row.id,
    symbol: row.tradingPair.exchangeSymbol,
    asset: row.tradingPair.asset.symbol,
    tradingPairId: row.tradingPairId,
    timeframe: row.timeframe,
    status: row.status,
    entryLow: Number(row.entryLow),
    entryHigh: Number(row.entryHigh),
    stopLoss: Number(row.stopLoss),
    takeProfit1: row.takeProfit1 === null ? null : Number(row.takeProfit1),
    takeProfit2: row.takeProfit2 === null ? null : Number(row.takeProfit2),
    takeProfit3: row.takeProfit3 === null ? null : Number(row.takeProfit3),
    riskReward: Number(row.riskReward),
    riskRewardIsSynthetic: row.riskRewardIsSynthetic,
    score: row.score,
    scoreGrade: row.scoreGrade,
    analysisStatus: row.analysisStatus,
    snapshot: row.snapshot,
    /** Open time of the last closed candle the creating analysis read. */
    analysedAtCandle: createdFromCandle(row.snapshot),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
    invalidationReason: row.invalidationReason,
    eventCount: row._count.events,
  };
}

function createdFromCandle(snapshot: Prisma.JsonValue): number | null {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>).createdFromCandleTime;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
