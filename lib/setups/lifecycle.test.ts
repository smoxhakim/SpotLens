import { describe, expect, it } from "vitest";

import { runAnalysis, type AnalysisResult } from "@/lib/analysis";
import { downtrend, extendedAboveSupport, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import {
  isSameOrigin,
  lifecycleStatusFor,
  originOf,
  reconcileSetup,
  snapshotOf,
} from "./lifecycle";
import type { ExistingSetup, SetupLifecycleStatus, SetupPlan } from "./types";

/**
 * The lifecycle is a pure function of (what is stored, what the engine just
 * said). These tests are the whole of its behaviour — the service does nothing
 * but execute the plan they describe.
 */

/** A result with the lifecycle-relevant parts overridden. */
function resultWith(overrides: {
  status?: AnalysisResult["status"];
  confirmation?: "PRESENT" | "NOT_PRESENT" | "CONTRADICTED" | null;
  priceInZone?: boolean;
  invalidationReason?: string;
  base?: AnalysisResult;
}): AnalysisResult {
  const base = overrides.base ?? runAnalysis(pullbackIntoSupport());

  return {
    ...base,
    status: overrides.status ?? base.status,
    setup: base.setup
      ? {
          ...base.setup,
          entry: {
            ...base.setup.entry,
            priceInZone: overrides.priceInZone ?? base.setup.entry.priceInZone,
          },
        }
      : null,
    confirmation:
      overrides.confirmation === null
        ? null
        : overrides.confirmation
          ? {
              ...base.confirmation!,
              status: overrides.confirmation,
              invalidationReason: overrides.invalidationReason ?? null,
            }
          : base.confirmation,
  };
}

function existing(
  status: SetupLifecycleStatus,
  zone = { zoneLow: 0, zoneHigh: 1e9 },
): ExistingSetup {
  return { id: "setup-1", status, origin: zone, hasConfirmedAt: false };
}

describe("where the analysis puts a setup in its lifecycle", () => {
  it("is POTENTIAL_SETUP when the engine returns one", () => {
    const result = runAnalysis(pullbackIntoSupport());
    expect(result.status).toBe("POTENTIAL_SETUP");
    expect(lifecycleStatusFor(result)).toBe("POTENTIAL_SETUP");
  });

  it("is CONFIRMATION_DETECTED when confirmation is present but a rule still holds it", () => {
    const held = resultWith({ status: "HIGH_RISK", confirmation: "PRESENT" });
    expect(lifecycleStatusFor(held)).toBe("CONFIRMATION_DETECTED");
  });

  it("is WAITING_CONFIRMATION when price is at the level and nothing has happened", () => {
    const waiting = resultWith({
      status: "WAIT_FOR_CONFIRMATION",
      confirmation: "NOT_PRESENT",
      priceInZone: true,
    });
    expect(lifecycleStatusFor(waiting)).toBe("WAITING_CONFIRMATION");
  });

  it("is SETUP_FORMING while price has not reached the entry zone", () => {
    const forming = resultWith({
      status: "WAIT_FOR_CONFIRMATION",
      confirmation: "NOT_PRESENT",
      priceInZone: false,
    });
    expect(lifecycleStatusFor(forming)).toBe("SETUP_FORMING");
  });

  it("is INVALIDATED when confirmation is contradicted", () => {
    const contradicted = resultWith({ confirmation: "CONTRADICTED" });
    expect(lifecycleStatusFor(contradicted)).toBe("INVALIDATED");
  });

  it("is nothing at all when the engine refused to build a setup", () => {
    const avoided = runAnalysis(downtrend());
    expect(avoided.setup).toBeNull();
    expect(lifecycleStatusFor(avoided)).toBeNull();
  });
});

describe("setup identity", () => {
  it("treats overlapping zones as the same level", () => {
    // Zones are ATR-scaled and drift each candle; identity must survive that.
    expect(isSameOrigin({ zoneLow: 100, zoneHigh: 104 }, { zoneLow: 103, zoneHigh: 107 })).toBe(
      true,
    );
    expect(isSameOrigin({ zoneLow: 100, zoneHigh: 104 }, { zoneLow: 104, zoneHigh: 110 })).toBe(
      true,
    );
  });

  it("treats a disjoint zone as a different level", () => {
    expect(isSameOrigin({ zoneLow: 100, zoneHigh: 104 }, { zoneLow: 105, zoneHigh: 110 })).toBe(
      false,
    );
  });

  it("reads the origin from the zone the entry is anchored to", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const origin = originOf(result)!;
    const zone = result.setup!.entry.sourceZone;

    expect(origin).toEqual({ zoneLow: zone.low, zoneHigh: zone.high });
  });
});

