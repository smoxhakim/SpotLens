"use client";

import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import type { DecisionSetup, LateEntryClaim } from "@/lib/journal";

/**
 * Recording a trade that was entered before its setup closed.
 *
 * The one way to record "taken" on a closed setup, and deliberately not a
 * button press: the reader states, in their own words and time, that the trade
 * was entered while the setup was still open. SpotLens cannot check that — it
 * has no order path — so the form says plainly that it is recorded as their
 * statement, and offers only the window the setup was actually open.
 *
 * Validation is the journal's own rule (`checkSetupDecision`), run by the
 * caller and shown here, so the form and the server cannot disagree.
 */

/** The form's state, and the claim it adds up to. */
export function useLateEntryClaim() {
  const [acknowledged, setAcknowledged] = useState(false);
  const [enteredAt, setEnteredAt] = useState("");

  // Nothing typed and nothing ticked is no claim at all; anything else is sent
  // as it stands and judged by the rule, so a half-filled form is refused, not
  // completed by a guess.
  const claim: LateEntryClaim | null =
    !acknowledged && enteredAt === ""
      ? null
      : { acknowledged, enteredAt: enteredAt === "" ? Number.NaN : fromLocalInput(enteredAt) };

  return { acknowledged, setAcknowledged, enteredAt, setEnteredAt, claim };
}

export function LateEntryForm({
  setup,
  state,
  error,
}: {
  setup: DecisionSetup | null;
  state: ReturnType<typeof useLateEntryClaim>;
  /** The rule's verdict on the claim as it stands. Null when it would be accepted. */
  error: string | null;
}) {
  const firstSeen = setup?.firstSeenAt ?? null;
  const closed = setup?.closedAt ?? null;
  const touched = state.acknowledged || state.enteredAt !== "";

  return (
    <Alert variant="warning" data-late-entry="">
      <AlertDescription className="space-y-2 text-[11px] leading-relaxed">
        <p>
          <span className="font-medium">This setup is closed.</span> Taken is recorded here only for
          a trade you already entered while it was still open
          {firstSeen && closed
            ? ` — between ${new Date(firstSeen).toLocaleString()} and ${new Date(closed).toLocaleString()}`
            : ""}
          . It is not a way to enter a new one. SpotLens cannot check when you entered; what you
          state is kept as your own statement.
        </p>

        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={state.acknowledged}
            onChange={(event) => state.setAcknowledged(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            This setup is now closed, and I entered this trade earlier, while it was still open.
          </span>
        </label>

        <div className="space-y-1">
          <label htmlFor="late-entered-at" className="font-medium">
            When you entered <span className="font-normal">(your own time)</span>
          </label>
          <input
            id="late-entered-at"
            type="datetime-local"
            step={1}
            value={state.enteredAt}
            min={firstSeen ? toLocalInput(firstSeen) : undefined}
            max={closed ? toLocalInput(closed) : undefined}
            onChange={(event) => state.setEnteredAt(event.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        {touched && error && (
          <p data-late-entry-error="" aria-live="polite" className="font-medium">
            {error}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** A `datetime-local` value in the reader's own zone, to the second. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** A `datetime-local` value read in the reader's own zone. NaN when it is not a time. */
export function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}
