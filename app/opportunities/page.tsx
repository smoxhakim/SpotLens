import { Target } from "lucide-react";

import { OpportunitiesView } from "@/features/opportunities/components/OpportunitiesView";

export const metadata = { title: "Top Opportunities — SpotLens" };

export default function OpportunitiesPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Target className="h-5 w-5" />
          Top opportunities to review
        </h1>
        <p className="text-sm text-muted-foreground">
          Deterministically ranked from the latest broad market scan. The scanner covers every
          curated market on both timeframes; this is the short list of what met the review
          threshold, in the order the scanner put them in.
        </p>
      </header>

      <OpportunitiesView />
    </div>
  );
}
