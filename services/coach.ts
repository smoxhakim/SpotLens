// The engine's own grading, imported rather than restated: the scanner stores
// the total and not the grade, and a threshold written again here could drift.
import { gradeFor as gradeForScore } from "@/lib/analysis";
import { prisma } from "@/lib/db/prisma";
import {
  contextFromScannerCandidate,
  contextFromTrackedSetup,
  resolveCoachProvider,
  reviewWith,
  type CoachProvider,
  type CoachResult,
} from "@/lib/coach";
import type { Timeframe } from "@/lib/market-data/provider";

/**
 * Resolving a Coach review from what was actually recorded.
 *
 * The only part of the Coach that touches the database. Everything it hands to
 * the pure layer is read from a stored row — nothing is passed through from the
 * request, because a caller that could supply an entry price could supply a
 * different one, and the whole point is that the numbers are SpotLens's.
 *
 * Two resolutions, in order of fidelity:
 *
 *  - A `setupId` resolves to the immutable snapshot the lifecycle froze at
 *    creation, which is the richest and most honest source: it is what was on
 *    offer at the time, not what today's candles would produce.
 *  - Without one, the scanner result for that market in that run. It carries
 *    the verdict, the score and the context but no levels, and none are
 *    reconstructed — see `contextFromScannerCandidate`.
 */

export type CoachLookupFailure =
  { reason: "RUN_NOT_FOUND" } | { reason: "CANDIDATE_NOT_FOUND" } | { reason: "SETUP_NOT_FOUND" };

export type CoachLookup =
  { ok: true; result: CoachResult; degraded: boolean } | { ok: false; failure: CoachLookupFailure };

export interface CoachRequest {
  userId: string;
  symbol: string;
  timeframe: Timeframe;
  runId: string;
  setupId?: string | null;
}

/**
 * The provider a request uses.
 *
 * Resolved per call rather than at module load so a test can pass its own and
 * the default is never a live one by accident. With no key configured this is
 * the deterministic reviewer, which is what keeps the suite offline and free.
 */
export async function buildCoachReview(
  request: CoachRequest,
  provider: CoachProvider = resolveCoachProvider().provider,
): Promise<CoachLookup> {
  // The run is resolved first and always, even for a tracked setup: it is the
  // context the reader was looking at, and a review that silently accepted an
  // unknown run would be reviewing something else.
  const run = await prisma.scannerRun.findUnique({
    where: { id: request.runId },
    select: { id: true },
  });
  if (!run) return { ok: false, failure: { reason: "RUN_NOT_FOUND" } };

  if (request.setupId) {
    const setup = await prisma.trackedSetup.findFirst({
      // Ownership in the `where`, not checked after loading: a scoped query
      // never brings another account's row into the process, so no later change
      // to what this returns can leak one. A setup belonging to someone else is
      // indistinguishable from one that does not exist.
      where: { id: request.setupId, userId: request.userId },
      include: {
        tradingPair: { select: { exchangeSymbol: true } },
        // The *first* event, not the latest: the one written with the setup,
        // carrying confirmation as it stood when the snapshot was frozen.
        //
        // Reading the latest was lookahead, and the kind that is easy to miss
        // because it looks like freshness. Every other field here is the
        // immutable snapshot from creation, so pairing it with a confirmation
        // recorded days later describes a moment that never existed — levels
        // from then, evidence from now — which is the same mistake the
        // notification layer made once with a frozen status line.
        //
        // Ordering by ascending time rather than filtering on the setup's own
        // `createdAt` avoids a race: the row and its first event are written in
        // one statement and their timestamps can differ by microseconds either
        // way. The earliest event is the creation event by construction.
        events: { orderBy: { createdAt: "asc" }, take: 1 },
      },
    });

    if (!setup) return { ok: false, failure: { reason: "SETUP_NOT_FOUND" } };

    const event = setup.events[0];

    const context = contextFromTrackedSetup(
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
        takeProfit1: setup.takeProfit1 === null ? null : Number(setup.takeProfit1),
        takeProfit2: setup.takeProfit2 === null ? null : Number(setup.takeProfit2),
        takeProfit3: setup.takeProfit3 === null ? null : Number(setup.takeProfit3),
        riskReward: Number(setup.riskReward),
        riskRewardIsSynthetic: setup.riskRewardIsSynthetic,
        invalidationReason: setup.invalidationReason,
        createdAt: setup.createdAt.getTime(),
        snapshot: (setup.snapshot ?? {}) as Record<string, unknown>,
        confirmationPayload: (event?.payload ?? null) as Record<string, unknown> | null,
      },
      run.id,
    );

    const { review, degraded } = await reviewWith(provider, context);
    return { ok: true, result: { context, review }, degraded };
  }

  const candidate = await prisma.scannerResult.findFirst({
    where: {
      scannerRunId: run.id,
      timeframe: request.timeframe,
      status: "OK",
      tradingPair: { exchangeSymbol: request.symbol },
    },
    include: { tradingPair: { select: { exchangeSymbol: true } } },
  });

  if (!candidate || candidate.analysisStatus === null || candidate.score === null) {
    return { ok: false, failure: { reason: "CANDIDATE_NOT_FOUND" } };
  }

  const context = contextFromScannerCandidate(
    {
      symbol: candidate.tradingPair.exchangeSymbol,
      timeframe: candidate.timeframe,
      analysisStatus: candidate.analysisStatus,
      score: candidate.score,
      scoreGrade: gradeForScore(candidate.score),
      riskReward: candidate.riskReward === null ? null : Number(candidate.riskReward),
      riskRewardIsSynthetic: candidate.riskRewardIsSynthetic,
      trend: candidate.trend,
      mtfAgreement: candidate.mtfAgreement,
      regimeDirection: candidate.regimeDirection,
      analysedAtCandle:
        candidate.analysedAtCandle === null ? null : Number(candidate.analysedAtCandle),
      recordedAt: candidate.createdAt.getTime(),
    },
    run.id,
  );

  const { review, degraded } = await reviewWith(provider, context);
  return { ok: true, result: { context, review }, degraded };
}
