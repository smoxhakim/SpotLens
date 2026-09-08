import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Markdown } from "@/components/content/Markdown";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";
import { getArticle } from "@/services/learn";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  const article = await getArticle(params.slug);
  return { title: article ? `${article.title} — SpotLens` : "Not found — SpotLens" };
}

export default async function ArticlePage({ params }: { params: { slug: string } }) {
  const article = await getArticle(params.slug);
  if (!article) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        href="/learn"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        All articles
      </Link>

      <Card>
        <CardHeader>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {article.category}
          </div>
          <CardTitle as="h1" className="text-base">
            {article.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Markdown source={article.bodyMarkdown} />
        </CardContent>
      </Card>

      <Alert variant="muted">
        <AlertDescription>{ANALYSIS_DISCLAIMER}</AlertDescription>
      </Alert>
    </div>
  );
}
