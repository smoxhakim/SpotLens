"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { formatPrice } from "@/lib/format";
import { ALLOWED_TRANSITIONS, type JournalDecision } from "@/lib/journal";
import { TIMEFRAME_LABELS } from "@/lib/market-data/provider";
import { cn } from "@/lib/utils";

import { DECISION_META, type JournalEntrySummary } from "./JournalList";

interface JournalEntryDetail extends JournalEntrySummary {
  setupEvents: {
    id: string;
    type: string;
    fromStatus: string | null;
    toStatus: string;
    detail: string;
    createdAt: string;
  }[];
  journalEvents: {
    id: string;
    type: string;
    fromDecision: string | null;
    toDecision: string;
    detail: string;
    createdAt: string;
  }[];
  trade: {
    actualEntry: number;
    actualStopLoss: number | null;
    actualExit: number | null;
    quantity: number;
    fees: number | null;
    realizedR: number | null;
    netPnl: number | null;
    riskAmount: number | null;
    holdingMs: number | null;
    exitReason: string | null;
  } | null;
}

const SKIP_REASONS = [
  "LOW_CONFIDENCE",
  "POOR_RR",
  "BAD_REGIME",
  "NO_CONFIRMATION",
  "PERSONAL_RULE",
  "MARKET_CONDITION",
  "MISSED_ENTRY",
  "OTHER",
] as const;

export function JournalDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();

  const query = useQuery<{ entry: JournalEntryDetail }>({
    queryKey: ["journal", id],
    queryFn: () => fetchApi(`/api/journal/${id}`),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["journal"] });
  };

  if (query.isPending) return <Skeleton className="h-64 w-full" />;

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{(query.error as Error).message}</AlertDescription>
      </Alert>
    );
  }

  const entry = query.data!.entry;

  return (
    <div className="space-y-4">
      <Plan entry={entry} />
      <Decision entry={entry} onChanged={invalidate} />
      <Outcome entry={entry} onChanged={invalidate} />
      <Timeline entry={entry} />
    </div>
  );
}

/** What SpotLens said, read from the immutable setup snapshot. */
function Plan({ entry }: { entry: JournalEntryDetail }) {
  const { setup } = entry;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-2 text-sm">
          <span>{setup.symbol}</span>
          <span className="text-muted-foreground">{TIMEFRAME_LABELS[setup.timeframe]}</span>
          <Badge variant="outline" className="text-[9px]">
            SpotLens plan
          </Badge>
          <Button asChild size="sm" variant="ghost" className="ml-auto h-6 px-2 text-[10px]">
            <Link href={`/replay/${setup.id}`}>
              <History className="h-3 w-3" />
              Replay
            </Link>
          </Button>
        </CardTitle>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Recorded when the setup was first seen and never rewritten since — the setup has moved on
          (it is now {setup.currentStatus.toLowerCase().replace(/_/g, " ")}), but this is what you
          were looking at.
        </p>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
          <Field label="Entry zone">
            {formatPrice(setup.entryLow)} – {formatPrice(setup.entryHigh)}
          </Field>
          <Field label="Stop">{formatPrice(setup.stopLoss)}</Field>
          <Field label="Quality">
            {setup.score}/100 · {setup.scoreGrade.toLowerCase()}
          </Field>
          <Field label="R:R">
            1:{setup.riskReward.toFixed(2)}
            {setup.riskRewardIsSynthetic && (
              <span className="ml-1 text-[9px] text-muted-foreground">unmeasured</span>
            )}
          </Field>
          <Field label="At decision">
            {entry.setupStatusAtDecision.toLowerCase().replace(/_/g, " ")}
          </Field>
          <Field label="Verdict then">
            {setup.analysisStatus.toLowerCase().replace(/_/g, " ")}
          </Field>
        </dl>
      </CardContent>
    </Card>
  );
}

