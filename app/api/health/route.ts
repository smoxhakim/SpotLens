import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** GET /api/health — uptime probe. */
export function GET() {
  return NextResponse.json({ status: "ok", at: new Date().toISOString() });
}