describe("deduplication — the property the scanner depends on", () => {
  it("creates exactly one setup and then stops writing", () => {
    const result = runAnalysis(pullbackIntoSupport());

    const first = reconcileSetup({ existing: null, result });
    expect(first.action).toBe("CREATE");

    // What the store looks like after that create.
    const stored = existing(lifecycleStatusFor(result)!, originOf(result)!);

    // Ten more identical runs.
    for (let i = 0; i < 10; i += 1) {
      const plan = reconcileSetup({ existing: stored, result });
      expect(plan.action).toBe("NONE");
    }
  });

  it("writes nothing while a setup sits unconfirmed run after run", () => {
    const waiting = resultWith({
      status: "WAIT_FOR_CONFIRMATION",
      confirmation: "NOT_PRESENT",
      priceInZone: true,
    });
    const stored = existing("WAITING_CONFIRMATION", originOf(waiting)!);

    for (let i = 0; i < 4; i += 1) {
      const plan = reconcileSetup({ existing: stored, result: waiting });
      expect(plan.action).toBe("NONE");
      expect((plan as { reason: string }).reason).toMatch(/nothing about the setup has changed/i);
    }
  });

  it("does not create a second setup when one is already open on the same level", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const stored = existing("SETUP_FORMING", originOf(result)!);

    const plan = reconcileSetup({ existing: stored, result });

    expect(plan.action).toBe("TRANSITION");
    expect((plan as Extract<SetupPlan, { action: "TRANSITION" }>).transition.setupId).toBe(
      "setup-1",
    );
  });
});

describe("transitions", () => {
  it("moves waiting to confirmation-detected exactly once", () => {
    const confirmed = resultWith({ status: "HIGH_RISK", confirmation: "PRESENT" });
    const stored = existing("WAITING_CONFIRMATION", originOf(confirmed)!);

    const plan = reconcileSetup({ existing: stored, result: confirmed });
    expect(plan.action).toBe("TRANSITION");

    const { transition } = plan as Extract<SetupPlan, { action: "TRANSITION" }>;
    expect(transition.from).toBe("WAITING_CONFIRMATION");
    expect(transition.to).toBe("CONFIRMATION_DETECTED");
    expect(transition.event.type).toBe("CONFIRMATION_DETECTED");
    expect(transition.marksConfirmed).toBe(true);

    // And the next identical run produces no second event.
    const after = existing("CONFIRMATION_DETECTED", originOf(confirmed)!);
    expect(reconcileSetup({ existing: after, result: confirmed }).action).toBe("NONE");
  });

  it("moves to POTENTIAL_SETUP when the engine's own gate allows it", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const stored = existing("CONFIRMATION_DETECTED", originOf(result)!);

    const { transition } = reconcileSetup({ existing: stored, result }) as Extract<
      SetupPlan,
      { action: "TRANSITION" }
    >;

    expect(transition.to).toBe("POTENTIAL_SETUP");
    expect(transition.event.type).toBe("POTENTIAL_SETUP");
  });

  it("records a regression when confirmation lapses", () => {
    // Confirmation is evidence about the last closed candle, so it can stop
    // being true. Leaving the setup stuck at CONFIRMATION_DETECTED would be a
    // record of something that is no longer the case.
    const lapsed = resultWith({
      status: "WAIT_FOR_CONFIRMATION",
      confirmation: "NOT_PRESENT",
      priceInZone: true,
    });
    const stored = existing("CONFIRMATION_DETECTED", originOf(lapsed)!);

    const { transition } = reconcileSetup({ existing: stored, result: lapsed }) as Extract<
      SetupPlan,
      { action: "TRANSITION" }
    >;

    expect(transition.to).toBe("WAITING_CONFIRMATION");
    expect(transition.event.detail).toMatch(/no longer holds/i);
    expect(transition.marksConfirmed).toBe(false);
  });

  it("never transitions out of an invalidated setup", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const dead = existing("INVALIDATED", originOf(result)!);

    // An invalidated row is treated as no row: the level coming back is a new
    // setup with its own id and its own history.
    const plan = reconcileSetup({ existing: dead, result });
    expect(plan.action).toBe("CREATE");
  });
});

