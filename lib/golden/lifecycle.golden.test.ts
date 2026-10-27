import { describe, expect, it } from "vitest";

import type { AnalysisResult } from "@/lib/analysis";
import {
  lifecycleStatusFor,
  originOf,
  reconcileSetup,
  untrackedReasonOf,
  type ExistingSetup,
  type SetupLifecycleStatus,
  type SetupPlan,
} from "@/lib/setups";

import { namedCases, runCases, type GoldenRun } from "./corpus";
import { goldenFile, line, planDecisionOf, planWordingOf } from "./project";

/**
 * Golden master for setup lifecycle reconciliation (Phase 5, commit 0).
 *
 * For every named analysis in the corpus, the plan `reconcileSetup` makes
 * against each kind of stored setup a real database can hold: none; one on the
 * same level in each lifecycle state; one that confirmed earlier and has since
 * fallen back; one whose zone has drifted since it was stored but still
 * overlaps; and one on a different level. The diagnostics release must not
 * change a single plan — what it creates, moves, invalidates or replaces, and
 * what it freezes into the snapshot.
 *
 * Incomplete analyses are included even though no caller tracks them today:
 * this pins the planner itself, not the callers' decision not to call it.
 */

const STATES: SetupLifecycleStatus[] = [
  "SETUP_FORMING",
  "WAITING_CONFIRMATION",
  "CONFIRMATION_DETECTED",
  "POTENTIAL_SETUP",
  "INVALIDATED",
];

/**
 * Whether a stored setup in this state has `confirmedAt` set. The service
 * stamps it on reaching CONFIRMATION_DETECTED or POTENTIAL_SETUP, so a row in
 * either state always has it.
 */
const CONFIRMED_STATES: SetupLifecycleStatus[] = ["CONFIRMATION_DETECTED", "POTENTIAL_SETUP"];

interface Scenario {
  name: string;
  existing: ExistingSetup | null;
}

function scenariosFor(result: AnalysisResult): Scenario[] {
  // With no setup there is no origin. A stored zone just below the price then
  // stands in for the level this market was being tracked on; the planner
  // invalidates whatever is stored either way, so its exact bounds do not
  // matter beyond being a plausible zone.
  const price = result.read.price;
  const same =
    originOf(result) ??
    (price > 0 ? { zoneLow: price * 0.95, zoneHigh: price * 0.97 } : { zoneLow: 1, zoneHigh: 2 });
  const width = same.zoneHigh - same.zoneLow;

  // Zones are ATR-scaled and move a little every candle, so a real stored zone
  // is rarely the current zone exactly. Shifted by 40% of its width it still
  // overlaps, which is what identity means.
  const drifted = { zoneLow: same.zoneLow + 0.4 * width, zoneHigh: same.zoneHigh + 0.4 * width };

  // A level wholly above the current one: the engine has re-anchored lower
  // since this setup was stored.
  const elsewhere = { zoneLow: same.zoneHigh + width, zoneHigh: same.zoneHigh + 2 * width };

  const stored = (
    status: SetupLifecycleStatus,
    origin = same,
    hasConfirmedAt = CONFIRMED_STATES.includes(status),
  ): ExistingSetup => ({ id: "golden-setup", status, origin, hasConfirmedAt });

  return [
    { name: "none", existing: null },
    ...STATES.map((status) => ({ name: `same:${status}`, existing: stored(status) })),
    {
      // Confirmed once, then the evidence lapsed: `confirmedAt` stays set.
      name: "same:WAITING_CONFIRMATION:confirmed-before",
      existing: stored("WAITING_CONFIRMATION", same, true),
    },
    {
      name: "drifted:WAITING_CONFIRMATION",
      existing: stored("WAITING_CONFIRMATION", drifted),
    },
    {
      name: "elsewhere:WAITING_CONFIRMATION",
      existing: stored("WAITING_CONFIRMATION", elsewhere),
    },
  ];
}

interface Planned {
  id: string;
  run: GoldenRun;
  plan: SetupPlan;
}

function planAll(runs: GoldenRun[]): Planned[] {
  return runs.flatMap((run) =>
    scenariosFor(run.result).map((scenario) => ({
      id: `${run.id} ~ ${scenario.name}`,
      run,
      plan: reconcileSetup({ existing: scenario.existing, result: run.result }),
    })),
  );
}

let cached: Planned[] | null = null;
const planned = () => (cached ??= planAll(runCases(namedCases())));

/** The plans grouped by the analysis they were made for. */
function byCase(): Map<string, Planned[]> {
  const groups = new Map<string, Planned[]>();
  for (const p of planned()) groups.set(p.run.id, [...(groups.get(p.run.id) ?? []), p]);
  return groups;
}

/** One scenario's plan, as the decision projection the golden file records. */
function decisionFor(plans: Planned[], scenario: string): string {
  const found = plans.find((p) => p.id.endsWith(`~ ${scenario}`));
  if (!found) throw new Error(`No plan for scenario ${scenario}`);
  return JSON.stringify(planDecisionOf(found.plan));
}

describe("golden master: reconcileSetup", () => {
  it("is deterministic", () => {
    const again = planAll(runCases(namedCases()));
    expect(again.map((p) => JSON.stringify(planDecisionOf(p.plan)))).toEqual(
      planned().map((p) => JSON.stringify(planDecisionOf(p.plan))),
    );
  });

  it("treats a stored setup that is already invalidated exactly like no setup", () => {
    // INVALIDATED is terminal: the planner ignores such a row, so the plan must
    // be the one it makes with nothing stored.
    for (const plans of byCase().values()) {
      expect(decisionFor(plans, "same:INVALIDATED")).toBe(decisionFor(plans, "none"));
    }
  });

  it("keeps one identity when the stored zone has drifted but still overlaps", () => {
    // Identity is overlap, not equality: a zone that moved a little since it was
    // stored is the same level, so the plan matches the exact-zone one.
    for (const [id, plans] of byCase()) {
      if (originOf(plans[0].run.result) === null) continue;
      expect(decisionFor(plans, "drifted:WAITING_CONFIRMATION"), id).toBe(
        decisionFor(plans, "same:WAITING_CONFIRMATION"),
      );
    }
  });

  it("never keeps a stored setup that sits on a different level", () => {
    // Either the engine anchored elsewhere (replace), or it has nothing to
    // anchor to or the premise is contradicted (invalidate).
    for (const [id, plans] of byCase()) {
      const plan = plans.find((p) => p.id.endsWith("~ elsewhere:WAITING_CONFIRMATION"))!.plan;
      const invalidates = plan.action === "TRANSITION" && plan.transition.to === "INVALIDATED";
      expect(plan.action === "REPLACE" || invalidates, id).toBe(true);
    }
  });

  it("pins every plan", async () => {
    const lines = planned().map((p) => {
      const untracked =
        p.plan.action === "NONE"
          ? untrackedReasonOf({ setupId: null, cause: p.plan.cause }, p.run.result)
          : null;
      return line(p.id, {
        lifecycle: lifecycleStatusFor(p.run.result),
        plan: planDecisionOf(p.plan),
        untracked,
      });
    });
    await expect(
      goldenFile("reconcileSetup plans: action, states, snapshot, payload", lines),
    ).toMatchFileSnapshot("./__golden__/lifecycle.plans.golden.txt");
  });

  it("pins the prose each plan would write", async () => {
    const lines = planned().map((p) => line(p.id, planWordingOf(p.plan)));
    await expect(
      goldenFile("reconcileSetup wording: event details and invalidation reasons", lines),
    ).toMatchFileSnapshot("./__golden__/lifecycle.wording.golden.txt");
  });
});
