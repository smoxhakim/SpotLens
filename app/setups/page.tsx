import { History } from "lucide-react";

import { SetupHistoryView } from "@/features/setups/components/SetupHistoryView";

export const metadata = { title: "Setups — SpotLens" };

export default function SetupsPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <History className="h-5 w-5" />
          Setups
        </h1>
        <p className="text-sm text-muted-foreground">
          Levels the engine has been following, and what became of each one. A setup keeps its
          identity while it rests on the same support zone, so re-running an analysis updates it
          rather than creating another.
        </p>
      </header>

      <SetupHistoryView />
    </div>
  );
}
