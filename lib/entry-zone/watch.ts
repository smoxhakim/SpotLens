import { isInZone, type PriceZone } from "@/lib/analysis/zones";

import type {
  PriceObservation,
  StoredWatch,
  WatchDecision,
  WatchMemory,
  WatchedSetup,
  ZonePosition,
} from "./types";

/**
 * Live entry-zone watching, as pure functions.
 *
 * No clock, no I/O, no database. The monitor service feeds in the setups, the
 * stored state and a price with its receipt time; everything decided here is a
 * function of those inputs, which is the only way the restart, re-entry and
 * gap-through rules get tested properly.
 *
 * Nothing here computes a level. The zone is the tracked setup's immutable
 * `entryLow`/`entryHigh`, and "inside" is the engine's own `isInZone` —
 * imported rather than restated, so the monitor and the analysis cannot
 * disagree about a boundary.
 */

/**
 * How old a price may be when it is evaluated.
 *
 * Measured from receipt, not from any exchange field (see `PriceQuote`). The
 * monitor evaluates immediately after a poll, so in normal running a quote is
 * milliseconds old; this exists for the abnormal case — a laptop waking from
 * sleep, a process stalled mid-cycle — where a reading taken long ago would
 * otherwise be judged as if it were current. 15s is one and a half default
 * polls: long enough never to reject a healthy cycle, short enough that no
 * reading from a previous cycle can pass.
 */
export const STALE_PRICE_MS = 15_000;

/** Default cadence for price polls. One request covers every watched symbol. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

/**
 * Default cadence for reloading open setups from the database.
 *
 * Setups only change when the scanner or an analysis runs, so reloading every
 * tick would be a query every ten seconds to learn nothing — and would keep a
 * Neon compute awake around the clock. Ten minutes lets it sleep between
 * reloads; a setup created in between is picked up on the next one.
 */
export const DEFAULT_REFRESH_INTERVAL_MS = 10 * 60_000;

export function zonePosition(price: number, entryLow: number, entryHigh: number): ZonePosition {
  // Boundaries are inside, exactly as the engine treats them. `isInZone` reads
  // only `low` and `high`; the rest of `PriceZone` describes how a zone was
  // found, which a stored entry zone no longer carries.
  if (isInZone(price, { low: entryLow, high: entryHigh } as PriceZone)) return "INSIDE";
  return price < entryLow ? "BELOW" : "ABOVE";
}

/**
 * The memory a setup starts from, built from its durable record.
 *
 * Armed by its creation state or by a stored observation; reached only by the
 * stored alert.
 */
export function initialMemory(setup: WatchedSetup, stored: StoredWatch | null): WatchMemory {
  return {
    armed: setup.createdOutside || stored?.armedAt != null,
    reached: stored?.reachedAt != null,
  };
}

/**
 * Folds a fresh database read into what is already in memory.
 *
 * Durable flags only ever move forward — another monitor may have armed or
 * alerted since the last reload, and a reload must never un-arm or un-reach a
 * setup.
 */
export function mergeMemory(current: WatchMemory | undefined, fresh: WatchMemory): WatchMemory {
  if (!current) return fresh;
  return {
    armed: current.armed || fresh.armed,
    reached: current.reached || fresh.reached,
  };
}

/**
 * Whether a price reading is fit to judge a transition on.
 *
 * Stale or impossible readings are skipped outright — not treated as outside,
 * not treated as inside. Skipping keeps the previous memory, so a bad reading
 * can neither raise an alert nor arm a setup.
 */
function skipReason(
  setup: WatchedSetup,
  observation: PriceObservation,
  now: number,
  staleAfterMs: number,
): "STALE" | "INVALID_PRICE" | "WRONG_SYMBOL" | null {
  if (observation.symbol !== setup.symbol) return "WRONG_SYMBOL";
  if (!Number.isFinite(observation.price) || observation.price <= 0) return "INVALID_PRICE";

  const age = now - observation.receivedAt;
  if (!Number.isFinite(age) || age < 0 || age > staleAfterMs) return "STALE";

  return null;
}

/**
 * What one price observation means for one setup.
 *
 * The rules, in the order they bind:
 *
 *  - A setup that has alerted stays silent for good. Re-entry is not reaching
 *    the zone again, and the dedupe key would refuse a second row anyway.
 *  - An alert needs an armed setup and a reading INSIDE. Armed-and-unreached
 *    already implies the previous reading was outside, because the first
 *    reading inside an armed setup is the alert. After a restart the previous
 *    reading is unknown, and an armed setup is then allowed to speak — it was
 *    outside, and it is in.
 *  - An unarmed setup seen inside says nothing: it may have been inside since
 *    before anyone was watching, and announcing that would be announcing the
 *    state of a chart rather than a change in it.
 *  - Seen outside, on either side, arms. ABOVE → BELOW is outside → outside: a
 *    gap through the zone with no reading inside it raises nothing.
 */
export function planEntryZoneWatch(input: {
  setup: WatchedSetup;
  memory: WatchMemory;
  observation: PriceObservation;
  now: number;
  staleAfterMs?: number;
}): WatchDecision {
  const { setup, memory, observation, now } = input;

  const skip = skipReason(setup, observation, now, input.staleAfterMs ?? STALE_PRICE_MS);
  if (skip) return { kind: "SKIPPED", reason: skip };

  const position = zonePosition(observation.price, setup.entryLow, setup.entryHigh);

  if (memory.reached) {
    return {
      kind: "OBSERVED",
      position,
      next: memory,
      arm: false,
      alert: false,
    };
  }

  if (position !== "INSIDE") {
    return {
      kind: "OBSERVED",
      position,
      next: { armed: true, reached: false },
      arm: !memory.armed,
      alert: false,
    };
  }

  // Armed and not yet reached means the last reading, if there was one, was
  // outside: an armed setup alerts on its first reading inside and is reached
  // from then on. So "armed" is the whole of "was outside, is now inside".
  const alert = memory.armed;

  return {
    kind: "OBSERVED",
    position,
    next: { armed: memory.armed, reached: alert },
    arm: false,
    alert,
  };
}

/**
 * Setups by symbol, so one price is read once and applied to every setup on
 * that market — H1 and H4, and every owner — each against its own zone and
 * its own memory. Order within a symbol is the input order.
 */
export function groupBySymbol(setups: WatchedSetup[]): Map<string, WatchedSetup[]> {
  const groups = new Map<string, WatchedSetup[]>();
  for (const setup of setups) {
    const group = groups.get(setup.symbol);
    if (group) group.push(setup);
    else groups.set(setup.symbol, [setup]);
  }
  return groups;
}
