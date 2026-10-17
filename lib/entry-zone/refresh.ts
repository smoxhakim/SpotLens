/**
 * When the monitor reloads its open setups.
 *
 * Setups only change when a scanner pass (or an analysis) runs, so reloading on
 * every price tick would be a query every ten seconds to learn nothing. Three
 * triggers instead, cheapest knowledge first:
 *
 *  - REQUESTED: the engine relayed "a scan just completed". Immediate, and free —
 *    no query was needed to learn it.
 *  - CHECK_SCANNER: a one-row read of the latest completed `ScannerRun`, on its
 *    own interval. It is what catches a pass the monitor was not told about —
 *    `scanner:once` from another terminal, or a monitor run on its own — and it
 *    triggers a reload only when the run is new.
 *  - FULL: the long-standing periodic reload, kept as the safety net for
 *    changes no scanner run announces (a setup tracked from the analysis page).
 *
 * Pure, with the clock passed in.
 */
export type RefreshPlan = "FULL" | "REQUESTED" | "CHECK_SCANNER" | "NONE";

/**
 * Default interval for the scanner-run check.
 *
 * One indexed single-row read a minute. Short enough that a scan the engine did
 * not relay is picked up within a minute; any interval under five minutes keeps
 * a Neon compute from auto-suspending, which is why it is configurable — under
 * the engine the relay already makes the handoff immediate.
 */
export const DEFAULT_SCANNER_CHECK_MS = 60_000;

export function planRefresh(input: {
  now: number;
  lastFullRefreshAt: number;
  refreshMs: number;
  requested: boolean;
  lastScannerCheckAt: number;
  scannerCheckMs: number;
}): RefreshPlan {
  if (input.now - input.lastFullRefreshAt >= input.refreshMs) return "FULL";
  if (input.requested) return "REQUESTED";
  if (input.now - input.lastScannerCheckAt >= input.scannerCheckMs) return "CHECK_SCANNER";
  return "NONE";
}
