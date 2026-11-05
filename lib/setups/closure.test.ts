import { describe, expect, it } from "vitest";

import { runAnalysis } from "@/lib/analysis";
import { downtrend, extendedAboveSupport } from "@/lib/test-utils/scenarios";

import { closureCauseOf, closureOf, supportLostReason } from "./closure";
import { originOf, reconcileSetup } from "./lifecycle";
import type { ExistingSetup, SetupOrigin, SetupPlan } from "./types";

/**
 * Why a moved anchor closed a setup. Recorded beside the decision, and never a
 * part of it: the cause and the reason change, and nothing the planner decides
 * does.
 */

const ZONE: SetupOrigin = { zoneLow: 100, zoneHigh: 102 };
const ANCHOR: SetupOrigin = { zoneLow: 90, zoneHigh: 92 };

const ORDINARY_REASON =
  "The entry no longer rests on this level — the engine has anchored to a different support zone, so this setup's premise is gone.";

describe("the cause, from the close against the stored zone", () => {
  it.each([
    ["well below the zone", 95, "SUPPORT_LOST"],
    ["a tick below the low", 99.99, "SUPPORT_LOST"],
    ["exactly on the low, which is not below it", 100, "LOWER_HALF"],
    ["in the lower half", 100.5, "LOWER_HALF"],
    ["exactly on the midpoint", 101, "LOWER_HALF"],
    ["just above the midpoint", 101.01, "SUPERSEDED"],
    ["exactly on the high", 102, "SUPERSEDED"],
    ["above the zone", 110, "SUPERSEDED"],
  ])("%s", (_name, close, cause) => {
    expect(closureOf(ZONE, close, ANCHOR).cause).toBe(cause);
  });

  it("keeps the prices it was judged from", () => {
    expect(closureOf(ZONE, 95, ANCHOR)).toEqual({
      cause: "SUPPORT_LOST",
      close: 95,
      originLow: 100,
      originHigh: 102,
      anchorLow: 90,
      anchorHigh: 92,
    });
  });
});

describe("the support-lost reason", () => {
  const closure = closureOf(ZONE, 95, ANCHOR);

  it("names the close, the zone and the lower zone a replacement anchors to", () => {
    expect(supportLostReason(closure, true)).toBe(
      "Price closed at 95.0000, below this setup's zone 100.0000 – 102.0000, so the setup was closed. " +
        "The engine now anchors to a lower zone: 90.0000 – 92.0000.",
    );
  });

  it("names no lower zone when nothing replaced the setup", () => {
    expect(supportLostReason(closure, false)).toBe(
      "Price closed at 95.0000, below this setup's zone 100.0000 – 102.0000, so the setup was closed.",
    );
  });
});

describe("reading the cause off a stored payload", () => {
  it.each(["SUPPORT_LOST", "LOWER_HALF", "SUPERSEDED"])("reads %s", (cause) => {
    expect(closureCauseOf({ status: "PRESENT", closure: { cause } })).toBe(cause);
  });

  it.each([
    ["a null payload, as the engine-offered-no-setup invalidation writes", null],
    ["a payload from before causes were recorded", { status: "PRESENT", signals: [] }],
    ["a closure that is not an object", { closure: "SUPPORT_LOST" }],
    ["a cause nothing writes", { closure: { cause: "SOMETHING_ELSE" } }],
    ["a cause that is not a string", { closure: { cause: 1 } }],
    ["something that is not an object", "SUPPORT_LOST"],
  ])("is null for %s", (_name, payload) => {
    expect(closureCauseOf(payload)).toBeNull();
  });
});

