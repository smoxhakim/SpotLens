import { NotebookPen } from "lucide-react";

import { JournalList } from "@/features/journal/components/JournalList";

export const metadata = { title: "Journal — SpotLens" };

export default function JournalPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <NotebookPen className="h-5 w-5" />
          Journal
        </h1>
        <p className="text-sm text-muted-foreground">
          What you decided, kept beside what SpotLens said. The two are recorded separately on
          purpose — the engine finding a good setup and you trading it well are different results,
          and one number across both would describe neither.
        </p>
      </header>

      <JournalList />
    </div>
  );
}
