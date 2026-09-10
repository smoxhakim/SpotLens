import type { Prisma } from "@prisma/client";

import type { AnalysisResult } from "@/lib/analysis";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";
import type { Timeframe } from "@/lib/market-data/provider";
import {
  reconcileSetup,
  type ExistingSetup,
  type PlannedCreate,
  type PlannedTransition,
  type SetupLifecycleStatus,
  type SetupPlan,
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

export interface TrackSetupOutcome {
  action: SetupPlan["action"];
  setupId: string | null;
  status: SetupLifecycleStatus | null;
  /** Why nothing was written, when nothing was. */
  reason: string | null;
}

const NOTHING: TrackSetupOutcome = { action: "NONE", setupId: null, status: null, reason: null };

/**
 * Reconciles one analysis run against the stored setup for that pair and
 * timeframe.
 *
 * Never throws. Losing lifecycle history must not fail the analysis the user
 * asked for — the same rule the snapshot writer follows.
 *
 * Writes nothing at all when the state has not moved, which is what stops a
 * scanner re-running every few minutes from filling the table with identical
 * rows.
 */
export async function trackSetup(input: TrackSetupInput): Promise<TrackSetupOutcome> {
  if (!isDatabaseConfigured) return NOTHING;

  try {
    const existing = await findOpenSetup(input);
    const plan = reconcileSetup({ existing, result: input.result });

    switch (plan.action) {
      case "NONE":
        return { action: "NONE", setupId: existing?.id ?? null, status: null, reason: plan.reason };

      case "CREATE": {
        const id = await createSetup(input, plan.create);
        return { action: "CREATE", setupId: id, status: plan.create.status, reason: null };
      }

      case "TRANSITION": {
        await applyTransition(plan.transition);
        return {
          action: "TRANSITION",
          setupId: plan.transition.setupId,
          status: plan.transition.to,
          reason: null,
        };
      }

      case "REPLACE": {
        // Ordered, and in one transaction: the old setup is closed before the
        // new one exists, so a reader can never see two open setups on the same
        // level.
        const id = await prisma.$transaction(async () => {
          await applyTransition(plan.invalidate);
          return createSetup(input, plan.create);
        });
        return { action: "REPLACE", setupId: id, status: plan.create.status, reason: null };
      }
    }
  } catch (err) {
    warnOnce("setups:track", "[setups] could not update setup lifecycle.", err);
    return NOTHING;
  }
}

/**
 * The open setup for this user, pair and timeframe.
 *
 * Scoped by `userId` at the query, not filtered afterwards — one person's setup
 * history must never be reachable from another account. Most recent wins if
 * more than one is somehow open; `trackSetup` closes the old one whenever the
 * level changes, so that should not happen.
 */
async function findOpenSetup(input: TrackSetupInput): Promise<ExistingSetup | null> {
  const row = await prisma.trackedSetup.findFirst({
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

async function createSetup(input: TrackSetupInput, create: PlannedCreate): Promise<string> {
  const { snapshot } = create;
  const now = new Date();

  const row = await prisma.trackedSetup.create({
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
    select: { id: true },
  });

  return row.id;
}

/**
 * Applies one transition and appends its event.
 *
 * The snapshot columns are never named here — that is what makes them
 * immutable. `confirmedAt` is stamped only when it is still null, so a setup
 * that loses and regains confirmation keeps the time of the first one.
 */
async function applyTransition(transition: PlannedTransition): Promise<void> {
  const now = new Date();
  const invalidating = transition.to === "INVALIDATED";

  await prisma.$transaction([
    prisma.trackedSetup.update({
      where: { id: transition.setupId },
      data: {
        status: transition.to,
        ...(transition.marksConfirmed ? { confirmedAt: { set: now } } : {}),
        ...(invalidating
          ? { invalidatedAt: now, invalidationReason: transition.invalidationReason }
          : {}),
      },
    }),
    prisma.setupEvent.create({
      data: {
        setupId: transition.setupId,
        type: transition.event.type,
        fromStatus: transition.from,
        toStatus: transition.to,
        detail: transition.event.detail,
        payload: transition.event.payload ? toJson(transition.event.payload) : undefined,
      },
    }),
  ]);
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

  return rows.map(serialiseSetup);
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
    invalidationReason: row.invalidationReason,
    eventCount: row._count.events,
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
