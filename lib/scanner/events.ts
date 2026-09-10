import type { SetupLifecycleStatus } from "@/lib/setups";

import type { ScannerFailureCategory } from "./failures";

/**
 * What a scan observed, as structured events.
 *
 * The scanner knows nothing about how these are delivered. Phase F will consume
 * them; keeping the vocabulary here rather than inside a notification provider
 * is what stops the scanner growing a dependency on one.
 */
export type ScannerEventType =
  "SETUP_CREATED" | "SETUP_STATE_CHANGED" | "SETUP_INVALIDATED" | "ANALYSIS_FAILED";

export interface ScannerEvent {
  type: ScannerEventType;
  symbol: string;
  timeframe: string;
  setupId: string | null;
  lifecycleStatus: SetupLifecycleStatus | null;
  failureCategory: ScannerFailureCategory | null;
  detail: string;
}

/** What the lifecycle service reported after one market was analysed. */
export interface LifecycleOutcome {
  action: "NONE" | "CREATE" | "TRANSITION" | "REPLACE";
  setupId: string | null;
  status: SetupLifecycleStatus | null;
}

/**
 * Derives the events for one market from what the lifecycle actually did.
 *
 * Driven by the lifecycle's own outcome rather than by comparing analysis
 * results, so deduplication is decided in exactly one place. A run that changed
 * nothing produces no events, which is the property notifications will depend
 * on — the alternative is telling someone four times an hour that nothing has
 * happened.
 *
 * A REPLACE is two things happening at once: the old setup's level is gone, and
 * a new one exists. Both are reported, because collapsing them would hide an
 * invalidation that a reader waiting on that level needs to know about.
 */
export function eventsForOutcome(input: {
  outcome: LifecycleOutcome;
  symbol: string;
  timeframe: string;
  detail: string;
}): ScannerEvent[] {
  const { outcome, symbol, timeframe, detail } = input;

  const base = {
    symbol,
    timeframe,
    setupId: outcome.setupId,
    lifecycleStatus: outcome.status,
    failureCategory: null,
  };

  switch (outcome.action) {
    case "NONE":
      return [];

    case "CREATE":
      return [{ ...base, type: "SETUP_CREATED", detail }];

    case "TRANSITION":
      return [
        {
          ...base,
          type: outcome.status === "INVALIDATED" ? "SETUP_INVALIDATED" : "SETUP_STATE_CHANGED",
          detail,
        },
      ];

    case "REPLACE":
      return [
        {
          ...base,
          type: "SETUP_INVALIDATED",
          setupId: null,
          lifecycleStatus: "INVALIDATED",
          detail: "The entry moved to a different level, so the previous setup was closed.",
        },
        { ...base, type: "SETUP_CREATED", detail },
      ];
  }
}

/** The event for a market that could not be analysed at all. */
export function failureEvent(input: {
  symbol: string;
  timeframe: string;
  category: ScannerFailureCategory;
  message: string;
}): ScannerEvent {
  return {
    type: "ANALYSIS_FAILED",
    symbol: input.symbol,
    timeframe: input.timeframe,
    setupId: null,
    lifecycleStatus: null,
    failureCategory: input.category,
    detail: input.message,
  };
}
