import { describe, expect, it } from "vitest";

import { runMarketRead, STOP_BUFFER_ATR } from "@/lib/analysis";

import { namedCases, runCases, sweepCases, type GoldenRun } from "./corpus";
import { nearZeroRange } from "./fixtures";
import {
  BRANCHES,
  branchOf,
  decisionOf,
  explanationsOf,
  goldenFile,
  line,
  wordingOf,
  type Branch,
} from "./project";

/**
 * Golden master for `runAnalysis` (Phase 5, commit 0).
 *
 * Records what the engine decides today, across every hand-picked case and
 * every candle-window prefix of three scenarios, so the diagnostics release can
 * prove it changed nothing. The golden files are written by the first run and
 * compared on every run after it.
 *
 * Production code is not touched by this commit. A failure here before any
 * production change means a test or fixture was written wrong — fix the test,
 * never the engine.
 */

const SLOW = 60_000;

let cached: { named: GoldenRun[]; sweep: GoldenRun[] } | null = null;

function corpus() {
  cached ??= { named: runCases(namedCases()), sweep: runCases(sweepCases()) };
  return cached;
}

function all(): GoldenRun[] {
  const { named, sweep } = corpus();
  return [...named, ...sweep];
}

/**
 * Branches consistent with what the existing suite asserts.
 *
 * The existing tests assert a status plus a pattern in the reason, not a rule
 * by name. Where the comment says "implied", the pattern alone would also match
 * another rule's reason, and the branch named here follows from that pattern
 * together with the rule order — derived, not independently pinned.
 */
const CONSISTENT_WITH_EXISTING_TESTS: Record<string, Branch> = {
  // setup.test.ts: AVOID, no setup. Only one exit applies to an empty series.
  empty: "NO_DATA",
  // setup.test.ts: POTENTIAL_SETUP, in zone, R ≥ 1.5.
  pullbackIntoSupport: "PASSED",
  // setup.test.ts: WAIT and /volume/. Implied: the confirmation reason can also
  // mention volume, but relative volume here is below 0.7, a rule that comes first.
  pullbackOnThinVolume: "VOLUME_THIN",
  // setup.test.ts: AVOID, /bearish/, no setup and no score.
  downtrend: "ENTRY_TF_BEARISH",
  // setup.test.ts: WAIT, /chasing|pullback/, not in zone. Implied by the
  // pattern plus the zone flag; only the extended rule says "chasing".
  extendedAboveSupport: "PRICE_EXTENDED",
  // setup.test.ts: WAIT, /ranging/, trend SIDEWAYS.
  rangeBound: "ENTRY_TF_SIDEWAYS",
  // setup.test.ts: HIGH_RISK, /candles|history/.
  thinHistory: "INSUFFICIENT_HISTORY",
  // setup.test.ts: AVOID, /risks more than it stands to make/, levels withheld.
  poorRiskReward: "RR_BELOW_ONE",
  // setup.test.ts: AVOID, grade AVOID, /too little of the evidence/.
  weakEvidence: "SCORE_AVOID_GRADE",
  // mtf.test.ts: AVOID, /bearish/, no setup; explanations/build.test.ts: titled
  // "Counter-trend bounce".
  "pullbackIntoSupport|H4:downtrend": "HTF_COUNTER_TREND",
};

/**
 * Branches derived by reading the source, not yet pinned anywhere else.
 *
 * Each follows from an existing assertion plus the rule order — for example, a
 * higher timeframe that classifies as PULLBACK_IN_UPTREND (pinned in
 * mtf.test.ts) always means a bearish entry timeframe, which `runAnalysis`
 * refuses before anything else. If one of these fails on the first run, the
 * derivation was wrong; correct the expectation, not the engine.
 */
