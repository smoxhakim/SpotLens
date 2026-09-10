import { NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/response";
import { getArticle } from "@/services/learn";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ slug: z.string().min(1).max(120) });

/** GET /api/learn/articles/:slug — public. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = paramsSchema.parse(await params);
    const article = await getArticle(slug);
    if (!article) return apiError("NOT_FOUND", "That article does not exist.", 404);

    return NextResponse.json({ article });
  } catch (err) {
    return handleRouteError(err, "GET /api/learn/articles/:slug");
  }
}