function Decision({ entry, onChanged }: { entry: JournalEntryDetail; onChanged: () => void }) {
  const [notes, setNotes] = useState(entry.notes ?? "");
  const [skipReason, setSkipReason] = useState<string>(entry.skipReason ?? "");

  const update = useMutation({
    mutationFn: (decision: JournalDecision) =>
      fetchApi(`/api/journal/${entry.id}/decision`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          ...(decision === "SKIPPED" && skipReason ? { skipReason } : {}),
          notes,
        }),
      }),
    onSuccess: onChanged,
  });

  const current = entry.decision;
  const options = ALLOWED_TRANSITIONS[current];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-baseline gap-2 text-sm">
          Your decision
          <span className={cn("text-xs font-semibold", DECISION_META[current].className)}>
            {DECISION_META[current].label}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {options.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            This entry is closed. Its recorded outcome describes the position as it was entered, so
            the decision no longer changes.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {options.map((option) => (
              <Button
                key={option}
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => update.mutate(option)}
                disabled={update.isPending}
              >
                {DECISION_META[option].label}
              </Button>
            ))}
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="skip">Skip reason (optional)</Label>
          <select
            id="skip"
            value={skipReason}
            onChange={(e) => setSkipReason(e.target.value)}
            className="flex h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Not specified</option>
            {SKIP_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason.toLowerCase().replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-muted-foreground">
            Never assumed. Left blank, research counts it as unspecified rather than guessing.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="notes">Notes</Label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={2000}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="What were you thinking?"
          />
        </div>

        {update.isError && (
          <Alert variant="destructive">
            <AlertDescription className="text-[11px]">
              {(update.error as Error).message}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function Outcome({ entry, onChanged }: { entry: JournalEntryDetail; onChanged: () => void }) {
  const [form, setForm] = useState({
    actualEntry: String(entry.trade?.actualEntry ?? ""),
    actualStopLoss: String(entry.trade?.actualStopLoss ?? ""),
    actualExit: String(entry.trade?.actualExit ?? ""),
    quantity: String(entry.trade?.quantity ?? ""),
    fees: String(entry.trade?.fees ?? ""),
  });

  const record = useMutation({
    mutationFn: (close: boolean) =>
      fetchApi(`/api/journal/${entry.id}/outcome`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actualEntry: Number(form.actualEntry),
          ...(form.actualStopLoss ? { actualStopLoss: Number(form.actualStopLoss) } : {}),
          ...(form.actualExit ? { actualExit: Number(form.actualExit) } : {}),
          quantity: Number(form.quantity),
          ...(form.fees ? { fees: Number(form.fees) } : {}),
          close,
        }),
      }),
    onSuccess: onChanged,
  });

  if (entry.decision !== "TAKEN" && entry.decision !== "CLOSED") return null;

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Your trade</CardTitle>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Your own fill, stop and costs — not the plan above. The difference between the two is one
          of the things worth keeping.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <NumberField
            id="ae"
            label="Actual entry"
            value={form.actualEntry}
            onChange={set("actualEntry")}
          />
          <NumberField
            id="as"
            label="Actual stop"
            value={form.actualStopLoss}
            onChange={set("actualStopLoss")}
          />
          <NumberField id="qt" label="Quantity" value={form.quantity} onChange={set("quantity")} />
          <NumberField
            id="ax"
            label="Exit price"
            value={form.actualExit}
            onChange={set("actualExit")}
          />
          <NumberField id="fe" label="Fees" value={form.fees} onChange={set("fees")} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => record.mutate(false)}
            disabled={record.isPending}
          >
            Save details
          </Button>
          {entry.decision === "TAKEN" && (
            <Button size="sm" onClick={() => record.mutate(true)} disabled={record.isPending}>
              Record result and close
            </Button>
          )}
        </div>

        {record.isError && (
          <Alert variant="destructive">
            <AlertDescription className="text-[11px]">
              {(record.error as Error).message}
            </AlertDescription>
          </Alert>
        )}

        {entry.trade && (
          <>
            <Separator />
            <dl className="grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
              <Field label="Risk taken">
                {entry.trade.riskAmount === null ? "—" : entry.trade.riskAmount.toFixed(2)}
              </Field>
              <Field label="Net P&L">
                {entry.trade.netPnl === null ? "—" : entry.trade.netPnl.toFixed(2)}
              </Field>
              <Field label="Realised R">
                {entry.trade.realizedR === null ? "—" : `${entry.trade.realizedR.toFixed(2)}R`}
              </Field>
              <Field label="Held">
                {entry.trade.holdingMs === null
                  ? "—"
                  : `${(entry.trade.holdingMs / 3_600_000).toFixed(1)}h`}
              </Field>
            </dl>
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              R is measured against the risk you actually took — your fill to your stop — not
              against the plan.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Both histories, side by side and never merged. */
function Timeline({ entry }: { entry: JournalEntryDetail }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">History</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            What the setup did
          </h4>
          <ul className="space-y-1.5">
            {entry.setupEvents.map((event) => (
              <li key={event.id} className="text-[11px] leading-relaxed">
                <span className="tabular text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
                <br />
                {event.toStatus.toLowerCase().replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            What you decided
          </h4>
          <ul className="space-y-1.5">
            {entry.journalEvents.map((event) => (
              <li key={event.id} className="text-[11px] leading-relaxed">
                <span className="tabular text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()}
                </span>
                <br />
                {event.detail}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular font-medium">{children}</dd>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
