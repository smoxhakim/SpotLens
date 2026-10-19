import { TIMEFRAME_MS, type Timeframe } from "@/lib/market-data/provider";

/**
 * Whether a setup's analysis is recent enough to alert on.
 *
 * An entry-zone alert says "price reached a level a recent analysis offered".
 * Without this rule it said something weaker: "price reached a level that was
 * offered at some point" — and a monitor running for two weeks without a scan
 * alerted on setups whose analysis was two weeks old, which no confirmation
 * state or score from that day could still vouch for.
 *
 * ## What "verified" means
 *
 * The time of the most recent **completed** scanner pass that analysed this
 * setup's market and timeframe successfully and found this same setup still
 * open. That is a `ScannerResult` with `status = OK` and this `trackedSetupId`,
 * on a `ScannerRun` that has a `completedAt` and a status of COMPLETED or
 * PARTIAL. The scanner writes a result's `trackedSetupId` on every pass — the
 * existing id when nothing changed, the new id on creation or replacement — and
 * writes a run's results and its `completedAt` in one transaction, so a run that
 * is still running or that crashed has no results to point at.
 *
 * Not the setup's `createdAt`: a setup stays open across many passes, and when it
 * was first seen says nothing about whether the market still supports it. Not
 * the creating run either, for the same reason — a setup re-confirmed an hour
 * ago is fresh however long ago it was created.
 *
 * ## The rule
 *
 * Fresh when `now - verifiedAt <= maxAgeCandles × timeframe + grace`.
 * Measured in the setup's own candles because the scanner re-checks a timeframe
 * once per close of that timeframe: one absolute limit would either let H1
 * setups go four hours stale (sized for H4) or silence every H4 setup for three
 * hours in four (sized for H1).
 *
 * Fails closed: no verification, a timestamp that is not a time, a timestamp
 * from the future, or an unknown timeframe all mean "not fresh".
 */

/**
 * Default: the setup's most recent scheduled pass must have re-confirmed it.
 *
 * One candle plus grace is the strictest limit an on-schedule scanner always
 * meets — H1 within 1h15m, H4 within 4h15m. The trade-off is deliberate: a
 * single missed or failed pass (a laptop asleep, one market's data failing)
 * withholds that setup's alert until the next successful pass, in exchange for
 * never alerting on analysis older than one candle of its own timeframe. Set 2
 * to tolerate one missed pass.
 */
export const DEFAULT_MAX_SETUP_AGE_CANDLES = 1;

/** Upper bound on the configured multiplier, so a typo cannot disable the guard. */
export const MAX_SETUP_AGE_CANDLES_CEILING = 24;

/**
 * Slack for a pass finishing later than the one before it: the 90-second settle
 * delay, the pass itself (usually 15–60 s), and retries on a slow exchange.
 */
export const SETUP_AGE_GRACE_MS = 15 * 60_000;

/** A verification more than this far in the future is not a time, it is a fault. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export type StaleReason =
  /** No completed scan has ever re-confirmed this setup (e.g. tracked from the analysis page). */
  | "NO_VERIFIED_SCAN"
  /** The timestamp, or the timeframe needed to judge it, cannot be trusted. */
  | "INVALID_TIMESTAMP"
  /** The last verification is older than the limit. */
  | "STALE";

export type FreshnessVerdict =
  | { fresh: true; verifiedAt: number; ageMs: number; maxAgeMs: number }
  | {
      fresh: false;
      reason: StaleReason;
      verifiedAt: number | null;
      ageMs: number | null;
      maxAgeMs: number | null;
    };

export function maxSetupAgeMs(timeframe: Timeframe, maxAgeCandles: number): number | null {
  const candle = TIMEFRAME_MS[timeframe];
  if (!Number.isFinite(candle) || candle <= 0) return null;
  if (!Number.isFinite(maxAgeCandles) || maxAgeCandles <= 0) return null;
  return maxAgeCandles * candle + SETUP_AGE_GRACE_MS;
}

export function setupFreshness(input: {
  verifiedAt: number | null;
  timeframe: Timeframe;
  now: number;
  maxAgeCandles?: number;
}): FreshnessVerdict {
  const maxAgeMs = maxSetupAgeMs(
    input.timeframe,
    input.maxAgeCandles ?? DEFAULT_MAX_SETUP_AGE_CANDLES,
  );
  const { verifiedAt, now } = input;

  if (verifiedAt === null) {
    return { fresh: false, reason: "NO_VERIFIED_SCAN", verifiedAt: null, ageMs: null, maxAgeMs };
  }

  if (
    maxAgeMs === null ||
    !Number.isFinite(verifiedAt) ||
    verifiedAt <= 0 ||
    !Number.isFinite(now) ||
    verifiedAt > now + CLOCK_SKEW_TOLERANCE_MS
  ) {
    return { fresh: false, reason: "INVALID_TIMESTAMP", verifiedAt, ageMs: null, maxAgeMs };
  }

  const ageMs = Math.max(0, now - verifiedAt);
  if (ageMs > maxAgeMs) return { fresh: false, reason: "STALE", verifiedAt, ageMs, maxAgeMs };

  return { fresh: true, verifiedAt, ageMs, maxAgeMs };
}

/**
 * Reads the configured multiplier, never weaker than it should be by accident.
 *
 * Unset means the default. A value that is not a positive number falls back to
 * the default (with a warning) rather than to "no limit"; a value above the
 * ceiling is clamped to it.
 */
export function parseMaxSetupAgeCandles(raw: string | undefined): {
  value: number;
  warning: string | null;
} {
  if (raw === undefined || raw.trim() === "") {
    return { value: DEFAULT_MAX_SETUP_AGE_CANDLES, warning: null };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return {
      value: DEFAULT_MAX_SETUP_AGE_CANDLES,
      warning: `ENTRY_MONITOR_MAX_SETUP_AGE_CANDLES is not a positive number; using ${DEFAULT_MAX_SETUP_AGE_CANDLES}.`,
    };
  }
  if (value > MAX_SETUP_AGE_CANDLES_CEILING) {
    return {
      value: MAX_SETUP_AGE_CANDLES_CEILING,
      warning: `ENTRY_MONITOR_MAX_SETUP_AGE_CANDLES is above ${MAX_SETUP_AGE_CANDLES_CEILING}; using ${MAX_SETUP_AGE_CANDLES_CEILING}.`,
    };
  }
  return { value, warning: null };
}