describe("the plan", () => {
  // Price well above its support, so a stored zone can sit between the two.
  const result = runAnalysis(extendedAboveSupport());
  const anchor = originOf(result)!;
  const price = result.read.price;
  const width = anchor.zoneHigh - anchor.zoneLow;

  const stored = (origin: SetupOrigin, status: ExistingSetup["status"] = "WAITING_CONFIRMATION") =>
    ({ id: "setup-1", status, origin, hasConfirmedAt: false }) satisfies ExistingSetup;

  /** Wholly above the close: the close is below this zone. */
  const closedBelow = { zoneLow: price + width, zoneHigh: price + 2 * width };
  /** The close sits in this zone's lower half, and it does not overlap the anchor. */
  const closedInLowerHalf = { zoneLow: price - width / 4, zoneHigh: price + width };
  /** Wholly below the anchor: the close is above this zone. */
  const closedAbove = { zoneLow: anchor.zoneLow - 3 * width, zoneHigh: anchor.zoneLow - 2 * width };

  const replacing = (origin: SetupOrigin) => {
    const plan = reconcileSetup({ existing: stored(origin), result });
    expect(plan.action).toBe("REPLACE");
    return plan as Extract<SetupPlan, { action: "REPLACE" }>;
  };

  it("records the cause on a replacement, with what it was judged from", () => {
    expect(replacing(closedBelow).invalidate.closure).toEqual({
      cause: "SUPPORT_LOST",
      close: price,
      originLow: closedBelow.zoneLow,
      originHigh: closedBelow.zoneHigh,
      anchorLow: anchor.zoneLow,
      anchorHigh: anchor.zoneHigh,
    });
    expect(replacing(closedInLowerHalf).invalidate.closure?.cause).toBe("LOWER_HALF");
    expect(replacing(closedAbove).invalidate.closure?.cause).toBe("SUPERSEDED");
  });

  it("gives a support loss its own reason, on the row and on the event", () => {
    const { invalidate } = replacing(closedBelow);

    expect(invalidate.invalidationReason).toMatch(/^Price closed at .*, below this setup's zone /);
    expect(invalidate.invalidationReason).toMatch(/The engine now anchors to a lower zone: /);
    expect(invalidate.event.detail).toBe(invalidate.invalidationReason);
  });

  it("leaves every other moved anchor's reason exactly as it was", () => {
    for (const origin of [closedInLowerHalf, closedAbove]) {
      const { invalidate } = replacing(origin);
      expect(invalidate.invalidationReason).toBe(ORDINARY_REASON);
      expect(invalidate.event.detail).toBe(ORDINARY_REASON);
    }
  });

  it("names no lower zone when the new level was contradicted, so nothing replaced it", () => {
    const contradicted = {
      ...result,
      confirmation: { ...result.confirmation!, status: "CONTRADICTED" as const },
    };

    const plan = reconcileSetup({ existing: stored(closedBelow), result: contradicted });

    expect(plan.action).toBe("TRANSITION");
    const { transition } = plan as Extract<SetupPlan, { action: "TRANSITION" }>;
    expect(transition.closure?.cause).toBe("SUPPORT_LOST");
    expect(transition.invalidationReason).toMatch(/so the setup was closed\.$/);
  });

  it("changes no decision: the same action and states whatever the cause", () => {
    const shape = (origin: SetupOrigin) => {
      const { invalidate, create } = replacing(origin);
      return {
        from: invalidate.from,
        to: invalidate.to,
        type: invalidate.event.type,
        marksConfirmed: invalidate.marksConfirmed,
        payload: invalidate.event.payload,
        created: create,
      };
    };

    expect(shape(closedBelow)).toEqual(shape(closedAbove));
    expect(shape(closedInLowerHalf)).toEqual(shape(closedAbove));
  });

  it("records no closure on anything but a moved anchor", () => {
    const sameLevel = reconcileSetup({ existing: stored(anchor), result });
    expect(sameLevel.action).toBe("TRANSITION");
    expect(sameLevel.action === "TRANSITION" && "closure" in sameLevel.transition).toBe(false);

    const noSetup = reconcileSetup({
      existing: stored(closedBelow),
      result: runAnalysis(downtrend()),
    });
    expect(noSetup.action).toBe("TRANSITION");
    expect(noSetup.action === "TRANSITION" && "closure" in noSetup.transition).toBe(false);
  });
});
