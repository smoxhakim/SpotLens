import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";
import { listMarkets } from "@/services/markets";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().uuid().optional(),
});

/** GET /api/analysis/history — the caller's saved analyses, newest first. */
export async function GET(req: NextRequest) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const query = querySchema.parse(Object.fromEntries(req.nextUrl.searchParams));

    const rows = await prisma.analysisSnapshot.findMany({
      where: { userId: guard.userId },
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        tradingPairId: true,
        timeframe: true,
        trend: true,
        status: true,
        statusReason: true,
        setupScore: true,
        riskRewardRatio: true,
        entryLow: true,
        entryHigh: true,
        stopLoss: true,
        createdAt: true,
      },
    });

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;

    const markets = await listMarkets();
    const byId = new Map(markets.map((m) => [m.pairId, m]));

    return NextResponse.json({
      items: page.map((row) => ({
        id: row.id,
        label: byId.get(row.tradingPairId)?.label ?? "Unknown pair",
        timeframe: row.timeframe,
        trend: row.trend,
        status: row.status,
        statusReason: row.statusReason,
        setupScore: row.setupScore,
        riskRewardRatio: Number(row.riskRewardRatio),
        entryLow: Number(row.entryLow),
        entryHigh: Number(row.entryHigh),
        stopLoss: Number(row.stopLoss),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/analysis/history");
  }
}
