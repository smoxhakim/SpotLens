import { NextResponse } from "next/server";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";
import { listMarkets } from "@/services/markets";

export const dynamic = "force-dynamic";

/** GET /api/backtest — the caller's runs, newest first. */
export async function GET() {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const runs = await prisma.backtestRun.findMany({
      where: { userId: guard.userId },
      orderBy: { createdAt: "desc" },
      take: 25,
    });

    const markets = await listMarkets();
    const byId = new Map(markets.map((m) => [m.pairId, m]));

    return NextResponse.json({
      runs: runs.map((run) => ({
        id: run.id,
        label: byId.get(run.tradingPairId)?.label ?? "Unknown pair",
        timeframe: run.timeframe,
        status: run.status,
        startDate: run.startDate.toISOString(),
        endDate: run.endDate.toISOString(),
        numSetups: run.numSetups,
        winRate: run.winRate === null ? null : Number(run.winRate),
        avgRealizedRR: run.avgRealizedRR === null ? null : Number(run.avgRealizedRR),
        maxDrawdownPct: run.maxDrawdownPct === null ? null : Number(run.maxDrawdownPct),
        errorMessage: run.errorMessage,
        createdAt: run.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/backtest");
  }
}
