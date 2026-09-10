import { prisma } from "@/lib/db/prisma";
import {
  buildResearchReport,
  type ResearchEntry,
  type ResearchFilters,
  type ResearchReport,
  type ResearchSetup,
} from "@/lib/research";

/**
 * Research queries.
 *
 * Filters are applied in the database rather than in memory, so a wide date
 * range does not mean loading every setup a user has ever had. The aggregation
 * itself is pure and lives in `lib/research`.
 */

/** Ceiling per query, so one request cannot pull an unbounded history. */
export const MAX_RESEARCH_ROWS = 5_000;

export async function runResearch(input: {
  userId: string;
  filters: ResearchFilters;
}): Promise<ResearchReport> {
  const { userId, filters } = input;

  const where = {
    userId,
    ...(filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lte: new Date(filters.to) } : {}),
          },
        }
      : {}),
    ...(filters.timeframe ? { timeframe: filters.timeframe as never } : {}),
    ...(filters.lifecycleStatus ? { status: filters.lifecycleStatus as never } : {}),
    ...(filters.symbol ? { tradingPair: { exchangeSymbol: filters.symbol } } : {}),
    ...(filters.minScore !== undefined || filters.maxScore !== undefined
      ? {
          score: {
            ...(filters.minScore !== undefined ? { gte: filters.minScore } : {}),
            ...(filters.maxScore !== undefined ? { lte: filters.maxScore } : {}),
          },
        }
      : {}),
    ...(filters.measuredRewardOnly !== undefined
      ? { riskRewardIsSynthetic: !filters.measuredRewardOnly }
      : {}),
  };

  // One query with the events included, rather than one query per setup: a
  // year of scanning is thousands of setups and the N+1 would be felt.
  const rows = await prisma.trackedSetup.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: MAX_RESEARCH_ROWS,
    include: {
      tradingPair: { select: { exchangeSymbol: true } },
      events: { select: { toStatus: true } },
      journalEntry: true,
    },
  });

  const setups: ResearchSetup[] = [];
  const entries: ResearchEntry[] = [];

  for (const row of rows) {
    const snapshot = (row.snapshot ?? {}) as {
      regime?: { direction?: string; volatility?: string } | null;
    };

    // Whether a setup *ever* reached a state, not where it ended: one that
    // confirmed and was later invalidated did both, and counting only the last
    // state would erase the confirmation that actually happened.
    const reached = new Set(row.events.map((e) => e.toStatus));

    const setup: ResearchSetup = {
      id: row.id,
      symbol: row.tradingPair.exchangeSymbol,
      timeframe: row.timeframe,
      lifecycleStatus: row.status,
      score: row.score,
      riskReward: Number(row.riskReward),
      riskRewardIsSynthetic: row.riskRewardIsSynthetic,
      confirmationStatus: reached.has("CONFIRMATION_DETECTED") ? "PRESENT" : null,
      regimeDirection: snapshot.regime?.direction ?? null,
      regimeVolatility: snapshot.regime?.volatility ?? null,
      createdAt: row.createdAt.getTime(),
      everConfirmed: reached.has("CONFIRMATION_DETECTED") || reached.has("POTENTIAL_SETUP"),
      everPotentialSetup: reached.has("POTENTIAL_SETUP"),
    };

    // Applied here rather than in SQL: both live on the snapshot JSON, and a
    // JSON path filter would be less readable than a predicate for no gain at
    // this scale.
    if (filters.regimeDirection && setup.regimeDirection !== filters.regimeDirection) continue;
    if (filters.volatility && setup.regimeVolatility !== filters.volatility) continue;
    if (filters.confirmation === "PRESENT" && !setup.everConfirmed) continue;
    if (filters.confirmation === "NOT_PRESENT" && setup.everConfirmed) continue;

    const entry = row.journalEntry;
    if (filters.decision && entry?.decision !== filters.decision) continue;

    setups.push(setup);

    if (entry) {
      entries.push({
        setupId: row.id,
        decision: entry.decision,
        statusAtDecision: entry.setupStatusAtDecision,
        skipReason: entry.skipReason,
        decidedAt: entry.decidedAt.getTime(),
        actualEntry: entry.actualEntry === null ? null : Number(entry.actualEntry),
        actualStopLoss: entry.actualStopLoss === null ? null : Number(entry.actualStopLoss),
        actualExit: entry.actualExit === null ? null : Number(entry.actualExit),
        quantity: entry.quantity === null ? null : Number(entry.quantity),
        fees: entry.fees === null ? null : Number(entry.fees),
        slippage: entry.slippage === null ? null : Number(entry.slippage),
        openedAt: entry.openedAt?.getTime() ?? null,
        closedAt: entry.closedAt?.getTime() ?? null,
      });
    }
  }

  return buildResearchReport({ setups, entries, filters });
}
