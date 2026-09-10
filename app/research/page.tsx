import { FlaskConical } from "lucide-react";

import { ResearchView } from "@/features/journal/components/ResearchView";

export const metadata = { title: "Research — SpotLens" };

export default function ResearchPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <FlaskConical className="h-5 w-5" />
          Research
        </h1>
        <p className="text-sm text-muted-foreground">
          Descriptive statistics over your own history. Everything here is an observation about what
          already happened under one set of conditions — none of it predicts anything, and none of
          it recommends a market.
        </p>
      </header>

      <ResearchView />
    </div>
  );
}
