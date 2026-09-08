import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api/response";
import { listAssets } from "@/services/assets";

export const dynamic = "force-dynamic";

/** GET /api/assets — curated assets with metadata. */
export async function GET() {
  try {
    return NextResponse.json({ assets: await listAssets() });
  } catch (err) {
    return handleRouteError(err, "GET /api/assets");
  }
}
