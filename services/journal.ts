import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  computeOutcome,
  validateOutcome,
  validateTransition,
  type JournalDecision,
  type JournalError,
  type JournalSkipReason,
  type TradeOutcomeInput,
} from "@/lib/journal";

/**
 * Journal persistence.
 *
 * Every query is scoped by `userId` in the `where` rather than filtered after
 * the fact, so another account's entry matches nothing and the route answers
 * 404 — the endpoint cannot be used to discover which ids exist.
 *
 * The rules live in `lib/journal`; this file executes them.
 */

export type JournalResult<T> = { ok: true; value: T } | { ok: false; errors: JournalError[] };

/**
 * Creates the journal entry for a setup, or returns the one that already
 * exists.
 *
 * Idempotent by the unique index on `trackedSetupId`: journaling the same
 * setup twice is a mistake rather than a second opinion, and the second
 * attempt returns the first entry instead of racing it.
 *
 * Freezes the lifecycle state at this moment, because the setup will move on
 * and the decision was made against where it was, not where it ends up.
 */
export async function createEntry(input: {
  userId: string;
  trackedSetupId: string;
  decision?: JournalDecision;
  notes?: string;
}): Promise<JournalResult<{ id: string; created: boolean }>> {
  const setup = await prisma.trackedSetup.findFirst({
    where: { id: input.trackedSetupId, userId: input.userId },
    select: { id: true, status: true },
  });

  if (!setup) {
    return {
      ok: false,
      errors: [{ code: "INVALID_TRANSITION", field: "trackedSetupId", message: "No such setup." }],
    };
  }

  const existing = await prisma.journalEntry.findUnique({
    where: { trackedSetupId: input.trackedSetupId },
    select: { id: true, userId: true },
  });

  if (existing) {
    // Owned by someone else is indistinguishable from missing, deliberately.
    if (existing.userId !== input.userId) {
      return {
        ok: false,
        errors: [
          { code: "INVALID_TRANSITION", field: "trackedSetupId", message: "No such setup." },
        ],
      };
    }
    return { ok: true, value: { id: existing.id, created: false } };
  }

  const decision = input.decision ?? "WATCHING";

  const entry = await prisma.journalEntry.create({
    data: {
      userId: input.userId,
      trackedSetupId: setup.id,
      decision,
      setupStatusAtDecision: setup.status,
      notes: input.notes,
      events: {
        create: {
          type: "CREATED",
          fromDecision: null,
          toDecision: decision,
          detail: `Journaled while the setup was ${setup.status.toLowerCase().replace(/_/g, " ")}.`,
        },
      },
    },
    select: { id: true },
  });

  return { ok: true, value: { id: entry.id, created: true } };
}

/**
 * Records a change of mind.
 *
 * Appends an event rather than only overwriting `decision`: "what did I
 * decide?" is rarely one answer, and the sequence is the part worth keeping.
 * A decision that has not moved writes nothing at all.
 */
export async function updateDecision(input: {
  userId: string;
  id: string;
  decision: JournalDecision;
  skipReason?: JournalSkipReason;
  notes?: string;
}): Promise<JournalResult<{ changed: boolean }>> {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: input.id, userId: input.userId },
    select: { id: true, decision: true },
  });

  if (!entry) {
    return {
      ok: false,
      errors: [{ code: "INVALID_TRANSITION", field: "id", message: "No such journal entry." }],
    };
  }

  const from = entry.decision as JournalDecision;
  const error = validateTransition(from, input.decision);
  if (error) return { ok: false, errors: [error] };

  const unchanged = from === input.decision;
  const notesChanged = input.notes !== undefined;

  if (unchanged && !notesChanged && input.skipReason === undefined) {
    return { ok: true, value: { changed: false } };
  }

  await prisma.$transaction([
    prisma.journalEntry.update({
      where: { id: entry.id },
      data: {
        decision: input.decision,
        ...(input.skipReason !== undefined ? { skipReason: input.skipReason } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    }),
    prisma.journalEvent.create({
      data: {
        journalEntryId: entry.id,
        type: unchanged ? "NOTE_ADDED" : "DECISION_CHANGED",
        fromDecision: unchanged ? null : from,
        toDecision: input.decision,
        detail: unchanged
          ? "Notes updated."
          : `Decision changed from ${from.toLowerCase()} to ${input.decision.toLowerCase()}.` +
            (input.skipReason
              ? ` Reason: ${input.skipReason.toLowerCase().replace(/_/g, " ")}.`
              : ""),
      },
    }),
  ]);

  return { ok: true, value: { changed: !unchanged } };
}

/**
 * Records what a taken position actually did.
 *
 * The numbers are the user's own — their fill, their stop, their fees. Nothing
 * is taken from the setup's plan: the difference between the plan and the fill
 * is one of the things the journal exists to preserve.
 */
export async function recordOutcome(input: {
  userId: string;
  id: string;
  outcome: TradeOutcomeInput;
  close?: boolean;
}): Promise<JournalResult<{ realizedR: number | null }>> {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: input.id, userId: input.userId },
    select: { id: true, decision: true },
  });

  if (!entry) {
    return {
      ok: false,
      errors: [{ code: "INVALID_TRANSITION", field: "id", message: "No such journal entry." }],
    };
  }

  const from = entry.decision as JournalDecision;
  const target: JournalDecision = input.close ? "CLOSED" : from;

  if (input.close) {
    const transitionError = validateTransition(from, "CLOSED");
    if (transitionError) return { ok: false, errors: [transitionError] };
  }

  const errors = validateOutcome(target, input.outcome);
  if (errors.length > 0) return { ok: false, errors };

  const outcome = computeOutcome(input.outcome);

  await prisma.$transaction([
    prisma.journalEntry.update({
      where: { id: entry.id },
      data: {
        ...(input.close ? { decision: "CLOSED" as const } : {}),
        actualEntry: input.outcome.actualEntry,
        actualStopLoss: input.outcome.actualStopLoss ?? null,
        actualTakeProfit: input.outcome.actualTakeProfit ?? null,
        actualExit: input.outcome.actualExit ?? null,
        quantity: input.outcome.quantity,
        fees: input.outcome.fees ?? null,
        slippage: input.outcome.slippage ?? null,
        exitReason: input.outcome.exitReason ?? null,
        openedAt: input.outcome.openedAt ? new Date(input.outcome.openedAt) : null,
        closedAt: input.outcome.closedAt ? new Date(input.outcome.closedAt) : null,
      },
    }),
    prisma.journalEvent.create({
      data: {
        journalEntryId: entry.id,
        type: "OUTCOME_RECORDED",
        fromDecision: from === target ? null : from,
        toDecision: target,
        // An already-closed entry being written again is a correction, not a
        // second trade. Saying so keeps the history readable — two identical
        // "recorded" lines would look like the position was taken twice.
        detail:
          (from === "CLOSED" ? "Amended. " : "") +
          (outcome.realizedR === null
            ? "Trade details recorded; no result yet."
            : `Recorded ${outcome.realizedR.toFixed(2)}R on the risk actually taken.`),
      },
    }),
  ]);

  return { ok: true, value: { realizedR: outcome.realizedR } };
}

