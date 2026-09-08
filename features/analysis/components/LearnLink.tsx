import { BookOpen } from "lucide-react";
import Link from "next/link";

import { articleForConcept } from "@/lib/learn/articles";

/**
 * Contextual link from a field in an analysis result to the article explaining
 * it. Renders nothing when no article covers the concept, so adding a field
 * never leaves a dead link behind.
 */
export function LearnLink({ concept, label }: { concept: string; label?: string }) {
  const article = articleForConcept(concept);
  if (!article) return null;

  return (
    <Link
      href={`/learn/${article.slug}`}
      className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
    >
      <BookOpen className="h-3 w-3" />
      {label ?? article.title}
    </Link>
  );
}
