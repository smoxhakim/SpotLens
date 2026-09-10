import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/response";
import { getAssetDetail } from "@/services/assets";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ symbol: z.string().min(1).max(20) });

/** GET /api/assets/:symbol — asset detail including its ethical checklist. */
export async function GET(_req: Request, { params }: { params: Promise<{ symbol: string }> }) {
  try {
    const { symbol } = paramsSchema.parse(await params);
    const detail = await getAssetDetail(symbol);
    if (!detail) return apiError("NOT_FOUND", "That asset is not on the curated list.", 404);

    return NextResponse.json(detail);
  } catch (err) {
    return handleRouteError(err, "GET /api/assets/:symbol");
  }
}
