import {
  analyzeMultiTimeframe,
  assessHigherTimeframe,
  runAnalysis,
  staleEntryTimeframe,
  unavailableHigherTimeframe,
  HIGHER_TIMEFRAME_GRACE_MS,
  type AnalysisResult,
  type AnalysisShortfall,
  type MtfSummary,
  type RunAnalysisOptions,
} from "@/lib/analysis";
import { TIMEFRAME_MS, type Candle } from "@/lib/market-data/provider";
import { makeCandles } from "@/lib/test-utils/candles";
import {
  downtrend,
  extendedAboveSupport,
  poorRiskReward,
  pullbackIntoSupport,
  pullbackOnThinVolume,
  rangeBound,
  repeatedPullbacks,
  thinHistory,
  weakEvidence,
} from "@/lib/test-utils/scenarios";

import {
  RETEST_CLOSES,
  flatMarket,
  nearZeroRange,
  zoneRetest,
  zoneRetestRejection,
} from "./fixtures";

/**
 * The golden-master corpus (Phase 5, commit 0).
 *
 * Every case is a candle series plus the options a real caller would pass. The
 * multi-timeframe cases follow the production invariant: the lower candles
 * handed to `analyzeMultiTimeframe` are exactly the candles handed to
 * `runAnalysis`, as the scanner, the manual route and the backtester all do.
 *
 * Test code only — nothing in the application imports this file.
 */

export type CaseGroup = "scenario" | "boundary" | "mtf" | "incomplete" | "forming" | "sweep";

export interface GoldenCase {
  id: string;
  group: CaseGroup;
  candles: Candle[];
  options: RunAnalysisOptions;
}

export interface GoldenRun extends GoldenCase {
  result: AnalysisResult;
}

/** H1 read against H4, the way the scanner pairs them. */
export function mtfOf(lower: Candle[], higher: Candle[]): MtfSummary {
  return analyzeMultiTimeframe({
    lowerCandles: lower,
    higherCandles: higher,
    lowerTimeframe: "H1",
    higherTimeframe: "H4",
  });
}

function expectShortfall(value: AnalysisShortfall | null, what: string): AnalysisShortfall {
  if (!value) throw new Error(`Golden corpus: expected ${what} to be reported as a shortfall.`);
  return value;
}

const SCENARIOS: [string, () => Candle[]][] = [
  ["empty", () => []],
  ["single-candle", () => makeCandles([100])],
  ["flat-80", flatMarket],
  ["near-zero-range", nearZeroRange],
  ["pullbackIntoSupport", pullbackIntoSupport],
  ["pullbackOnThinVolume", pullbackOnThinVolume],
  ["downtrend", downtrend],
  ["extendedAboveSupport", extendedAboveSupport],
  ["rangeBound", rangeBound],
  ["repeatedPullbacks-90", () => repeatedPullbacks(90)],
  ["thinHistory", thinHistory],
  ["poorRiskReward", poorRiskReward],
  ["weakEvidence", weakEvidence],
];

/** Lower series × higher series, read as H1 against H4. */
const MTF_PAIRS: [string, () => Candle[], string, () => Candle[]][] = [
  ["pullbackIntoSupport", pullbackIntoSupport, "pullbackIntoSupport", pullbackIntoSupport],
  ["pullbackIntoSupport", pullbackIntoSupport, "downtrend", downtrend],
  ["pullbackIntoSupport", pullbackIntoSupport, "rangeBound", rangeBound],
  ["downtrend", downtrend, "downtrend", downtrend],
  ["downtrend", downtrend, "pullbackIntoSupport", pullbackIntoSupport],
  ["rangeBound", rangeBound, "pullbackIntoSupport", pullbackIntoSupport],
  ["rangeBound", rangeBound, "downtrend", downtrend],
  ["extendedAboveSupport", extendedAboveSupport, "pullbackIntoSupport", pullbackIntoSupport],
  ["pullbackOnThinVolume", pullbackOnThinVolume, "pullbackIntoSupport", pullbackIntoSupport],
  ["zoneRetest@102", () => zoneRetest(102), "pullbackIntoSupport", pullbackIntoSupport],
  ["zoneRetest@103", () => zoneRetest(103), "pullbackIntoSupport", pullbackIntoSupport],
  ["zoneRetest@105", () => zoneRetest(105), "pullbackIntoSupport", pullbackIntoSupport],
  ["zoneRetest@103", () => zoneRetest(103), "downtrend", downtrend],
  ["zoneRetestRejection", zoneRetestRejection, "pullbackIntoSupport", pullbackIntoSupport],
];

/**
 * Every hand-picked case: the existing scenarios, the zone-boundary fixtures,
 * multi-timeframe pairs, each kind of incomplete data, and the forming-candle
 * path the manual routes take.
 */
