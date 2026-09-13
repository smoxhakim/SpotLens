"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { NotebookPen } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fetchApi } from "@/features/market/hooks/fetch-api";
import { canTransition, type JournalDecision, type JournalSkipReason } from "@/lib/journal";
import { cn } from "@/lib/utils";

import {
  DECISION_COPY,
  OFFERED_DECISIONS,
  SKIP_REASON_LABELS,
  type OfferedDecision,
} from "../types";

/**
 * Your decision — the only place in SpotLens where a decision is created.
 *
 * Nothing else writes one. Opening an analysis, asking the Coach, sizing a
 * position and reading a notification all leave the journal untouched; a
 * decision exists because a person pressed a button here and confirmed it.
 * That is the distinction the whole journal rests on — the engine finding a
 * setup, the reader deciding about it, and the trade actually happening are
 * three different facts, and inferring any one from another would collapse
 * them.
 *
 * It also does not place an order. There is no order path in this application
 * at all, and "Take" means "I have decided to take this setup" — which is why
 * it is the one choice that asks again before recording.
 */

interface ExistingEntry {
  id: string;
  decision: JournalDecision;
  notes: string | null;
  skipReason: JournalSkipReason | null;
  decidedAt: string;
  coachReviewed: boolean;
}

export interface DecisionTarget {
  symbol: string;
  timeframe: string;
  runId: string;
  setupId: string | null;
}

/** The Coach reading that was on screen, when one was. Never an approval. */
export interface CoachReadingRef {
  providerId: string;
  verdict: string;
}

