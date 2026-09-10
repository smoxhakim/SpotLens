import { ArrowLeft, ExternalLink, LineChart } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EthicalChecklist } from "@/features/learning/components/EthicalChecklist";
import { getAssetDetail } from "@/services/assets";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }) {
  const detail = await getAssetDetail((await params).symbol);
  return { title: detail ? `${detail.asset.name} — SpotLens` : "Not found — SpotLens" };
}

export default async function AssetPage({ params }: { params: Promise<{ symbol: string }> }) {
  const detail = await getAssetDetail((await params).symbol);
  if (!detail) notFound();

  const { asset, checklist, exchangeSymbol } = detail;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        All markets
      </Link>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle as="h1" className="text-base">
              {asset.name} <span className="text-muted-foreground">({asset.symbol})</span>
            </CardTitle>
            <Badge variant="outline" className="text-[10px]">
              {asset.category.replace(/_/g, " ").toLowerCase()}
            </Badge>
            <Badge
              variant={
                asset.riskLevel === "LOW"
                  ? "bullish"
                  : asset.riskLevel === "HIGH"
                    ? "bearish"
                    : "neutral"
              }
              className="text-[10px]"
            >
              {asset.riskLevel.toLowerCase()} risk
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm leading-relaxed text-muted-foreground">{asset.description}</p>

          <div>
            <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              What the token is used for
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {asset.utilityExplanation}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {exchangeSymbol && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/market-analysis?pair=${exchangeSymbol}&tf=H4`}>
                  <LineChart className="h-3.5 w-3.5" />
                  Open chart
                </Link>
              </Button>
            )}
            <Button asChild size="sm" variant="ghost">
              <a href={asset.officialWebsite} target="_blank" rel="noreferrer noopener">
                <ExternalLink className="h-3.5 w-3.5" />
                Official website
              </a>
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Risk level reflects how established the project is and how volatile the asset has been —
            it is a rough guide for position sizing, not a prediction.
          </p>
        </CardContent>
      </Card>

      {checklist && <EthicalChecklist checklist={checklist} />}
    </div>
  );
}
