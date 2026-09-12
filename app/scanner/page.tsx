import { ArrowRight, Radar } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Top opportunities from the latest scan</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The same passes, filtered and ranked down to the few that met the review threshold.
            </p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link href="/opportunities">
              Review them <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </CardContent>
      </Card>

      <ScannerStatusView />
    </div>
  );
}
