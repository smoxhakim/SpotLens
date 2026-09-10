import { Calculator } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { PositionSizeCalculator } from "@/features/risk-management/components/PositionSizeCalculator";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/prisma";
import { isDatabaseConfigured } from "@/lib/db/prisma";

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
