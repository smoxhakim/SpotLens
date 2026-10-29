import { describe, expect, it } from "vitest";

import { runAnalysis } from "@/lib/analysis";
import { extendedAboveSupport, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import { asRecorded } from "./review";

/**
 * The Coach reads a stored record, so it never says where price is "now".
 *
 * Built from the engine's real sentences rather than copies of them: if the
 * engine's wording changes, these fail instead of the rewrite silently
 * matching nothing.
 */
describe("asRecorded", () => {
  const inZone = runAnalysis(pullbackIntoSupport()).setup!.entry;
  const extended = runAnalysis(extendedAboveSupport()).setup!.entry;

  it("restates price inside the zone as what it was when analysed, figure untouched", () => {
    expect(inZone.priceInZone).toBe(true);
    expect(inZone.reason).toMatch(/Price is inside the zone now, at /);

    const told = asRecorded(inZone.reason);
    const price = inZone.reason.match(/zone now, at (.+?)\.(?=\s|$)/)![1];

    expect(told).not.toMatch(/\bnow\b/);
    expect(told).toContain(`Price was inside the zone when this was analysed, at ${price}.`);
  });

  it("restates an extended price the same way", () => {
    expect(extended.priceInZone).toBe(false);
    expect(extended.reason).toMatch(/Price is currently .+ ATR above the zone/);

    const told = asRecorded(extended.reason);

    expect(told).not.toMatch(/\bcurrently\b/);
    expect(told).toMatch(/Price was [\d.]+ ATR above the zone when this was analysed/);
  });

  it("leaves every other sentence exactly as the engine wrote it", () => {
    const rest = (s: string) => s.replace(/Price (is|was) [^.]*(\.\d+)*[^.]*\./g, "");
    expect(rest(asRecorded(inZone.reason))).toBe(rest(inZone.reason));
    expect(asRecorded("This is the nearest support zone below price, tested 3 times.")).toBe(
      "This is the nearest support zone below price, tested 3 times.",
    );
  });
});