export function namedCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];
  const add = (
    id: string,
    group: CaseGroup,
    candles: Candle[],
    options: RunAnalysisOptions = {},
  ) => {
    cases.push({ id, group, candles, options });
  };

  for (const [id, build] of SCENARIOS) add(id, "scenario", build());

  for (const close of RETEST_CLOSES) add(`zoneRetest@${close}`, "boundary", zoneRetest(close));
  add("zoneRetestRejection", "boundary", zoneRetestRejection());

  for (const [lowerId, lower, higherId, higher] of MTF_PAIRS) {
    const candles = lower();
    add(`${lowerId}|H4:${higherId}`, "mtf", candles, { mtf: mtfOf(candles, higher()) });
  }

  // A summary no real read produces — ALIGNED_BEARISH with no conflict note —
  // to reach the fallback sentence in `runAnalysis`'s higher-timeframe veto.
  const constructedId = "pullbackIntoSupport|H4:constructed-aligned-bearish-without-note";
  add(constructedId, "mtf", pullbackIntoSupport(), {
    mtf: { ...mtfOf(downtrend(), downtrend()), conflictNote: null },
  });

  // Incomplete data, as the manual routes declare it. Every shortfall kind is
  // built by the real functions that produce it.
  const thin = thinHistory();
  const higher = pullbackIntoSupport();
  const lastClose = higher[higher.length - 1].closeTime;
  const shortfalls: [string, AnalysisShortfall][] = [
    ["stale-entry", staleEntryTimeframe("H1")],
    ["htf-not-checked", unavailableHigherTimeframe("H4", "NOT_CHECKED")],
    ["htf-unavailable", unavailableHigherTimeframe("H4", "UNAVAILABLE")],
    [
      "htf-insufficient",
      expectShortfall(
        assessHigherTimeframe({
          candles: thin,
          timeframe: "H4",
          now: thin[thin.length - 1].closeTime + 1,
        }),
        "a 20-candle higher timeframe",
      ),
    ],
    [
      "htf-invalid",
      expectShortfall(
        assessHigherTimeframe({
          candles: [...higher].reverse(),
          timeframe: "H4",
          now: lastClose + 1,
        }),
        "out-of-order higher-timeframe candles",
      ),
    ],
    [
      "htf-served-stale",
      expectShortfall(
        assessHigherTimeframe({
          candles: higher,
          timeframe: "H4",
          now: lastClose + 1,
          servedStale: true,
        }),
        "a higher timeframe served from cache",
      ),
    ],
    [
      "htf-head-missing",
      expectShortfall(
        assessHigherTimeframe({
          candles: higher,
          timeframe: "H4",
          now: lastClose + 1 + TIMEFRAME_MS.H4 + HIGHER_TIMEFRAME_GRACE_MS + 1,
        }),
        "a higher timeframe missing its newest candle",
      ),
    ],
  ];
  for (const [kind, incomplete] of shortfalls) {
    add(`pullbackIntoSupport|${kind}`, "incomplete", pullbackIntoSupport(), { incomplete });
  }
  // Incomplete data on verdicts that were never going to be a potential setup.
  add("downtrend|stale-entry", "incomplete", downtrend(), {
    incomplete: staleEntryTimeframe("H1"),
  });
  add("pullbackOnThinVolume|stale-entry", "incomplete", pullbackOnThinVolume(), {
    incomplete: staleEntryTimeframe("H1"),
  });
  add("zoneRetest@105|htf-unavailable", "incomplete", zoneRetest(105), {
    incomplete: unavailableHigherTimeframe("H4", "UNAVAILABLE"),
  });

  // The manual routes keep the forming candle and say so. Volume and
  // confirmation drop it; everything else reads it.
  add("pullbackIntoSupport|forming", "forming", pullbackIntoSupport(), {
    lastCandleIsForming: true,
  });
  add("zoneRetestRejection|forming", "forming", zoneRetestRejection(), {
    lastCandleIsForming: true,
  });
  add("repeatedPullbacks-90|forming", "forming", repeatedPullbacks(90), {
    lastCandleIsForming: true,
  });

  return cases;
}

/**
 * Candle-window prefixes: the engine as the backtester sees it, bar by bar.
 *
 * Every prefix of at least the minimum read (60 candles), so a change that
 * only shows on some bars still shows. Two of the sweeps are repeated against
 * a fixed higher timeframe, so the multi-timeframe gates are swept as well.
 */
export function sweepCases(): GoldenCase[] {
  const cases: GoldenCase[] = [];

  const pullbacks = repeatedPullbacks(90);
  const bullishHigher = pullbackIntoSupport();
  const bearishHigher = downtrend();

  for (let length = 60; length <= pullbacks.length; length += 1) {
    cases.push({
      id: `repeatedPullbacks-90/${length}`,
      group: "sweep",
      candles: pullbacks.slice(0, length),
      options: {},
    });
  }
  for (let length = 60; length <= pullbacks.length; length += 3) {
    const candles = pullbacks.slice(0, length);
    cases.push({
      id: `repeatedPullbacks-90/${length}|H4:pullbackIntoSupport`,
      group: "sweep",
      candles,
      options: { mtf: mtfOf(candles, bullishHigher) },
    });
  }
  for (let length = 60; length <= pullbacks.length; length += 9) {
    const candles = pullbacks.slice(0, length);
    cases.push({
      id: `repeatedPullbacks-90/${length}|H4:downtrend`,
      group: "sweep",
      candles,
      options: { mtf: mtfOf(candles, bearishHigher) },
    });
  }

  const pullback = pullbackIntoSupport();
  for (let length = 60; length <= pullback.length; length += 1) {
    cases.push({
      id: `pullbackIntoSupport/${length}`,
      group: "sweep",
      candles: pullback.slice(0, length),
      options: {},
    });
  }

  const falling = downtrend();
  for (let length = 60; length <= falling.length; length += 5) {
    cases.push({
      id: `downtrend/${length}`,
      group: "sweep",
      candles: falling.slice(0, length),
      options: {},
    });
  }

  return cases;
}

export function runCases(cases: GoldenCase[]): GoldenRun[] {
  return cases.map((c) => ({ ...c, result: runAnalysis(c.candles, c.options) }));
}
