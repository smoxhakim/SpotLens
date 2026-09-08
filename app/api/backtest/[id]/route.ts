import { NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { BACKTEST_DISCLAIMER } from "@/lib/constants/disclaimers";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });

/** GET /api/backtest/:id — run summary and its setups. Owner only. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const { id } = paramsSchema.parse(params);

    const run = await prisma.backtestRun.findUnique({
      where: { id },
      include: { setups: { orderBy: { triggeredAt: "asc" } } },
    });

    if (!run || run.userId !== guard.userId) {
      return apiError("NOT_FOUND", "That backtest does not exist.", 404);
    }

    return NextResponse.json({
      run: {
        id: run.id,
        timeframe: run.timeframe,
        status: run.status,
        startDate: run.startDate.toISOString(),
        endDate: run.endDate.toISOString(),
        numSetups: run.numSetups,
        winRate: run.winRate === null ? null : Number(run.winRate),
        avgRealizedRR: run.avgRealizedRR === null ? null : Number(run.avgRealizedRR),
        maxDrawdownPct: run.maxDrawdownPct === null ? null : Number(run.maxDrawdownPct),
        createdAt: run.createdAt.toISOString(),
      },
      setups: run.setups.map((setup) => ({
        id: setup.id,
        triggeredAt: setup.triggeredAt.toISOString(),
        entry: Number(setup.entry),
        stopLoss: Number(setup.stopLoss),
        takeProfits: setup.takeProfits,
        outcome: setup.outcome,
        realizedRR: setup.realizedRR === null ? null : Number(setup.realizedRR),
        exitTime: setup.exitTime?.toISOString() ?? null,
        exitPrice: setup.exitPrice === null ? null : Number(setup.exitPrice),
      })),
      disclaimer: BACKTEST_DISCLAIMER,
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/backtest/:id");
  }
}
