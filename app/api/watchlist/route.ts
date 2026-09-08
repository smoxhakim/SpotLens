import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { isDenied, requireUser } from "@/lib/api/auth-guard";
import { apiError, handleRouteError } from "@/lib/api/response";
import { prisma } from "@/lib/db/prisma";
import { findMarketByPairId, listMarkets } from "@/services/markets";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ tradingPairId: z.string().uuid() });

/** GET /api/watchlist — the caller's saved pairs. */
export async function GET() {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const rows = await prisma.watchlist.findMany({
      where: { userId: guard.userId },
      orderBy: { createdAt: "desc" },
    });

    // Join against the market list rather than the DB, so this works whether
    // pairs come from Postgres or the curated file.
    const markets = await listMarkets();
    const byId = new Map(markets.map((m) => [m.pairId, m]));

    const items = rows
      .map((row) => {
        const market = byId.get(row.tradingPairId);
        return market ? { id: row.id, createdAt: row.createdAt.toISOString(), market } : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    return NextResponse.json({ items });
  } catch (err) {
    return handleRouteError(err, "GET /api/watchlist");
  }
}

/** POST /api/watchlist — save a pair. */
export async function POST(req: NextRequest) {
  try {
    const guard = await requireUser();
    if (isDenied(guard)) return guard.response;

    const json = await req.json().catch(() => null);
    if (json === null) return apiError("INVALID_REQUEST", "A JSON body is required.", 400);

    const { tradingPairId } = bodySchema.parse(json);

    const market = await findMarketByPairId(tradingPairId);
    if (!market) return apiError("PAIR_NOT_FOUND", "Unknown trading pair.", 404);

    const item = await prisma.watchlist.upsert({
      where: { userId_tradingPairId: { userId: guard.userId, tradingPairId } },
      create: { userId: guard.userId, tradingPairId },
      update: {},
    });

    return NextResponse.json(
      { item: { id: item.id, createdAt: item.createdAt.toISOString(), market } },
      { status: 201 },
    );
  } catch (err) {
    return handleRouteError(err, "POST /api/watchlist");
  }
}
