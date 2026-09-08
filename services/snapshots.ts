import type { Prisma } from "@prisma/client";

import type { AnalysisResult } from "@/lib/analysis";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";
import type { Timeframe } from "@/lib/market-data/provider";

interface SaveSnapshotInput {
  userId: string;
  tradingPairId: string;
  timeframe: Timeframe;
  result: AnalysisResult;
}

/**
 * Persists one "Analyze Market" run for a signed-in user.
 *
 * Only runs that produced an actual setup are stored — a snapshot with no
 * entry, stop or targets has nothing to record, and the schema requires them.
 * Returns null when nothing was saved.
 *
 * Never throws: failing to record history must not fail the analysis the user
 * asked for.
 */
export async function saveAnalysisSnapshot(input: SaveSnapshotInput): Promise<string | null> {
  if (!isDatabaseConfigured) return null;

  const { result } = input;
  const setup = result.setup;
  if (!setup || !result.score) return null;

  try {
    const snapshot = await prisma.analysisSnapshot.create({
      data: {
        userId: input.userId,
        tradingPairId: input.tradingPairId,
        timeframe: input.timeframe,
        trend: result.read.trend.trend,
        trendReason: result.read.trend.reason,
        supportZones: result.read.support.map(toZoneJson),
        resistanceZones: result.read.resistance.map(toZoneJson),
        entryLow: setup.entry.low,
        entryHigh: setup.entry.high,
        entryReason: setup.entry.reason,
        confirmationChecklist: setup.entry.confirmations,
        stopLoss: setup.stopLoss.price,
        stopLossReason: setup.stopLoss.reason,
        takeProfits: setup.takeProfits.map((t) => ({
          label: t.label,
          level: t.level,
          reason: t.reason,
          rr: t.rr,
        })),
        riskRewardRatio: setup.riskReward.ratio,
        setupScore: result.score.total,
        setupScoreBreakdown: toJson(result.score.breakdown),
        status: result.status,
        statusReason: result.statusReason,
        indicatorsSnapshot: toJson(result.read.indicators),
        disclaimerVersion: result.disclaimerVersion,
      },
      select: { id: true },
    });

    return snapshot.id;
  } catch (err) {
    warnOnce("snapshots:write", "[snapshots] could not persist analysis history.", err);
    return null;
  }
}

function toZoneJson(zone: { low: number; high: number }) {
  return { low: zone.low, high: zone.high };
}

/**
 * Prisma's Json input type rejects declared interfaces, which have no index
 * signature. Round-tripping guarantees the stored shape is exactly what the
 * API serialises, rather than casting and hoping.
 */
function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