const DERIVED_FROM_SOURCE: Record<string, Branch> = {
  "single-candle": "NO_ENTRY_ZONE",
  "flat-80": "NO_ENTRY_ZONE",
  "near-zero-range": "NO_STOP",
  "pullbackIntoSupport|H4:pullbackIntoSupport": "PASSED",
  "pullbackIntoSupport|H4:rangeBound": "HTF_MIXED",
  "downtrend|H4:downtrend": "HTF_BEARISH",
  "downtrend|H4:pullbackIntoSupport": "PULLBACK_IN_UPTREND_VETO",
  "pullbackOnThinVolume|H4:pullbackIntoSupport": "VOLUME_THIN",
  "pullbackIntoSupport|H4:constructed-aligned-bearish-without-note": "HTF_BEARISH",
  "pullbackIntoSupport|stale-entry": "HELD_INCOMPLETE_DATA",
  "pullbackIntoSupport|htf-not-checked": "HELD_INCOMPLETE_DATA",
  "pullbackIntoSupport|htf-unavailable": "HELD_INCOMPLETE_DATA",
  "pullbackIntoSupport|htf-insufficient": "HELD_INCOMPLETE_DATA",
  "pullbackIntoSupport|htf-invalid": "HELD_INCOMPLETE_DATA",
  "pullbackIntoSupport|htf-served-stale": "HELD_INCOMPLETE_DATA",
  "pullbackIntoSupport|htf-head-missing": "HELD_INCOMPLETE_DATA",
  "downtrend|stale-entry": "ENTRY_TF_BEARISH",
  "pullbackOnThinVolume|stale-entry": "VOLUME_THIN",
};

/**
 * Branches the zone-retest fixture reaches, per the hand derivation in
 * `fixtures.ts`. Asserted in detail in `zones.golden.test.ts`.
 */
const FROM_ZONE_FIXTURES: Branch[] = [
  "PRICE_IN_RESISTANCE",
  "CONFIRMATION_CONTRADICTED",
  "CONFIRMATION_NOT_PRESENT",
  "PRICE_NOT_IN_ZONE",
];

/**
 * Branches this file does not require a real candle series to reach.
 *
 * Not a claim that they are unreachable. No case in this corpus is *known* to
 * reach the first three; the sweeps may, and `engine.branches.golden.txt`
 * records whether they do — it does not assert it. All three are asserted by
 * direct inputs, against what `determineStatus` actually returns, in
 * `status.golden.test.ts`.
 *
 * The last two look unreachable with valid candles, by reading
 * `calculateTakeProfits`: it always returns at least one target and builds its
 * ladder in ascending order above the entry. That is derived from the source,
 * not proven. Both are asserted in `defensive-exits.golden.test.ts` by
 * substituting the ladder.
 */
const ASSERTED_ELSEWHERE: Branch[] = [
  "RR_BELOW_MINIMUM",
  "REWARD_NOT_STRUCTURAL",
  "SCORE_WEAK",
  "INVALID_LEVELS",
  "NO_MEASURABLE_REWARD",
];

/** Every branch this file requires the corpus to reach end to end. */
function requiredEndToEnd(): Set<Branch> {
  return new Set<Branch>([
    ...Object.values(CONSISTENT_WITH_EXISTING_TESTS),
    ...Object.values(DERIVED_FROM_SOURCE),
    ...FROM_ZONE_FIXTURES,
  ]);
}

function byId(id: string): GoldenRun {
  const found = corpus().named.find((run) => run.id === id);
  if (!found) throw new Error(`No golden case named ${id}`);
  return found;
}

