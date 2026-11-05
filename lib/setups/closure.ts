import { formatPrice } from "@/lib/format";

import type { ClosureCause, SetupClosure, SetupOrigin } from "./types";

/**
 * Why a moved anchor closed a setup.
 *
 * The planner has one branch for an anchor that no longer overlaps the stored
 * zone, and very different things reach it: price closing through the level,
 * a close in the zone's lower half reclassifying it as resistance, and a nearer
 * support forming above it. The first is a level failing and the others are
 * not, so a reader needs them told apart.
 *
 * Judged from the analysed close against the zone stored with the setup, and
 * nothing else: no zone is re-drawn and no level recomputed, so this describes
 * what the engine decided and cannot change it. A close exactly on the zone's
 * low has not closed below it.
 */
export function closureOf(origin: SetupOrigin, close: number, anchor: SetupOrigin): SetupClosure {
  return {
    cause: causeOf(origin, close),
    close,
    originLow: origin.zoneLow,
    originHigh: origin.zoneHigh,
    anchorLow: anchor.zoneLow,
    anchorHigh: anchor.zoneHigh,
  };
}

function causeOf(origin: SetupOrigin, close: number): ClosureCause {
  if (close < origin.zoneLow) return "SUPPORT_LOST";
  return close <= (origin.zoneLow + origin.zoneHigh) / 2 ? "LOWER_HALF" : "SUPERSEDED";
}

/**
 * The stored reason for a close below the zone.
 *
 * The lower zone is named only when a replacement is created on it. The new
 * anchor always sits below the old zone here: it is support, so its midpoint is
 * below the close, and it does not overlap a zone the close is already below.
 */
export function supportLostReason(closure: SetupClosure, replaced: boolean): string {
  const closed =
    `Price closed at ${formatPrice(closure.close)}, below this setup's zone ` +
    `${formatPrice(closure.originLow)} – ${formatPrice(closure.originHigh)}, so the setup was closed.`;

  if (!replaced) return closed;

  return (
    `${closed} The engine now anchors to a lower zone: ` +
    `${formatPrice(closure.anchorLow)} – ${formatPrice(closure.anchorHigh)}.`
  );
}

const CLOSURE_CAUSES: readonly string[] = [
  "SUPPORT_LOST",
  "LOWER_HALF",
  "SUPERSEDED",
] satisfies ClosureCause[];

/**
 * The cause recorded on a stored event's payload, or null.
 *
 * Null for every event that carries none: an invalidation for any other reason,
 * and every re-anchor written before causes were recorded. It is read field by
 * field and never guessed from prices, so an old row keeps saying what it said.
 */
export function closureCauseOf(payload: unknown): ClosureCause | null {
  if (typeof payload !== "object" || payload === null) return null;

  const closure = (payload as { closure?: unknown }).closure;
  if (typeof closure !== "object" || closure === null) return null;

  const cause = (closure as { cause?: unknown }).cause;
  return typeof cause === "string" && CLOSURE_CAUSES.includes(cause)
    ? (cause as ClosureCause)
    : null;
}
