import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  buildAmendmentPayload,
  buildDecisionContext,
  coachWasRead,
  computeOutcome,
  readAmendmentPayload,
  readDecisionContext,
  supersededVersions,
  validateOutcome,
  validateTransition,
  type CoachReference,
  type JournalDecision,
  type JournalError,
  type JournalSkipReason,
  type TradeOutcomeInput,
} from "@/lib/journal";
import { gradeFor as gradeForScore } from "@/lib/analysis";
import type { Timeframe } from "@/lib/market-data/provider";

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
 * What a decision is recorded against.
 *
 * Two kinds, because the scanner produces two kinds of thing: markets it began
 * following, which have an immutable setup snapshot, and markets it merely
 * scored, which have a scanner result and no levels at all. Collapsing them
 * would mean inventing an entry for the second kind, which is the one outcome
 * this whole record exists to prevent.
 */
export type JournalTarget =
  | { kind: "TRACKED"; trackedSetupId: string }
  | { kind: "UNTRACKED"; scannerRunId: string; symbol: string; timeframe: Timeframe };

export interface CreateEntryInput {
  userId: string;
  target: JournalTarget;
  decision?: JournalDecision;
  notes?: string;
  /** A Coach review the user had read, when they had read one. */
  coach?: Omit<CoachReference, "recordedAt"> | null;
}

/**
 * Creates the journal entry for an opportunity, or returns the one that
 * already exists.
 *
 * Idempotent in both directions — the unique index on `trackedSetupId` for a
 * tracked setup, and on (user, run, pair, timeframe) for an untracked one.
 * Journaling the same opportunity twice is a mistake rather than a second
 * opinion, so the second attempt returns the first entry instead of racing it.
 *
 * Freezes the lifecycle state at this moment for a tracked setup, because the
 * setup will move on and the decision was made against where it was.
 */
export async function createEntry(
  input: CreateEntryInput,
): Promise<JournalResult<{ id: string; created: boolean }>> {
  return input.target.kind === "TRACKED"
    ? createTrackedEntry(input, input.target)
    : createUntrackedEntry(input, input.target);
}

/**
 * The moment a decision is recorded, from the server's clock.
 *
 * Never the browser's. A timestamp the client sent is a timestamp the client
 * chose, and the ordering of decisions is exactly the thing replay and research
 * read — `decidedAt` also defaults to `now()` in the column, so there is no
 * path by which a request can set it.
 */
function coachReferenceFrom(
  coach: Omit<CoachReference, "recordedAt"> | null | undefined,
): CoachReference | null {
  if (!coach) return null;
  return { providerId: coach.providerId, verdict: coach.verdict, recordedAt: Date.now() };
}

async function createTrackedEntry(
  input: CreateEntryInput,
  target: { trackedSetupId: string },
): Promise<JournalResult<{ id: string; created: boolean }>> {
  const setup = await prisma.trackedSetup.findFirst({
    where: { id: target.trackedSetupId, userId: input.userId },
    select: { id: true, status: true },
  });

  if (!setup) {
    return {
      ok: false,
      errors: [{ code: "INVALID_TRANSITION", field: "trackedSetupId", message: "No such setup." }],
    };
  }

  const existing = await prisma.journalEntry.findUnique({
    where: { trackedSetupId: target.trackedSetupId },
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
          ...payloadOf({
            source: "TRACKED_SETUP",
            runId: null,
            coach: coachReferenceFrom(input.coach),
          }),
        },
      },
    },
    select: { id: true },
  });

  return { ok: true, value: { id: entry.id, created: true } };
}

/**
 * A decision about a market the scanner scored but never tracked.
 *
 * Referenced, not copied: the row points at (run, pair, timeframe) and stores
 * no levels, no score and no verdict of its own. `ScannerResult` is written
 * once per pass and never updated, so those three references resolve the same
 * numbers for ever — which is the same guarantee `TrackedSetup`'s frozen
 * columns give, obtained without a second copy that could drift from it.
 *
 * There is deliberately nothing here that invents an entry, a stop, a target or
 * a ratio. The scanner never produced them for this market, and a journal that
 * filled the gap would be recording a plan nobody was shown.
 */