describe("golden master: runAnalysis", () => {
  it(
    "gives every case a unique id",
    () => {
      const ids = all().map((run) => run.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
    SLOW,
  );

  it(
    "is deterministic, so the golden files cannot be flaky",
    () => {
      const again = [...runCases(namedCases()), ...runCases(sweepCases())];
      const first = all().map((run) => JSON.stringify(decisionOf(run.result)));
      const second = again.map((run) => JSON.stringify(decisionOf(run.result)));
      expect(second).toEqual(first);
    },
    SLOW,
  );

  it(
    "recognises the rule behind every verdict",
    () => {
      const unrecognised = all()
        .filter((run) => branchOf(run.result) === "UNCLASSIFIED")
        .map((run) => `${run.id}: ${run.result.status} — ${run.result.statusReason}`);
      expect(unrecognised).toEqual([]);
    },
    SLOW,
  );

  it.each(Object.entries(CONSISTENT_WITH_EXISTING_TESTS))(
    "is consistent with what the existing suite asserts for %s",
    (id, branch) => {
      expect(branchOf(byId(id).result)).toBe(branch);
    },
    SLOW,
  );

  it.each(Object.entries(DERIVED_FROM_SOURCE))(
    "reaches the derived branch for %s",
    (id, branch) => {
      expect(branchOf(byId(id).result)).toBe(branch);
    },
    SLOW,
  );

  it(
    "reaches every branch it requires end to end, judged by what runAnalysis returned",
    () => {
      const seen = new Set(all().map((run) => branchOf(run.result)));
      const missing = [...requiredEndToEnd()].filter((branch) => !seen.has(branch));
      expect(missing).toEqual([]);
    },
    SLOW,
  );

  it("accounts for every branch exactly once: required here, or asserted elsewhere", () => {
    const required = requiredEndToEnd();
    const elsewhere = new Set(ASSERTED_ELSEWHERE);

    const both = BRANCHES.filter((branch) => required.has(branch) && elsewhere.has(branch));
    const neither = BRANCHES.filter(
      (branch) => branch !== "UNCLASSIFIED" && !required.has(branch) && !elsewhere.has(branch),
    );

    expect(both).toEqual([]);
    expect(neither).toEqual([]);
  });
});

describe("the nearZeroRange fixture holds the geometry its expectation depends on", () => {
  it("ranges between 1 and 21, with a support zone that reaches below zero", () => {
    const read = runMarketRead(nearZeroRange());
    const support = read.support[0];
    const atr = read.indicators.atr14;

    // Equal highs and equal lows: a range, not a downtrend, so the bearish rule
    // cannot answer first.
    expect(read.trend.structure.structure).toBe("RANGING");
    expect(read.trend.structure.labels).toEqual({ high: "EH", low: "EL" });
    expect(read.trend.trend).toBe("SIDEWAYS");

    // A support zone around the swing lows at 1, below the close at 11, so an
    // entry zone exists.
    expect(support).toBeDefined();
    expect(support.mid).toBe(1);
    expect(support.mid).toBeLessThan(read.price);
    expect(read.price).toBe(11);

    // The stop goes half an ATR below the lower of the zone floor and the last
    // swing low beneath the entry (1). Here that is at or below zero, which is
    // the condition under which no stop can be placed.
    expect(atr).not.toBeNull();
    expect(atr!).toBeGreaterThan(0);
    expect(support.low).toBeLessThan(0);
    expect(Math.min(support.low, 1) - STOP_BUFFER_ATR * atr!).toBeLessThanOrEqual(0);
  });
});

describe("golden files: runAnalysis", () => {
  it(
    "pins every decision",
    async () => {
      const lines = all().map((run) => line(run.id, decisionOf(run.result)));
      await expect(
        goldenFile("runAnalysis decisions: status, levels, R, score, confirmation", lines),
      ).toMatchFileSnapshot("./__golden__/engine.decisions.golden.txt");
    },
    SLOW,
  );

  it(
    "pins the wording",
    async () => {
      const { named, sweep } = corpus();
      const lines = [
        ...named.map((run) => line(run.id, wordingOf(run.result, true))),
        ...sweep.map((run) => line(run.id, wordingOf(run.result, false))),
      ];
      await expect(
        goldenFile("runAnalysis wording: reasons and confirmation explanations", lines),
      ).toMatchFileSnapshot("./__golden__/engine.wording.golden.txt");
    },
    SLOW,
  );

  it(
    "pins the structured explanation lists",
    async () => {
      const lines = corpus().named.map((run) => line(run.id, explanationsOf(run.result)));
      await expect(
        goldenFile("buildExplanations: id | signal | title, named cases", lines),
      ).toMatchFileSnapshot("./__golden__/engine.explanations.golden.txt");
    },
    SLOW,
  );

  it(
    "pins which rule decided each case, and the coverage that adds up to",
    async () => {
      const runs = all();
      const counts = new Map<Branch, number>();
      for (const run of runs) {
        const branch = branchOf(run.result);
        counts.set(branch, (counts.get(branch) ?? 0) + 1);
      }
      const summary = [...counts.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([branch, count]) => `# ${branch}: ${count}`);

      const lines = [
        ...runs.map((run) => `${run.id}\t${run.result.status}\t${branchOf(run.result)}`),
        "# --- coverage over the whole corpus ---",
        ...summary,
      ];
      await expect(
        goldenFile("Deciding rule per case (classified from the result)", lines),
      ).toMatchFileSnapshot("./__golden__/engine.branches.golden.txt");
    },
    SLOW,
  );
});
