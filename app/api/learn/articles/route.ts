import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api/response";
import { listArticles } from "@/services/learn";

export const dynamic = "force-dynamic";

/** GET /api/learn/articles — public. */
export async function GET() {
  try {
    const articles = await listArticles();
    return NextResponse.json({
      articles: articles.map(({ bodyMarkdown: _body, ...rest }) => rest),
    });
  } catch (err) {
    return handleRouteError(err, "GET /api/learn/articles");
  }
}
