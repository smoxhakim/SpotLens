"use client";

import { Info, Minus, TrendingDown, TrendingUp } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { explainZone, type MarketRead, type PriceZone } from "@/lib/analysis";
import { classifyRegime } from "@/lib/regime";
import { formatPrice } from "@/lib/format";

import { LearnLink } from "./LearnLink";
import { RegimePanel } from "./RegimePanel";
import { WhyDisclosure } from "./WhyDisclosure";

const TREND_META = {
  BULLISH: { label: "Bullish", variant: "bullish" as const, Icon: TrendingUp },
  BEARISH: { label: "Bearish", variant: "bearish" as const, Icon: TrendingDown },
  SIDEWAYS: { label: "Sideways", variant: "neutral" as const, Icon: Minus },
};

export function MarketReadPanel({
  read,
  isLoading,
}: {
  read: MarketRead | null;
  isLoading: boolean;
}) {
  if (isLoading || !read) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Market Read</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const trend = TREND_META[read.trend.trend];
  const { Icon } = trend;

  // Classified from the read this panel already has — no extra request, and
  // the engine never sees it.
  const regime = classifyRegime(read);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Market Read</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {read.insufficientData && (
          <Alert variant="warning">
            <Info />
            <AlertDescription>
              Only {read.candleCount} candles of history on this timeframe — too few for a reliable
              read. Treat everything below as provisional.
            </AlertDescription>
          </Alert>
        )}

        <section>
          <SectionLabel>Trend</SectionLabel>
          <div className="flex items-center gap-2">
            <Badge variant={trend.variant} className="gap-1">
              <Icon className="h-3 w-3" />
              {trend.label}
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              {read.trend.confidence.toLowerCase()} confidence
            </span>
          </div>
          {read.trend.conflict && (
            <p className="mt-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
              Market structure and the moving averages disagree, so no direction is claimed.
            </p>
          )}
          <WhyDisclosure>{read.trend.reason}</WhyDisclosure>
          <LearnLink concept="trend" label="How trend is decided" />
        </section>

        <Separator />

        <RegimePanel regime={regime} />

        <Separator />

        <section>
          <SectionLabel>Support</SectionLabel>
          <ZoneList
            zones={read.support}
            price={read.price}
            emptyNote="No support zone has formed below price on this timeframe."
          />
          <LearnLink concept="support" label="What is support?" />
        </section>

        <section>
          <SectionLabel>Resistance</SectionLabel>
          <ZoneList
            zones={read.resistance}
            price={read.price}
            emptyNote="No resistance zone has formed above price on this timeframe."
          />
          <WhyDisclosure label="How are these zones built?">{read.zoneWidthNote}</WhyDisclosure>
          <LearnLink concept="resistance" label="What is resistance?" />
        </section>

        <Separator />

        <section>
          <SectionLabel>Volume</SectionLabel>
          <p className="text-xs">
            {read.volume.read
              ? `${read.volume.read.relative.toFixed(1)}× average, ${read.volume.read.trend.toLowerCase()}`
              : "Not enough history"}
          </p>
          <WhyDisclosure>{read.volume.reason}</WhyDisclosure>
          <LearnLink concept="volume" label="What volume confirms" />
        </section>

        <section>
          <SectionLabel>RSI (14)</SectionLabel>
          <p className="text-xs">
            {read.rsi.value === null ? "Not enough history" : read.rsi.value.toFixed(1)}
          </p>
          <WhyDisclosure>{read.rsi.reason}</WhyDisclosure>
          <LearnLink concept="rsi" label="Why RSI is never a signal alone" />
        </section>

        <Separator />

        <section>
          <SectionLabel>Moving averages</SectionLabel>
          <dl className="grid grid-cols-3 gap-2 text-[11px]">
            <Stat label="EMA 20" value={read.indicators.ema20} />
            <Stat label="EMA 50" value={read.indicators.ema50} />
            <Stat label="EMA 200" value={read.indicators.ema200} />
          </dl>
          <LearnLink concept="ema" label="How moving averages are used" />
        </section>

        <Alert variant="muted">
          <AlertDescription>{read.disclaimer}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">{value === null ? "—" : formatPrice(value)}</dd>
    </div>
  );
}

function ZoneList({
  zones,
  price,
  emptyNote,
}: {
  zones: PriceZone[];
  price: number;
  emptyNote: string;
}) {
  if (zones.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{emptyNote}</p>;
  }

  return (
    <ul className="space-y-1.5">
      {zones.map((zone) => (
        <li key={`${zone.kind}-${zone.low}`}>
          <div className="flex items-center gap-2">
            <span className="tabular text-xs font-medium">
              {formatPrice(zone.low)} – {formatPrice(zone.high)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {zone.touches} {zone.touches === 1 ? "touch" : "touches"}
            </span>
            {zone.flipped && (
              <Badge variant="outline" className="text-[9px]">
                flipped
              </Badge>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground">{zone.strength}/100</span>
          </div>
          <WhyDisclosure>{explainZone(zone, price)}</WhyDisclosure>
        </li>
      ))}
    </ul>
  );
}