export interface ListJournalQuery {
  userId: string;
  decision?: JournalDecision;
  limit: number;
  cursor?: string;
}

/** The caller's entries, newest decision first, paginated. */
export async function listEntries(query: ListJournalQuery) {
  const rows = await prisma.journalEntry.findMany({
    where: {
      userId: query.userId,
      ...(query.decision ? { decision: query.decision } : {}),
    },
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: { trackedSetup: { include: SETUP_INCLUDE } },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    entries: page.map(serialise),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

const SETUP_INCLUDE = {
  tradingPair: { select: { exchangeSymbol: true } },
} as const;

/** One entry with its full decision history and the engine's own record. */
export async function findEntry(userId: string, id: string) {
  const row = await prisma.journalEntry.findFirst({
    where: { id, userId },
    include: {
      trackedSetup: {
        include: {
          ...SETUP_INCLUDE,
          events: { orderBy: { createdAt: "asc" } },
        },
      },
      events: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!row) return null;

  return {
    ...serialise(row),
    // What SpotLens said, kept whole and separate from what the user did.
    setupEvents: row.trackedSetup.events.map((event) => ({
      id: event.id,
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      detail: event.detail,
      createdAt: event.createdAt.toISOString(),
    })),
    journalEvents: row.events.map((event) => ({
      id: event.id,
      type: event.type,
      fromDecision: event.fromDecision,
      toDecision: event.toDecision,
      detail: event.detail,
      createdAt: event.createdAt.toISOString(),
    })),
    snapshot: row.trackedSetup.snapshot,
  };
}

type EntryRow = Prisma.JournalEntryGetPayload<{
  include: { trackedSetup: { include: typeof SETUP_INCLUDE } };
}>;

function serialise(row: EntryRow) {
  const setup = row.trackedSetup;
  const outcome = computeOutcome({
    actualEntry: Number(row.actualEntry ?? 0),
    actualStopLoss: row.actualStopLoss === null ? undefined : Number(row.actualStopLoss),
    actualExit: row.actualExit === null ? undefined : Number(row.actualExit),
    quantity: Number(row.quantity ?? 0),
    fees: row.fees === null ? undefined : Number(row.fees),
    slippage: row.slippage === null ? undefined : Number(row.slippage),
    openedAt: row.openedAt?.getTime(),
    closedAt: row.closedAt?.getTime(),
  });

  const hasTrade = row.actualEntry !== null && row.quantity !== null;

  return {
    id: row.id,
    decision: row.decision,
    skipReason: row.skipReason,
    notes: row.notes,
    setupStatusAtDecision: row.setupStatusAtDecision,
    decidedAt: row.decidedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),

    // --- what SpotLens said, read from the immutable setup snapshot --------
    setup: {
      id: setup.id,
      symbol: setup.tradingPair.exchangeSymbol,
      timeframe: setup.timeframe,
      currentStatus: setup.status,
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
      createdAt: setup.createdAt.toISOString(),
      invalidationReason: setup.invalidationReason,
    },

    // --- what the user did -------------------------------------------------
    trade: hasTrade
      ? {
          actualEntry: Number(row.actualEntry),
          actualStopLoss: row.actualStopLoss === null ? null : Number(row.actualStopLoss),
          actualTakeProfit: row.actualTakeProfit === null ? null : Number(row.actualTakeProfit),
          actualExit: row.actualExit === null ? null : Number(row.actualExit),
          quantity: Number(row.quantity),
          fees: row.fees === null ? null : Number(row.fees),
          slippage: row.slippage === null ? null : Number(row.slippage),
          exitReason: row.exitReason,
          openedAt: row.openedAt?.toISOString() ?? null,
          closedAt: row.closedAt?.toISOString() ?? null,
          grossPnl: outcome.grossPnl,
          netPnl: outcome.netPnl,
          riskAmount: outcome.riskAmount,
          realizedR: outcome.realizedR,
          holdingMs: outcome.holdingMs,
        }
      : null,
  };
}
