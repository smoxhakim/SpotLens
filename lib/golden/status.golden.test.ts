import { describe, expect, it } from "vitest";

import {
  determineStatus,
  evaluateConfirmation,
  gradeFor,
  runAnalysis,
  MIN_ACCEPTABLE_RR,
  type ConfirmationResult,
  type EntryZone,
  type MarketRead,
  type MtfSummary,
  type PriceZone,
  type RiskReward,
  type SetupScore,
  type TradeStatus,
} from "@/lib/analysis";
import { makeCandles } from "@/lib/test-utils/candles";
import { downtrend, pullbackIntoSupport, rangeBound } from "@/lib/test-utils/scenarios";

import { mtfOf } from "./corpus";
import { classifyVerdict, goldenFile, line, type Branch } from "./project";

/**
 * Golden master for `determineStatus`, rule by rule (Phase 5, commit 0).
 *
 * The corpus in `engine.golden.test.ts` reaches most rules through real candle
 * series, but some are hard to reach that way and a few cannot be reached at
 * all through `runAnalysis`. This file reaches every one of them directly.
 *
 * It starts from the inputs of a real potential setup — `pullbackIntoSupport`,
 * which the existing suite pins at POTENTIAL_SETUP — and changes one input at a
 * time. Every rule ahead of the one being tripped is still satisfied, so the
 * rule tripped is the one that answers. A second set changes two inputs at
 * once and pins which of the two wins, which is the rule order itself.
 *
 * Expected statuses come from reading `status.ts`. A failure before any
 * production change means a case was written wrong; fix the case.
 */

