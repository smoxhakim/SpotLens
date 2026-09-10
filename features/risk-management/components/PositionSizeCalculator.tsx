"use client";

import { Info } from "lucide-react";
import { useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { RISK_DISCLAIMER } from "@/lib/constants/disclaimers";
import { calculateRisk, type RiskCalculation } from "@/lib/risk";
import { cn } from "@/lib/utils";

interface Props {
  defaultRiskPercent?: number;
  defaultEntry?: number;
  defaultStopLoss?: number;
  defaultTakeProfit?: number;
  /** Set when the values came from a setup whose reward was never measured. */
  takeProfitIsSynthetic?: boolean;
}

/**
 * Runs the same pure calculation the API exposes. There is no reason to make a
 * round trip for arithmetic, and typing feels instant this way.
 *
 * The layout follows the chain the numbers actually form — balance, then risk,
 * then the stop, then the position — because the single most common mistake
 * this tool exists to prevent is reading the position size as the amount being
 * risked.
 */
export function PositionSizeCalculator({
  defaultRiskPercent = 1,
  defaultEntry,
  defaultStopLoss,
  defaultTakeProfit,
  takeProfitIsSynthetic,
}: Props) {
  const [balance, setBalance] = useState("10000");
  const [riskPercent, setRiskPercent] = useState(String(defaultRiskPercent));
  const [entry, setEntry] = useState(defaultEntry ? String(defaultEntry) : "");
  const [stopLoss, setStopLoss] = useState(defaultStopLoss ? String(defaultStopLoss) : "");
  const [takeProfit, setTakeProfit] = useState(defaultTakeProfit ? String(defaultTakeProfit) : "");
  const [maxExposure, setMaxExposure] = useState("");
  const [feePercent, setFeePercent] = useState("0.1");

  const hasInput = Boolean(balance && riskPercent && entry && stopLoss);

  const result = useMemo(() => {
    if (!hasInput) return null;

    return calculateRisk({
      balance: Number(balance),
      riskPercent: Number(riskPercent),
      entry: Number(entry),
      stopLoss: Number(stopLoss),
      ...(takeProfit ? { takeProfit: Number(takeProfit) } : {}),
      ...(maxExposure ? { maxExposurePercent: Number(maxExposure) } : {}),
      feeRate: Number(feePercent) / 100,
      takeProfitIsSynthetic,
    });
  }, [
    balance,
    riskPercent,
    entry,
    stopLoss,
    takeProfit,
    maxExposure,
    feePercent,
    hasInput,
    takeProfitIsSynthetic,
  ]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Position size</CardTitle>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Size comes from the distance to your stop, not from a share of the balance. The position
          is usually far larger than the amount at risk — and far smaller than the account.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="balance" label="Account balance" value={balance} onChange={setBalance} />
          <Field
            id="risk"
            label="Risk per trade (%)"
            value={riskPercent}
            onChange={setRiskPercent}
            step="0.1"
          />
          <Field id="entry" label="Entry price" value={entry} onChange={setEntry} step="any" />
          <Field id="stop" label="Stop loss" value={stopLoss} onChange={setStopLoss} step="any" />
          <Field
            id="tp"
            label="Take profit (optional)"
            value={takeProfit}
            onChange={setTakeProfit}
            step="any"
          />
          <Field
            id="exposure"
            label="Max exposure (%, optional)"
            value={maxExposure}
            onChange={setMaxExposure}
            step="1"
          />
          <Field
            id="fee"
            label="Fee per side (%)"
            value={feePercent}
            onChange={setFeePercent}
            step="0.01"
          />
        </div>

        {!hasInput && (
          <p className="text-xs text-muted-foreground">
            Enter a balance, a risk percentage, an entry and a stop to size a position.
          </p>
        )}

        {result && !result.ok && (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="space-y-0.5 text-[11px]">
                {result.errors.map((error) => (
                  <li key={error.code + error.field}>{error.message}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {result?.ok && <Result calculation={result.calculation} />}

        <Alert variant="muted">
          <AlertDescription>{RISK_DISCLAIMER}</AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function Result({ calculation: c }: { calculation: RiskCalculation }) {
  return (
    <div className="space-y-4">
      <section>
        <SectionLabel>Risk</SectionLabel>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Account balance" value={money(c.balance)} />
          <Stat label="Maximum risk" value={money(c.intendedRiskAmount)} testId="risk-amount" />
          <Stat
            label="Stop distance"
            value={`${money(c.stopDistance)} · ${c.stopDistancePercent.toFixed(2)}%`}
          />
        </dl>
        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          {c.riskPercent}% of {money(c.balance)} is {money(c.intendedRiskAmount)}. That is what a
          stop-out costs — not the position, and not the account.
        </p>
      </section>

      <Separator />

      <section>
        <SectionLabel>Position</SectionLabel>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Position size" value={money(c.positionQuote)} testId="position-size" />
          <Stat
            label="Quantity"
            value={c.quantity.toPrecision(8).replace(/\.?0+$/, "")}
            testId="position-quantity"
          />
          <Stat label="Of balance" value={`${c.positionPercentOfBalance.toFixed(1)}%`} />
        </dl>

        {c.wasCapped && (
          <div className="mt-2 rounded-md border border-dashed p-2">
            <dl className="grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
              <Field2 label="Risk-based size">{money(c.uncappedPositionQuote)}</Field2>
              <Field2 label="Cap">{money(c.exposureCap)}</Field2>
              <Field2 label="Capped size">{money(c.positionQuote)}</Field2>
              <Field2 label="Intended risk">{money(c.intendedRiskAmount)}</Field2>
              <Field2 label="Actual risk">
                <span className="text-bullish">{money(c.actualRiskAmount)}</span>
              </Field2>
            </dl>
            <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
              The capped position risks less than intended, not more. Spot has no borrowing, so a
              tighter stop cannot buy more than the account holds.
            </p>
          </div>
        )}

        <p className="mt-1 text-[10px] text-muted-foreground">
          Quantity is shown at full precision. Round it to whatever step size the exchange requires
          before placing anything yourself.
        </p>
      </section>

      <Separator />

      <section>
        <SectionLabel>If it goes wrong</SectionLabel>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Intended loss" value={money(c.actualRiskAmount)} />
          <Stat label="Estimated costs" value={money(c.estimatedCosts)} />
          <Stat label="Estimated total" value={money(c.estimatedNetLoss)} />
        </dl>
      </section>

      {c.takeProfit !== null && (
        <section>
          <SectionLabel>If it goes right</SectionLabel>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Gross profit" value={money(c.potentialGrossProfit ?? 0)} />
            <Stat label="After costs" value={money(c.potentialNetProfit ?? 0)} />
            <Stat
              label="Risk / reward"
              value={
                c.riskReward === null
                  ? "—"
                  : `1:${c.riskReward.toFixed(2)}${c.riskRewardIsSynthetic ? " *" : ""}`
              }
            />
          </dl>
          <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
            Hypothetical, and only if the target is reached. Nothing here is a forecast.
            {c.riskRewardIsSynthetic && " * measured to a target the engine never verified."}
          </p>
        </section>
      )}

      {c.warnings.length > 0 && (
        <Alert variant="warning">
          <Info />
          <AlertDescription>
            <ul className="space-y-1 text-[11px] leading-relaxed">
              {c.warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function money(value: number): string {
  const abs = Math.abs(value);
  return value
    .toFixed(abs >= 1000 ? 2 : abs >= 1 ? 2 : 6)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("tabular text-sm font-semibold")}>{value}</dd>
    </div>
  );
}

function Field2({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium text-foreground">{children}</dd>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  step = "1",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  step?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
