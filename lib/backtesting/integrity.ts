import { TIMEFRAME_MS, type Candle, type Timeframe } from "@/lib/market-data/provider";

/**
 * Dataset validation.
 *
 * A backtest is a claim about history, so it is only as good as the history it
 * was given. Silently replaying a series with a three-day hole in it produces
 * numbers that look exactly like numbers from a complete one — which is the
 * worst possible failure mode for a research tool.
 *
 * Nothing here repairs anything. A fabricated candle would be indistinguishable
 * from a real one in the output, and inventing data to make a report look
 * complete is precisely the dishonesty this file exists to prevent.
 */

export type IntegrityIssueKind =
  "DUPLICATE_CANDLE" | "OUT_OF_ORDER" | "GAP" | "INVALID_OHLC" | "EMPTY";

export interface IntegrityIssue {
  kind: IntegrityIssueKind;
  /** Index in the supplied series, where that is meaningful. */
  index: number;
  at: number | null;
  detail: string;
  /** Fatal issues stop the run; the rest mark the dataset incomplete. */
  fatal: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  /** True when a fatal issue was found and the run must not proceed. */
  fatal: boolean;
  issues: IntegrityIssue[];
  /** Candles missing from the series, inferred from the interval. */
  missingCandles: number;
}

/** Issues listed individually before collapsing into a count. */
const MAX_REPORTED_ISSUES = 20;

/**
 * Checks a candle series for the faults that would quietly corrupt a result.
 *
 * Duplicates and out-of-order candles are fatal: both break the assumption
 * every loop in the runner makes, that index order is time order. A gap is not
 * fatal — exchanges do have outages, and a run across one is still informative
 * provided the report says so.
 */
export function checkIntegrity(candles: Candle[], timeframe: Timeframe): IntegrityReport {
  const issues: IntegrityIssue[] = [];
  let missingCandles = 0;

  if (candles.length === 0) {
    return {
      ok: false,
      fatal: true,
      issues: [
        {
          kind: "EMPTY",
          index: -1,
          at: null,
          detail: "The provider returned no candles for this range.",
          fatal: true,
        },
      ],
      missingCandles: 0,
    };
  }

  const step = TIMEFRAME_MS[timeframe];
  const seen = new Set<number>();

  for (let i = 0; i < candles.length; i += 1) {
    const candle = candles[i];

    if (!isValidOhlc(candle)) {
      push(issues, {
        kind: "INVALID_OHLC",
        index: i,
        at: candle.openTime,
        detail: describeInvalid(candle),
        fatal: true,
      });
    }

    if (seen.has(candle.openTime)) {
      push(issues, {
        kind: "DUPLICATE_CANDLE",
        index: i,
        at: candle.openTime,
        detail: `A candle for ${new Date(candle.openTime).toISOString()} appears more than once.`,
        fatal: true,
      });
    }
    seen.add(candle.openTime);

    if (i === 0) continue;

    const previous = candles[i - 1];

    if (candle.openTime <= previous.openTime) {
      push(issues, {
        kind: "OUT_OF_ORDER",
        index: i,
        at: candle.openTime,
        detail: `Candle ${i} opens at or before the one before it, so index order is not time order.`,
        fatal: true,
      });
      continue;
    }

    const elapsed = candle.openTime - previous.openTime;
    if (elapsed > step) {
      const missing = Math.round(elapsed / step) - 1;
      missingCandles += missing;
      push(issues, {
        kind: "GAP",
        index: i,
        at: previous.openTime,
        detail: `${missing} ${missing === 1 ? "candle is" : "candles are"} missing after ${new Date(
          previous.openTime,
        ).toISOString()}.`,
        fatal: false,
      });
    }
  }

  const fatal = issues.some((issue) => issue.fatal);

  return { ok: issues.length === 0, fatal, issues, missingCandles };
}

function push(issues: IntegrityIssue[], issue: IntegrityIssue): void {
  if (issues.length < MAX_REPORTED_ISSUES) issues.push(issue);
}

/**
 * The invariants an OHLC candle must satisfy to be usable.
 *
 * The high/low containment checks matter most: the trade simulator decides
 * every exit by comparing against `high` and `low`, so a candle whose high is
 * below its close would silently produce impossible fills.
 */
function isValidOhlc(candle: Candle): boolean {
  const values = [candle.open, candle.high, candle.low, candle.close];

  if (!values.every((v) => Number.isFinite(v) && v > 0)) return false;
  if (!Number.isFinite(candle.volume) || candle.volume < 0) return false;
  if (candle.high < candle.low) return false;
  if (candle.high < Math.max(candle.open, candle.close)) return false;
  if (candle.low > Math.min(candle.open, candle.close)) return false;
  if (candle.closeTime <= candle.openTime) return false;

  return true;
}

function describeInvalid(candle: Candle): string {
  if (
    ![candle.open, candle.high, candle.low, candle.close].every((v) => Number.isFinite(v) && v > 0)
  )
    return "A price on this candle is missing, zero or negative.";
  if (candle.high < candle.low) return "The high is below the low.";
  if (candle.high < Math.max(candle.open, candle.close))
    return "The high is below the open or the close.";
  if (candle.low > Math.min(candle.open, candle.close))
    return "The low is above the open or the close.";
  if (candle.closeTime <= candle.openTime) return "The candle closes at or before it opens.";
  return "The candle failed an OHLC sanity check.";
}
