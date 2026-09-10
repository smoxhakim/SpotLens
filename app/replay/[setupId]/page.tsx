import { History } from "lucide-react";

import { ReplayView } from "@/features/journal/components/ReplayView";

export const metadata = { title: "Replay — SpotLens" };

export default async function ReplayPage({ params }: { params: Promise<{ setupId: string }> }) {
  const { setupId } = await params;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <History className="h-5 w-5" />
          Replay
        </h1>
        <p className="text-sm text-muted-foreground">
          The setup as it looked at a chosen moment — no later candle, no later event, and the
          numbers SpotLens recorded at the time rather than recalculated with today&apos;s data.
        </p>
      </header>

      <ReplayView setupId={setupId} />
    </div>
  );
}