async function createUntrackedEntry(
  input: CreateEntryInput,
  target: { scannerRunId: string; symbol: string; timeframe: Timeframe },
): Promise<JournalResult<{ id: string; created: boolean }>> {
  const candidate = await prisma.scannerResult.findFirst({
    where: {
      scannerRunId: target.scannerRunId,
      timeframe: target.timeframe,
      status: "OK",
      tradingPair: { exchangeSymbol: target.symbol },
    },
    select: { tradingPairId: true, analysisStatus: true, score: true, trackedSetupId: true },
  });

  if (!candidate || candidate.analysisStatus === null || candidate.score === null) {
    return {
      ok: false,
      errors: [
        { code: "INVALID_TRANSITION", field: "runId", message: "No such analysis in that scan." },
      ],
    };
  }

  // A candidate that *does* have a setup is journaled against the setup, which
  // is the richer record. Accepting it here would mint a second entry for the
  // same opportunity and split its history across two rows.
  if (candidate.trackedSetupId) {
    return createTrackedEntry(input, { trackedSetupId: candidate.trackedSetupId });
  }

  const existing = await prisma.journalEntry.findFirst({
    where: {
      userId: input.userId,
      scannerRunId: target.scannerRunId,
      tradingPairId: candidate.tradingPairId,
      timeframe: target.timeframe,
    },
    select: { id: true },
  });

  if (existing) return { ok: true, value: { id: existing.id, created: false } };

  const decision = input.decision ?? "WATCHING";

  const entry = await prisma.journalEntry.create({
    data: {
      userId: input.userId,
      scannerRunId: target.scannerRunId,
      tradingPairId: candidate.tradingPairId,
      timeframe: target.timeframe,
      decision,
      // Null, not a default. This opportunity has no lifecycle to be at a
      // point in, and writing one here would claim a state never recorded.
      setupStatusAtDecision: null,
      notes: input.notes,
      events: {
        create: {
          type: "CREATED",
          fromDecision: null,
          toDecision: decision,
          detail:
            "Journaled from a scanner result. SpotLens scored this market but never tracked a setup for it, so there are no levels on the record.",
          ...payloadOf({
            source: "SCANNER_RESULT",
            runId: target.scannerRunId,
            coach: coachReferenceFrom(input.coach),
          }),
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
  coach?: Omit<CoachReference, "recordedAt"> | null;
}): Promise<JournalResult<{ changed: boolean }>> {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: input.id, userId: input.userId },
    select: { id: true, decision: true, trackedSetupId: true, scannerRunId: true },
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
      // `decidedAt` is deliberately absent. It records when the decision was
      // first made, and editing a note days later is not a new decision — the
      // sequence of changes lives in the events, where it belongs. Replay reads
      // `decidedAt` as its cutoff, so moving it would silently re-date history.
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
        // What was on screen for *this* change of mind. A review read before
        // the first decision does not describe the second one, so each event
        // carries its own context rather than the entry carrying one.
        ...payloadOf({
          source: entry.trackedSetupId ? "TRACKED_SETUP" : "SCANNER_RESULT",
          runId: entry.scannerRunId,
          coach: coachReferenceFrom(input.coach),
        }),
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
 *
 * A recording over one already there is a correction, and correcting a
 * mistyped fill has no other route. So it stays allowed — but the values being
 * replaced are written onto the event that replaces them first, in full. The
 * entry keeps the latest numbers; every earlier version stays recoverable from
 * the append-only event log, in order.
 */
export async function recordOutcome(input: {
  userId: string;
  id: string;
  outcome: TradeOutcomeInput;
  close?: boolean;
}): Promise<JournalResult<{ realizedR: number | null }>> {
  const entry = await prisma.journalEntry.findFirst({
    where: { id: input.id, userId: input.userId },
    // The trade columns are read, not just the decision: they are about to be
    // overwritten, and they cannot be preserved after that.
    select: {
      id: true,
      decision: true,
      actualEntry: true,
      actualStopLoss: true,
      actualTakeProfit: true,
      actualExit: true,
      quantity: true,
      fees: true,
      slippage: true,
      exitReason: true,
      openedAt: true,
      closedAt: true,
    },
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

  // Whatever is about to be replaced, captured before the update runs. Null on
  // a first recording — nothing was superseded.
  const superseded = buildAmendmentPayload(
    {
      actualEntry: decimal(entry.actualEntry),
      actualStopLoss: decimal(entry.actualStopLoss),
      actualTakeProfit: decimal(entry.actualTakeProfit),
      actualExit: decimal(entry.actualExit),
      quantity: decimal(entry.quantity),
      fees: decimal(entry.fees),
      slippage: decimal(entry.slippage),
      exitReason: entry.exitReason,
      openedAt: entry.openedAt?.getTime() ?? null,
      closedAt: entry.closedAt?.getTime() ?? null,
    },
    Date.now(),
  );

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
        // The prose above is for a reader. This is the record: the complete
        // previous values, so the version being replaced can be reconstructed
        // rather than inferred from a sentence.
        ...(superseded ? { payload: toJson(superseded) } : {}),
      },
    }),
  ]);

  return { ok: true, value: { realizedR: outcome.realizedR } };
}

/**
 * The entry already recorded for an opportunity, if there is one.
 *
 * The decision surface needs this before it can offer anything: which moves are
 * legal depends on where the entry already is, and a panel that offered every
 * state regardless would let a reader press a button the service then refuses.
 *
 * Owner-scoped in the `where`, like everything else here, so another account's
 * entry is simply not found.
 */
export async function findEntryForOpportunity(
  userId: string,
  target: JournalTarget,
): Promise<{
  id: string;
  decision: JournalDecision;
  notes: string | null;
  skipReason: JournalSkipReason | null;
  decidedAt: string;
  coachReviewed: boolean;
} | null> {
  const row = await prisma.journalEntry.findFirst({
    where:
      target.kind === "TRACKED"
        ? { userId, trackedSetupId: target.trackedSetupId }
        : {
            userId,
            scannerRunId: target.scannerRunId,
            timeframe: target.timeframe,
            tradingPair: { exchangeSymbol: target.symbol },
          },
    select: {
      id: true,
      decision: true,
      notes: true,
      skipReason: true,
      decidedAt: true,
      events: { select: { payload: true } },
    },
  });

  if (!row) return null;

  return {
    id: row.id,
    decision: row.decision as JournalDecision,
    notes: row.notes,
    skipReason: row.skipReason as JournalSkipReason | null,
    decidedAt: row.decidedAt.toISOString(),
    coachReviewed: coachWasRead(row.events.map((event) => event.payload)),
  };
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
    include: ENTRY_INCLUDE,
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const candidates = await loadCandidates(page);

  return {
    entries: page.map((row) => serialise(row, candidateFor(row, candidates))),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

const SETUP_INCLUDE = {
  tradingPair: { select: { exchangeSymbol: true } },
} as const;

/**
 * Everything a serialised entry reads.
 *
 * The untracked references sit alongside the setup rather than replacing it:
 * exactly one of the two is present on any row, and loading both means the
 * serialiser decides from the data instead of the caller having to know which
 * kind it asked for.
 */
const ENTRY_INCLUDE = {
  trackedSetup: { include: SETUP_INCLUDE },
  tradingPair: { select: { exchangeSymbol: true } },
  scannerRun: { select: { id: true, startedAt: true } },
  // Payloads only. Enough to answer "was a Coach review read", without
  // dragging every event's prose into a list of fifty entries.
  events: { select: { payload: true } },
} as const;

/** The scanner's verdict for an untracked entry, resolved from its references. */
export interface CandidateFacts {
  analysisStatus: string | null;
  score: number | null;
}

function candidateKey(runId: string, pairId: string, timeframe: string): string {
  return `${runId}|${pairId}|${timeframe}`;
}

/**
 * The scanner results the untracked entries refer to, in one query.
 *
 * `ScannerResult` has no relation to `JournalEntry` — the reference is the
 * three columns, deliberately, so that deleting a journal entry cannot touch
 * the scan record and a scan record has no idea it was journaled. That costs
 * one extra query per page rather than an N+1, which at a page of fifty is the
 * right trade.
 */
async function loadCandidates(
  rows: { scannerRunId: string | null; tradingPairId: string | null; timeframe: unknown }[],
): Promise<Map<string, CandidateFacts>> {
  const references = rows.flatMap((row) =>
    row.scannerRunId === null || row.tradingPairId === null || row.timeframe === null
      ? []
      : [
          {
            scannerRunId: row.scannerRunId,
            tradingPairId: row.tradingPairId,
            timeframe: row.timeframe as Timeframe,
          },
        ],
  );

  if (references.length === 0) return new Map();

  const results = await prisma.scannerResult.findMany({
    where: { OR: references },
    select: {
      scannerRunId: true,
      tradingPairId: true,
      timeframe: true,
      analysisStatus: true,
      score: true,
    },
  });

  return new Map(
    results.map((result) => [
      candidateKey(result.scannerRunId, result.tradingPairId, result.timeframe),
      { analysisStatus: result.analysisStatus, score: result.score },
    ]),
  );
}

/** The facts for one row, when it is an untracked entry. */
function candidateFor(
  row: { scannerRunId: string | null; tradingPairId: string | null; timeframe: unknown },
  candidates: Map<string, CandidateFacts>,
): CandidateFacts | null {
  if (row.scannerRunId === null || row.tradingPairId === null || row.timeframe === null) {
    return null;
  }
  return (
    candidates.get(candidateKey(row.scannerRunId, row.tradingPairId, String(row.timeframe))) ?? null
  );
}

/** One entry with its full decision history and the engine's own record. */
export async function findEntry(userId: string, id: string) {
  const row = await prisma.journalEntry.findFirst({
    where: { id, userId },
    include: {
      ...ENTRY_INCLUDE,
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

  const candidates = await loadCandidates([row]);

  return {
    ...serialise(row, candidateFor(row, candidates)),
    // What SpotLens said, kept whole and separate from what the user did.
    // Empty for an untracked opportunity: there is no setup, so there is no
    // lifecycle, and an empty list says that more honestly than an absent key.
    setupEvents: (row.trackedSetup?.events ?? []).map((event) => ({
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
      // The values this event replaced, when it replaced any. Null on a first
      // recording and on every event written before the column existed.
      supersededOutcome: readAmendmentPayload(event.payload),
      // What was on screen when this decision was made — which record it was
      // read from, and whether a Coach review had been read. Never a judgement
      // on the decision itself. Null on events written before Phase O.
      decisionContext: readDecisionContext(event.payload),
    })),
    // Every previous version of the trade, oldest first. The entry's own
    // `trade` above is the current one, so the two together are the full
    // sequence.
    supersededVersions: supersededVersions(
      row.events.map((event) => ({
        payload: event.payload,
        createdAt: event.createdAt.getTime(),
      })),
    ),
    snapshot: row.trackedSetup?.snapshot ?? null,
  };
}

type EntryRow = Prisma.JournalEntryGetPayload<{ include: typeof ENTRY_INCLUDE }> & {
  events?: { payload: Prisma.JsonValue }[];
};

function serialise(row: EntryRow, candidate?: CandidateFacts | null) {
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

    // Which kind of record this decision was made against. Stated rather than
    // inferred from whether `setup` is null, because a reader needs to know
    // that the absence of levels is a fact about the opportunity and not a
    // gap in the record.
    source: setup ? ("TRACKED_SETUP" as const) : ("SCANNER_RESULT" as const),

    // The market, which both kinds have.
    symbol: setup?.tradingPair.exchangeSymbol ?? row.tradingPair?.exchangeSymbol ?? null,
    timeframe: setup?.timeframe ?? row.timeframe ?? null,

    // --- what SpotLens said, read from the immutable setup snapshot --------
    setup: setup
      ? {
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
        }
      : null,

    // --- or, for a market that was scored but never followed ---------------
    //
    // The verdict and the score, and nothing else. No entry, no stop, no
    // target and no ratio, because the scanner produced none for this market
    // and the journal is not the place to start producing them.
    opportunity:
      setup || row.scannerRunId === null
        ? null
        : {
            runId: row.scannerRunId,
            scannedAt: row.scannerRun?.startedAt.toISOString() ?? null,
            analysisStatus: candidate?.analysisStatus ?? null,
            score: candidate?.score ?? null,
            scoreGrade:
              candidate?.score === undefined || candidate?.score === null
                ? null
                : gradeForScore(candidate.score),
          },

    /**
     * Whether a Coach review had been read by the time of any decision on this
     * entry. Never "the Coach approved" — the Coach reads the same analysis the
     * user does, and the user may have decided the opposite.
     */
    coachReviewed: coachWasRead((row.events ?? []).map((event) => event.payload)),

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

/** Prisma `Decimal | null` as the plain number the rest of the code uses. */
function decimal(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * The decision context as an event payload, or nothing.
 *
 * A sibling key beside `supersededOutcome`, never a replacement for it:
 * `readAmendmentPayload` looks only at its own key and ignores the rest, so
 * the two coexist on one event without either needing to know about the other.
 */
function payloadOf(context: Parameters<typeof buildDecisionContext>[0]) {
  return { payload: toJson(buildDecisionContext(context)) };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
