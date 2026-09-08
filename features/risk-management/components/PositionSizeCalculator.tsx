"use client";

import { useMemo, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { calculatePositionSize } from "@/lib/analysis";
import { RISK_DISCLAIMER } from "@/lib/constants/disclaimers";

interface Props {
  defaultRiskPercent?: number;
  defaultEntry?: number;
  defaultStopLoss?: number;
}

/**
 * Runs the same pure calculation the API exposes. There is no reason to make a
 * round trip for arithmetic, and typing feels instant this way.
 */
export function PositionSizeCalculator({
  defaultRiskPercent = 1,
  defaultEntry,
  defaultStopLoss,
}: Props) {
  const [balance, setBalance] = useState("10000");
  const [riskPercent, setRiskPercent] = useState(String(defaultRiskPercent));
  const [entry, setEntry] = useState(defaultEntry ? String(defaultEntry) : "");
  const [stopLoss, setStopLoss] = useState(defaultStopLoss ? String(defaultStopLoss) : "");

  const result = useMemo(
    () =>
      calculatePositionSize({
        balance: Number(balance),
        riskPercent: Number(riskPercent),
        entry: Number(entry),
        stopLoss: Number(stopLoss),
      }),
    [balance, riskPercent, entry, stopLoss],
  );

  const hasInput = balance && riskPercent && entry && stopLoss;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Position size</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="balance" label="Portfolio balance" value={balance} onChange={setBalance} />
          <Field
            id="risk"
            label="Risk per trade (%)"
            value={riskPercent}
            onChange={setRiskPercent}
            step="0.1"
          />
          <Field id="entry" label="Entry price" value={entry} onChange={setEntry} step="any" />
          <Field
            id="stop"
            label="Stop loss price"
            value={stopLoss}
            onChange={setStopLoss}
            step="any"
          />
        </div>

        {hasInput && !result && (
          <Alert variant="warning">
            <AlertDescription>
              Check the numbers: the stop loss must be below the entry price for a spot long, and
              every field must be a positive number.
            </AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="space-y-3">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Stat
                testId="position-size"
                label="Position size"
                value={trim(result.positionSize)}
                hint="units"
              />
              <Stat
                testId="position-value"
                label="Position value"
                value={trim(result.positionValue)}
                hint="quote"
              />
              <Stat
                testId="risk-amount"
                label="Risk if stopped"
                value={trim(result.riskAmount)}
                hint="quote"
              />
            </dl>
            <p className="text-[11px] leading-relaxed text-muted-foreground">{result.note}</p>
          </div>
        )}

        {!hasInput && (
          <Alert variant="muted">
            <AlertDescription>{RISK_DISCLAIMER}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  step = "any",
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

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  testId: string;
}) {
  return (
    <div className="rounded-md border p-2.5">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular text-sm font-semibold" data-testid={testId}>
        {value} <span className="text-[10px] font-normal text-muted-foreground">{hint}</span>
      </dd>
    </div>
  );
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const decimals = Math.abs(value) >= 100 ? 2 : 6;
  return Number(value.toFixed(decimals)).toLocaleString("en-US");
}
