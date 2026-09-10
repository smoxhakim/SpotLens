import { Radar } from "lucide-react";

import { ScannerStatusView } from "@/features/scanner/components/ScannerStatusView";

export const metadata = { title: "Scanner — SpotLens" };

export default function ScannerPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Radar className="h-5 w-5" />
          Scanner
        </h1>
        <p className="text-sm text-muted-foreground">
          Recent passes over the curated markets. The scanner runs the same analysis the Market
          Analysis page does, on closed candles only, and updates the setups it is already tracking
          rather than creating new ones.
        </p>
      </header>

      <ScannerStatusView />
    </div>
  );
}