describe("invalidation", () => {
  it("invalidates when confirmation is contradicted, carrying the reason", () => {
    const contradicted = resultWith({
      confirmation: "CONTRADICTED",
      invalidationReason: "Support has been lost at 100 – 104.",
    });
    const stored = existing("WAITING_CONFIRMATION", originOf(contradicted)!);

    const { transition } = reconcileSetup({ existing: stored, result: contradicted }) as Extract<
      SetupPlan,
      { action: "TRANSITION" }
    >;

    expect(transition.to).toBe("INVALIDATED");
    expect(transition.event.type).toBe("INVALIDATED");
    expect(transition.invalidationReason).toMatch(/support has been lost/i);
  });

  it("invalidates when the engine stops offering a setup at all", () => {
    const avoided = runAnalysis(downtrend());
    const stored = existing("WAITING_CONFIRMATION");

    const { transition } = reconcileSetup({ existing: stored, result: avoided }) as Extract<
      SetupPlan,
      { action: "TRANSITION" }
    >;

    expect(transition.to).toBe("INVALIDATED");
    expect(transition.invalidationReason).toBe(avoided.statusReason);
  });

  it("replaces the setup when the entry anchors to a different level", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const elsewhere = existing("WAITING_CONFIRMATION", { zoneLow: 1, zoneHigh: 2 });

    const plan = reconcileSetup({ existing: elsewhere, result });
    expect(plan.action).toBe("REPLACE");

    const replace = plan as Extract<SetupPlan, { action: "REPLACE" }>;
    expect(replace.invalidate.to).toBe("INVALIDATED");
    expect(replace.invalidate.invalidationReason).toMatch(/different support zone/i);
    expect(replace.create.origin).toEqual(originOf(result));
  });

  it("does not resurrect a setup on a new level that is already contradicted", () => {
    const contradicted = resultWith({ confirmation: "CONTRADICTED" });
    const elsewhere = existing("WAITING_CONFIRMATION", { zoneLow: 1, zoneHigh: 2 });

    const plan = reconcileSetup({ existing: elsewhere, result: contradicted });

    // The old one closes; nothing is created to immediately close again.
    expect(plan.action).toBe("TRANSITION");
    expect((plan as Extract<SetupPlan, { action: "TRANSITION" }>).transition.to).toBe(
      "INVALIDATED",
    );
  });

  it("does nothing when there is no setup and none is tracked", () => {
    const plan = reconcileSetup({ existing: null, result: runAnalysis(downtrend()) });
    expect(plan.action).toBe("NONE");
  });
});

describe("the immutable snapshot", () => {
  it("captures the values as they stood, not as they later become", () => {
    const original = runAnalysis(pullbackIntoSupport());
    const snapshot = snapshotOf(original);

    expect(snapshot.entryLow).toBe(original.setup!.entry.low);
    expect(snapshot.stopLoss).toBe(original.setup!.stopLoss.price);
    expect(snapshot.score).toBe(original.score!.total);
    expect(snapshot.riskReward).toBe(original.setup!.riskReward.ratio);

    // A later run with different numbers must not be able to reach back into
    // a snapshot already taken — it is a value, not a reference.
    const later = runAnalysis(extendedAboveSupport());
    expect(later.setup!.entry.low).not.toBe(snapshot.entryLow);
    expect(snapshot.entryLow).toBe(original.setup!.entry.low);
  });

  it("carries Phase A's synthetic-reward qualifier through to storage", () => {
    const unmeasured = snapshotOf(runAnalysis(extendedAboveSupport()));
    const measured = snapshotOf(runAnalysis(pullbackIntoSupport()));

    expect(unmeasured.riskRewardIsSynthetic).toBe(true);
    expect(measured.riskRewardIsSynthetic).toBe(false);
  });

  it("keeps the reasoning, so the record explains itself", () => {
    const snapshot = snapshotOf(runAnalysis(pullbackIntoSupport()));

    expect(snapshot.detail.entryReason.length).toBeGreaterThan(0);
    expect(snapshot.detail.stopLossReason.length).toBeGreaterThan(0);
    expect(snapshot.detail.takeProfits.length).toBeGreaterThan(0);
    expect(Object.keys(snapshot.detail.scoreBreakdown)).toContain("riskReward");
  });
});

describe("confirmation history", () => {
  it("freezes the confirmation signals onto the transition event", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const stored = existing("WAITING_CONFIRMATION", originOf(result)!);

    const { transition } = reconcileSetup({ existing: stored, result }) as Extract<
      SetupPlan,
      { action: "TRANSITION" }
    >;

    const payload = transition.event.payload!;
    expect(payload.status).toBe("PRESENT");
    expect(payload.signals.length).toBeGreaterThan(0);
    expect(payload.evaluatedAt).toBe(result.confirmation!.evaluatedAt);
    expect(payload.explanation).toBe(result.confirmation!.explanation);
  });
});

describe("determinism", () => {
  it("produces an identical plan for identical input", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const stored = existing("WAITING_CONFIRMATION", originOf(result)!);

    const once = reconcileSetup({ existing: stored, result });
    const twice = reconcileSetup({ existing: stored, result });

    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("does no I/O and reads no clock", () => {
    // The plan carries flags, never timestamps: the service stamps the time.
    const result = runAnalysis(pullbackIntoSupport());
    const plan = reconcileSetup({ existing: null, result });
    const create = (plan as Extract<SetupPlan, { action: "CREATE" }>).create;

    expect(create).not.toHaveProperty("createdAt");
    expect(create.marksConfirmed).toBe(true);
  });
});
