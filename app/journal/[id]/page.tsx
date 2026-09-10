import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { JournalDetail } from "@/features/journal/components/JournalDetail";

export const metadata = { title: "Journal entry — SpotLens" };

export default async function JournalEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link
        href="/journal"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        All entries
      </Link>

      <JournalDetail id={id} />
    </div>
  );
}