export function DecisionPanel({
  target,
  existing,
  coach,
}: {
  target: DecisionTarget;
  existing: ExistingEntry | null;
  /**
   * Passed only by a surface that actually rendered a review. A decision made
   * without one is an ordinary decision, not an incomplete one.
   */
  coach?: CoachReadingRef | null;
}) {
  const queryClient = useQueryClient();

  const [choice, setChoice] = useState<OfferedDecision | null>(null);
  const [note, setNote] = useState(existing?.notes ?? "");
  const [skipReason, setSkipReason] = useState<JournalSkipReason | "">(existing?.skipReason ?? "");
  const [confirming, setConfirming] = useState(false);
  const [entryId, setEntryId] = useState<string | null>(existing?.id ?? null);

  const current = existing?.decision ?? null;

  const record = useMutation({
    mutationFn: async (decision: OfferedDecision) => {
      // The note and the reason are the user's own words and travel with the
      // decision. No timestamp is sent: the server stamps it, because a moment
      // the browser chose is not a record of when anything happened.
      const body = {
        ...(note.trim() ? { notes: note.trim() } : {}),
        ...(decision === "SKIPPED" && skipReason ? { skipReason } : {}),
        ...(coach ? { coach: { providerId: coach.providerId, verdict: coach.verdict } } : {}),
      };

      const patch = (id: string) =>
        fetchApi(`/api/journal/${id}/decision`, {
          method: "PATCH",
          body: JSON.stringify({ decision, ...body }),
        });

      if (entryId) {
        await patch(entryId);
        return entryId;
      }

      // Creating and deciding in one call. The endpoint is idempotent, so a
      // double submission returns the first entry rather than a second one.
      const created = await fetchApi<{ id: string; created: boolean }>("/api/journal", {
        method: "POST",
        body: JSON.stringify({
          ...(target.setupId
            ? { trackedSetupId: target.setupId }
            : { runId: target.runId, symbol: target.symbol, timeframe: target.timeframe }),
          decision,
          ...body,
        }),
      });

      // An entry that already existed — journaled in another tab, or from the
      // setups page — comes back untouched, because creating is idempotent and
      // does not apply a decision to a row it did not create. Without this the
      // panel would report a decision recorded that the service had ignored.
      if (!created.created) await patch(created.id);

      return created.id;
    },
    onSuccess: (id) => {
      setEntryId(id);
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["journal"] });
      queryClient.invalidateQueries({ queryKey: ["decision-context"] });
    },
  });

  // A decision the journal would refuse is not offered. `canTransition` is the
  // journal's own rule, imported rather than re-expressed, so the buttons and
  // the service cannot disagree about what is allowed.
  const allowed = (decision: OfferedDecision): boolean =>
    current === null || current === decision || canTransition(current, decision);

  const recorded = record.isSuccess;
  const pending = record.isPending;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Your decision</h2>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Separate from anything SpotLens or the Coach concluded. This records what <em>you</em>{" "}
            decided, so that later you can tell the three apart: what the engine found, what you
            chose, and what the trade actually did.
          </p>
        </div>

        {current && (
          <p className="rounded-md bg-muted px-3 py-2 text-[11px] text-muted-foreground">
            Currently recorded as{" "}
            <span className="font-medium text-foreground">{current.toLowerCase()}</span>
            {existing?.decidedAt
              ? `, decided ${new Date(existing.decidedAt).toLocaleString()}`
              : ""}
            . Changing it appends to the history rather than replacing it.
          </p>
        )}

        {/* Radio semantics, because these are one choice among three and a
            screen reader should say so. Large hit areas: this is the screen
            most likely to be used on a phone. */}
        <div role="radiogroup" aria-label="Your decision" className="grid gap-2">
          {OFFERED_DECISIONS.map((decision) => {
            const copy = DECISION_COPY[decision];
            const enabled = allowed(decision);
            const selected = choice === decision;

            return (
              <button
                key={decision}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!enabled || pending}
                onClick={() => {
                  setChoice(decision);
                  setConfirming(false);
                }}
                className={cn(
                  "rounded-md border px-3 py-2.5 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  // Deliberately not green for Take and not red for Skip. A
                  // colour that says "yes, do it" is pressure, and this screen
                  // has no business applying any.
                  selected ? "border-primary bg-accent" : "border-border hover:bg-accent/50",
                  !enabled && "cursor-not-allowed opacity-40",
                )}
              >
                <span className="block text-sm font-medium">{copy.label}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                  {enabled
                    ? copy.meaning
                    : `Not available from ${current?.toLowerCase()} — the journal does not allow that change.`}
                </span>
              </button>
            );
          })}
        </div>

        {choice === "SKIPPED" && (
          <div className="space-y-1">
            <label htmlFor="skip-reason" className="text-[11px] font-medium">
              Why are you skipping it? <span className="text-muted-foreground">Optional</span>
            </label>
            <select
              id="skip-reason"
              value={skipReason}
              onChange={(event) => setSkipReason(event.target.value as JournalSkipReason | "")}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">No reason recorded</option>
              {Object.entries(SKIP_REASON_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* The reader's own reasoning, in their own words. Never pre-filled and
            never generated — a note SpotLens wrote would be SpotLens's opinion
            wearing the reader's name. */}
        <div className="space-y-1">
          <label htmlFor="decision-note" className="text-[11px] font-medium">
            Your reasoning <span className="text-muted-foreground">Optional</span>
          </label>
          <textarea
            id="decision-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="What made up your mind? For example: waiting for stronger volume, or the higher timeframe looks weak."
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        {/* Take asks again. Not because it is dangerous — nothing is placed —
            but because it is the one decision people misread, and the sentence
            that clears that up belongs at the moment of pressing it. */}
        {confirming && choice === "TAKEN" ? (
          <Alert variant="muted">
            <AlertDescription className="space-y-2">
              <p className="text-[11px] leading-relaxed">
                You are recording that you decided to take this setup.{" "}
                <span className="font-medium text-foreground">
                  SpotLens will not place an order.
                </span>{" "}
                Nothing is sent to an exchange, and no position is opened. If you go on to trade it,
                you can record what actually happened afterwards.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={pending} onClick={() => record.mutate("TAKEN")}>
                  {pending ? "Recording…" : "Record decision"}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : (
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={choice === null || pending}
            onClick={() => {
              if (choice === null) return;
              if (choice === "TAKEN") {
                setConfirming(true);
                return;
              }
              record.mutate(choice);
            }}
          >
            {pending ? "Recording…" : "Record decision"}
          </Button>
        )}

        {record.isError && (
          <Alert variant="destructive">
            <AlertDescription className="text-[11px]">
              {(record.error as Error).message} Nothing was recorded.
            </AlertDescription>
          </Alert>
        )}

        {recorded && entryId && (
          <Alert variant="muted">
            <AlertDescription className="space-y-2">
              <p className="text-[11px] leading-relaxed">
                <span className="font-medium text-foreground">Decision recorded.</span> No trade was
                executed by SpotLens.
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href={`/journal/${entryId}`}>
                  <NotebookPen className="h-3.5 w-3.5" />
                  View journal entry
                </Link>
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