interface Inputs {
  read: MarketRead;
  entry: EntryZone;
  riskReward: RiskReward;
  score: SetupScore;
  mtf?: MtfSummary;
  confirmation?: ConfirmationResult;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function baseline(): Inputs {
  const result = runAnalysis(pullbackIntoSupport());
  if (
    result.status !== "POTENTIAL_SETUP" ||
    !result.setup ||
    !result.score ||
    !result.confirmation
  ) {
    throw new Error("pullbackIntoSupport no longer reaches POTENTIAL_SETUP; the baseline is gone.");
  }
  return clone({
    read: result.read,
    entry: result.setup.entry,
    riskReward: result.setup.riskReward,
    score: result.score,
    confirmation: result.confirmation,
  });
}

function decide(inputs: Inputs) {
  return determineStatus(
    inputs.read,
    inputs.entry,
    inputs.riskReward,
    inputs.score,
    inputs.mtf,
    inputs.confirmation,
  );
}

// --- real confirmation results of each kind, as the confirmation tests build them ---

const TEST_ZONE: PriceZone = {
  low: 100,
  high: 104,
  mid: 102,
  kind: "SUPPORT",
  touches: 3,
  strength: 80,
  flipped: false,
  lastTouchIndex: 0,
  lastTouchTime: 0,
};
const TEST_ENTRY = { low: 100, high: 104, mid: 102, sourceZone: TEST_ZONE } as EntryZone;
const NO_VOLUME = { volume: { read: null, reason: "" } } as unknown as MarketRead;

/** A quiet chart: nothing at the level. Pinned NOT_PRESENT in confirmation/engine.test.ts. */
const NOT_PRESENT = evaluateConfirmation({
  read: NO_VOLUME,
  entry: TEST_ENTRY,
  candles: makeCandles(new Array(40).fill(110)),
});

/** The zone rejecting price downward. Pinned CONTRADICTED in confirmation/engine.test.ts. */
const CONTRADICTED = evaluateConfirmation({
  read: NO_VOLUME,
  entry: TEST_ENTRY,
  candles: [
    ...makeCandles(new Array(30).fill(108)),
    ...makeCandles([{ open: 103, high: 112, low: 100, close: 101, volume: 100 }]),
  ],
});

// --- one-input changes ------------------------------------------------------------

const setRatio = (inputs: Inputs, ratio: number) => {
  inputs.riskReward.ratio = ratio;
  inputs.riskReward.isPoor = ratio < MIN_ACCEPTABLE_RR;
};

const setScore = (inputs: Inputs, total: number) => {
  inputs.score.total = total;
  inputs.score.grade = gradeFor(total);
};

const outsideZone = (inputs: Inputs, distanceAtr: number) => {
  inputs.entry.priceInZone = false;
  inputs.entry.distanceAtr = distanceAtr;
};

const resistanceFrom = (inputs: Inputs, low: number) => {
  inputs.read.resistance = [
    {
      low,
      high: low + 2,
      mid: low + 1,
      kind: "RESISTANCE",
      touches: 2,
      strength: 50,
      flipped: false,
      lastTouchIndex: 0,
      lastTouchTime: 0,
    },
  ];
};

const setVolume = (inputs: Inputs, relative: number) => {
  if (!inputs.read.volume.read) throw new Error("baseline has no volume read");
  inputs.read.volume.read.relative = relative;
};

interface Case {
  name: string;
  change: (inputs: Inputs) => void;
  status: TradeStatus;
  branch: Branch;
}

const CASES: Case[] = [
  { name: "baseline", change: () => {}, status: "POTENTIAL_SETUP", branch: "PASSED" },

  // --- AVOID ---
  {
    name: "higher timeframe: counter-trend bounce",
    change: (i) => (i.mtf = mtfOf(pullbackIntoSupport(), downtrend())),
    status: "AVOID",
    branch: "HTF_COUNTER_TREND",
  },
  {
    name: "higher timeframe: both bearish",
    change: (i) => (i.mtf = mtfOf(downtrend(), downtrend())),
    status: "AVOID",
    branch: "HTF_BEARISH",
  },
  {
    name: "higher timeframe: both bearish, no conflict note",
    change: (i) => (i.mtf = { ...mtfOf(downtrend(), downtrend()), conflictNote: null }),
    status: "AVOID",
    branch: "HTF_BEARISH",
  },
  {
    name: "entry timeframe bearish",
    change: (i) => (i.read.trend.trend = "BEARISH"),
    status: "AVOID",
    branch: "ENTRY_TF_BEARISH",
  },
  {
    name: "risk/reward 0.999999",
    change: (i) => setRatio(i, 0.999999),
    status: "AVOID",
    branch: "RR_BELOW_ONE",
  },
  {
    name: "score 44",
    change: (i) => setScore(i, 44),
    status: "AVOID",
    branch: "SCORE_AVOID_GRADE",
  },

  // --- HIGH_RISK ---
  {
    name: "risk/reward exactly 1",
    change: (i) => setRatio(i, 1),
    status: "HIGH_RISK",
    branch: "RR_BELOW_MINIMUM",
  },
  {
    name: "risk/reward 1.4999",
    change: (i) => setRatio(i, 1.4999),
    status: "HIGH_RISK",
    branch: "RR_BELOW_MINIMUM",
  },
  {
    name: "59 candles of history",
    change: (i) => {
      i.read.insufficientData = true;
      i.read.candleCount = 59;
    },
    status: "HIGH_RISK",
    branch: "INSUFFICIENT_HISTORY",
  },
  {
    name: "nearest resistance starts exactly at the price",
    change: (i) => resistanceFrom(i, i.read.price),
    status: "HIGH_RISK",
    branch: "PRICE_IN_RESISTANCE",
  },
  {
    name: "nearest resistance starts 1% below the price",
    change: (i) => resistanceFrom(i, i.read.price * 0.99),
    status: "HIGH_RISK",
    branch: "PRICE_IN_RESISTANCE",
  },

  // --- WAIT ---
  {
    name: "2.5000001 ATR above the zone",
    change: (i) => outsideZone(i, 2.5000001),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "PRICE_EXTENDED",
  },
  {
    name: "exactly 2.5 ATR above the zone",
    change: (i) => outsideZone(i, 2.5),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "PRICE_NOT_IN_ZONE",
  },
  {
    name: "entry timeframe sideways",
    change: (i) => (i.read.trend.trend = "SIDEWAYS"),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "ENTRY_TF_SIDEWAYS",
  },
  {
    name: "0.4 ATR above the zone",
    change: (i) => outsideZone(i, 0.4),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "PRICE_NOT_IN_ZONE",
  },
  {
    name: "reward measured to an R-multiple",
    change: (i) => (i.riskReward.isSynthetic = true),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "REWARD_NOT_STRUCTURAL",
  },
  {
    name: "higher timeframe without direction",
    change: (i) => (i.mtf = mtfOf(pullbackIntoSupport(), rangeBound())),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "HTF_MIXED",
  },
  {
    name: "volume 0.69x average",
    change: (i) => setVolume(i, 0.69),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "VOLUME_THIN",
  },
  {
    name: "score 59",
    change: (i) => setScore(i, 59),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "SCORE_WEAK",
  },
  {
    name: "score 45",
    change: (i) => setScore(i, 45),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "SCORE_WEAK",
  },
  {
    name: "confirmation not present",
    change: (i) => (i.confirmation = NOT_PRESENT),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "CONFIRMATION_NOT_PRESENT",
  },
  {
    name: "confirmation contradicted",
    change: (i) => (i.confirmation = CONTRADICTED),
    status: "WAIT_FOR_CONFIRMATION",
    branch: "CONFIRMATION_CONTRADICTED",
  },

  // --- boundaries that pass ---
  {
    name: "risk/reward exactly 1.5",
    change: (i) => setRatio(i, 1.5),
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },
  {
    name: "nearest resistance starts just above the price",
    change: (i) => resistanceFrom(i, i.read.price * (1 + 1e-9)),
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },
  {
    name: "no resistance at all",
    change: (i) => (i.read.resistance = []),
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },
  {
    name: "volume exactly 0.7x average",
    change: (i) => setVolume(i, 0.7),
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },
  {
    name: "volume unavailable",
    change: (i) => (i.read.volume.read = null),
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },
  {
    name: "score 60",
    change: (i) => setScore(i, 60),
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },
  {
    name: "confirmation not supplied",
    change: (i) => delete i.confirmation,
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },
  {
    name: "higher timeframe aligned bullish",
    change: (i) => (i.mtf = mtfOf(pullbackIntoSupport(), pullbackIntoSupport())),
    status: "POTENTIAL_SETUP",
    branch: "PASSED",
  },

  // --- two failing inputs: the earlier rule must answer ---
  {
    name: "order: bearish entry trend and a counter-trend higher timeframe",
    change: (i) => {
      i.read.trend.trend = "BEARISH";
      i.mtf = mtfOf(pullbackIntoSupport(), downtrend());
    },
    status: "AVOID",
    branch: "HTF_COUNTER_TREND",
  },
  {
    name: "order: risk/reward below 1 and a score of 44",
    change: (i) => {
      setRatio(i, 0.8);
      setScore(i, 44);
    },
    status: "AVOID",
    branch: "RR_BELOW_ONE",
  },
  {
    name: "order: score of 44 and poor risk/reward",
    change: (i) => {
      setScore(i, 44);
      setRatio(i, 1.2);
    },
    status: "AVOID",
    branch: "SCORE_AVOID_GRADE",
  },
  {
    name: "order: poor risk/reward and inside resistance",
    change: (i) => {
      setRatio(i, 1.2);
      resistanceFrom(i, i.read.price);
    },
    status: "HIGH_RISK",
    branch: "RR_BELOW_MINIMUM",
  },
  {
    name: "order: thin history and inside resistance",
    change: (i) => {
      i.read.insufficientData = true;
      i.read.candleCount = 59;
      resistanceFrom(i, i.read.price);
    },
    status: "HIGH_RISK",
    branch: "INSUFFICIENT_HISTORY",
  },
  {
    name: "order: inside resistance and extended",
    change: (i) => {
      resistanceFrom(i, i.read.price);
      outsideZone(i, 3);
    },
    status: "HIGH_RISK",
    branch: "PRICE_IN_RESISTANCE",
  },
  {
    name: "order: extended and sideways",
    change: (i) => {
      outsideZone(i, 3);
      i.read.trend.trend = "SIDEWAYS";
    },
    status: "WAIT_FOR_CONFIRMATION",
    branch: "PRICE_EXTENDED",
  },
  {
    name: "order: sideways and outside the zone",
    change: (i) => {
      i.read.trend.trend = "SIDEWAYS";
      outsideZone(i, 0.4);
    },
    status: "WAIT_FOR_CONFIRMATION",
    branch: "ENTRY_TF_SIDEWAYS",
  },
  {
    name: "order: outside the zone and an unmeasured reward",
    change: (i) => {
      outsideZone(i, 0.4);
      i.riskReward.isSynthetic = true;
    },
    status: "WAIT_FOR_CONFIRMATION",
    branch: "PRICE_NOT_IN_ZONE",
  },
  {
    name: "order: unmeasured reward and no higher-timeframe direction",
    change: (i) => {
      i.riskReward.isSynthetic = true;
      i.mtf = mtfOf(pullbackIntoSupport(), rangeBound());
    },
    status: "WAIT_FOR_CONFIRMATION",
    branch: "REWARD_NOT_STRUCTURAL",
  },
  {
    name: "order: no higher-timeframe direction and thin volume",
    change: (i) => {
      i.mtf = mtfOf(pullbackIntoSupport(), rangeBound());
      setVolume(i, 0.5);
    },
    status: "WAIT_FOR_CONFIRMATION",
    branch: "HTF_MIXED",
  },
  {
    name: "order: thin volume and a weak score",
    change: (i) => {
      setVolume(i, 0.5);
      setScore(i, 50);
    },
    status: "WAIT_FOR_CONFIRMATION",
    branch: "VOLUME_THIN",
  },
  {
    name: "order: weak score and contradicted confirmation",
    change: (i) => {
      setScore(i, 50);
      i.confirmation = CONTRADICTED;
    },
    status: "WAIT_FOR_CONFIRMATION",
    branch: "SCORE_WEAK",
  },
];

function run(c: Case) {
  const inputs = baseline();
  c.change(inputs);
  const verdict = decide(inputs);
  const branch = classifyVerdict(verdict.status, verdict.reason, {
    mtf: inputs.mtf,
    confirmation: inputs.confirmation,
  });
  return { verdict, branch };
}

describe("golden master: determineStatus, rule by rule", () => {
  it("starts from a baseline that passes every rule", () => {
    expect(decide(baseline()).status).toBe("POTENTIAL_SETUP");
  });

  it("uses real confirmation results of each kind", () => {
    expect(NOT_PRESENT.status).toBe("NOT_PRESENT");
    expect(CONTRADICTED.status).toBe("CONTRADICTED");
  });

  it.each(CASES.map((c): [string, Case] => [c.name, c]))("%s", (_name, c) => {
    const { verdict, branch } = run(c);
    expect(verdict.status).toBe(c.status);
    expect(branch).toBe(c.branch);
  });

  it("reaches every rule determineStatus has, judged by what it actually returned", () => {
    // From the verdicts, not from the expectations in the table: a case whose
    // expectation is wrong must not count towards coverage.
    const reached = new Set(CASES.map((c) => run(c).branch));
    expect(reached.has("UNCLASSIFIED")).toBe(false);
    const rules: Branch[] = [
      "HTF_COUNTER_TREND",
      "HTF_BEARISH",
      "ENTRY_TF_BEARISH",
      "RR_BELOW_ONE",
      "SCORE_AVOID_GRADE",
      "RR_BELOW_MINIMUM",
      "INSUFFICIENT_HISTORY",
      "PRICE_IN_RESISTANCE",
      "PRICE_EXTENDED",
      "ENTRY_TF_SIDEWAYS",
      "PRICE_NOT_IN_ZONE",
      "REWARD_NOT_STRUCTURAL",
      "HTF_MIXED",
      "VOLUME_THIN",
      "SCORE_WEAK",
      "CONFIRMATION_CONTRADICTED",
      "CONFIRMATION_NOT_PRESENT",
      "PASSED",
    ];
    expect(rules.filter((rule) => !reached.has(rule))).toEqual([]);
  });

  it("pins every verdict and its reason", async () => {
    const lines = CASES.map((c) => {
      const { verdict, branch } = run(c);
      return line(c.name, { status: verdict.status, branch, reason: verdict.reason });
    });
    await expect(
      goldenFile("determineStatus, one input at a time: status, branch, reason", lines),
    ).toMatchFileSnapshot("./__golden__/status.rules.golden.txt");
  });
});
