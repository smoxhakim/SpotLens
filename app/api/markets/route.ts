import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api/response";
import { listMarkets } from "@/services/markets";
import type { MarketsResponse } from "@/types/market";

export const dynamic = "force-dynamic";

/** GET /api/markets — curated, active spot pairs for the selector. */
export async function GET() {
  try {
    const markets = await listMarkets();
    return NextResponse.json<MarketsResponse>(
      { markets },
      { headers: { "cache-control": "public, max-age=60, stale-while-revalidate=600" } },
    );
  } catch (err) {
    return handleRouteError(err, "GET /api/markets");
  }
}
