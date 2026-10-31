/**
 * Whether the scanner kept up during the trial.
 *
 * An analysis goes out of date once a newer candle of its timeframe has closed
 * (`analysisFreshness`). With the shortest timeframe an hour, a stretch longer
 * than an hour plus the tolerance between successful passes means at least one
 * closed candle that no pass read — and while it lasted, every analysis shown
 * was out of date and the entry-zone monitor withheld its alerts. Gaps are
 * measured and named, never filled.
 *
 * Pure: the window and the pass times are passed in, and nothing reads a clock.
 */
export interface CoverageGap {
  from: number;
  to: number;
  durationMs: number;
}

export interface Coverage {
  successfulPasses: number;
  failedPasses: number;
  /** The longest stretch without a successful pass, window edges included. Null for an empty window. */
  longestGapMs: number | null;
  /** Every stretch longer than the expected interval plus the tolerance. */
  gaps: CoverageGap[];
}

export function scanCoverage(input: {
  from: number;
  to: number;
  /** Start times of successful (COMPLETED or PARTIAL) passes. Any order. */
  passStarts: readonly number[];
  failedPasses: number;
  /** How often a pass is due: the shortest scanned timeframe. */
  expectedEveryMs: number;
  /** Slack for the settle delay and the pass itself. */
  toleranceMs: number;
}): Coverage {
  const { from, to } = input;
  if (!(to > from)) {
    return { successfulPasses: 0, failedPasses: input.failedPasses, longestGapMs: null, gaps: [] };
  }

  const inside = input.passStarts.filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  const edges = [from, ...inside, to];

  const gaps: CoverageGap[] = [];
  let longestGapMs = 0;
  for (let i = 1; i < edges.length; i += 1) {
    const durationMs = edges[i] - edges[i - 1];
    longestGapMs = Math.max(longestGapMs, durationMs);
    if (durationMs > input.expectedEveryMs + input.toleranceMs) {
      gaps.push({ from: edges[i - 1], to: edges[i], durationMs });
    }
  }

  return {
    successfulPasses: inside.length,
    failedPasses: input.failedPasses,
    longestGapMs,
    gaps,
  };
}
