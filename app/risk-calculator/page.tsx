import { Calculator } from "lucide-react";
import Link from "next/link";
import { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { PositionSizeCalculator } from "@/features/risk-management/components/PositionSizeCalculator";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { isDatabaseConfigured } from "@/lib/db/prisma";
import { timeframeSchema } from "@/lib/market-data/schema";

export const metadata = { title: "Risk Calculator — SpotLens" };
export const dynamic = "force-dynamic";

/**
 * Reads one prefill value from the query string.
 *
 * Query strings are user-editable, so a value that is not a positive finite
 * number is dropped rather than passed on — the calculator would reject it
 * anyway, but arriving at a page with a pre-filled error is a worse first
 * impression than arriving at an empty one.
 */
function prefill(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The opportunity this calculator was opened from, when it was opened from one.
 *
 * References only — the market, the timeframe, the pass and optionally the
 * setup. They carry the *identity* of what is being sized so the reader can get
 * back to the analysis and on to the decision without the workflow losing its
 * place; the levels above still arrive as plain numbers, because the calculator
 * is usable on its own with numbers a reader typed.
 *
 * Validated the same way every other surface validates them, and each
 * independently: a mangled setup id should cost the setup link, not the page.
 */
const symbolSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2,20}$/));

function parse<T>(schema: z.ZodType<T>, value: string | string[] | undefined): T | null {
  if (typeof value !== "string") return null;
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export default async function RiskCalculatorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  let defaultRiskPercent = 1;

  if (isDatabaseConfigured) {
    try {
      const session = await auth();
      if (session?.user?.id) {
        const user = await prisma.user.findUnique({
          where: { id: session.user.id },
          select: { defaultRiskPercent: true },
        });
        if (user) defaultRiskPercent = Number(user.defaultRiskPercent);
      }
    } catch {
      // Signed out or no database — the calculator works either way.
    }
  }

  const symbol = parse(symbolSchema, params.symbol);
  const tf = parse(timeframeSchema, params.tf);
  const runId = parse(z.string().uuid(), params.runId);
  const setupId = parse(z.string().uuid(), params.setupId);

  // All three references or none: a link to the Coach without the pass it came
  // from is a link that cannot resolve, and a broken one is worse than absent.
  const context = symbol && tf && runId ? { symbol, tf, runId, setupId } : null;
  const contextParams = new URLSearchParams(
    context
      ? {
          symbol: context.symbol,
          tf: context.tf,
          runId: context.runId,
          ...(context.setupId ? { setupId: context.setupId } : {}),
        }
      : {},
  );

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Calculator className="h-5 w-5" />
          Risk Calculator
        </h1>
        <p className="text-sm text-muted-foreground">
          Size a position from the distance to your stop, so a losing trade costs what you decided
          it would — not whatever the market happens to charge.
        </p>
        {prefill(params.entry) !== undefined && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Levels prefilled from a setup. Choose a balance and a risk percentage to size it —
            SpotLens does not place orders, and nothing here does anything but arithmetic.
          </p>
        )}
      </header>

      {/* Where this came from and where it goes next. Without these the
          calculator is a cul-de-sac: a reader who has just sized a position has
          to find their way back to the analysis by hand, and the setup they
          were looking at is the one thing a back button cannot restore. */}
      {context && (
        <nav aria-label="Back to the setup" className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/market-analysis?pair=${context.symbol}&tf=${context.tf}`}>
              Back to the analysis
            </Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/coach?${contextParams.toString()}`}>Ask Coach</Link>
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/decision?${contextParams.toString()}`}>Your decision</Link>
          </Button>
        </nav>
      )}

      <PositionSizeCalculator
        defaultRiskPercent={defaultRiskPercent}
        defaultEntry={prefill(params.entry)}
        defaultStopLoss={prefill(params.stop)}
        defaultTakeProfit={prefill(params.tp)}
        takeProfitIsSynthetic={params.unmeasured === "1"}
      />

      <Alert variant="muted">
        <AlertDescription>
          A 1% risk per trade means twenty consecutive losses would cost about a fifth of the
          account. Position sizing is what makes a losing streak survivable — it is the difference
          between a bad run and a blown account.
        </AlertDescription>
      </Alert>
    </div>
  );
}
