import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { LEARN_ARTICLES, type LearnArticleSeed } from "@/lib/learn/articles";
import { warnOnce } from "@/lib/log";

export interface LearnArticle extends LearnArticleSeed {}

/**
 * Learn content. Reads from Postgres when configured so it stays editable, and
 * falls back to the file the seed script uses — the same pattern as markets.
 */
export async function listArticles(): Promise<LearnArticle[]> {
  if (isDatabaseConfigured) {
    try {
      const rows = await prisma.learnArticle.findMany({ orderBy: { title: "asc" } });
      if (rows.length > 0) {
        return rows.map((row) => ({
          slug: row.slug,
          title: row.title,
          category: row.category as LearnArticleSeed["category"],
          summary: LEARN_ARTICLES.find((a) => a.slug === row.slug)?.summary ?? "",
          conceptTags: row.relatedConceptTags,
          bodyMarkdown: row.bodyMarkdown,
        }));
      }
    } catch (err) {
      warnOnce("learn:db", "[learn] database unreachable — serving articles from file.", err);
    }
  }
  return LEARN_ARTICLES;
}

export async function getArticle(slug: string): Promise<LearnArticle | undefined> {
  const articles = await listArticles();
  return articles.find((a) => a.slug === slug);
}
