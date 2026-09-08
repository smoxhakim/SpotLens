import { BookOpen } from "lucide-react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listArticles } from "@/services/learn";

export const metadata = { title: "Learn — SpotLens" };
export const dynamic = "force-dynamic";

const CATEGORY_ORDER = ["Market structure", "Indicators", "Risk", "Using SpotLens"];

export default async function LearnPage() {
  const articles = await listArticles();

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: articles.filter((a) => a.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BookOpen className="h-5 w-5" />
          Learn
        </h1>
        <p className="text-sm text-muted-foreground">
          Every concept the analysis uses, in plain language. The goal is that you stop needing the
          tool to tell you what a chart says.
        </p>
      </header>

      {grouped.map(({ category, items }) => (
        <Card key={category}>
          <CardHeader className="pb-2">
            <CardTitle>{category}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {items.map((article) => (
                <li key={article.slug} className="py-2">
                  <Link href={`/learn/${article.slug}`} className="group block">
                    <div className="text-sm font-medium group-hover:underline">{article.title}</div>
                    <div className="text-xs text-muted-foreground">{article.summary}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
