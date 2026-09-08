import { Eye } from "lucide-react";

import { WatchlistView } from "@/features/watchlist/components/WatchlistView";

export const metadata = { title: "Watchlist — SpotLens" };

export default function WatchlistPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Eye className="h-5 w-5" />
          Watchlist
        </h1>
        <p className="text-sm text-muted-foreground">
          The pairs you follow, one click from their charts.
        </p>
      </header>

      <WatchlistView />
    </div>
  );
}
