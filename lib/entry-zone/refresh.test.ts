import { describe, expect, it } from "vitest";

import { planRefresh } from "@/lib/entry-zone";

/** When the monitor reloads open setups. Clock passed in; no I/O. */

const base = {
  now: 1_000_000,
  lastFullRefreshAt: 1_000_000 - 1_000,
  refreshMs: 600_000,
  requested: false,
  lastScannerCheckAt: 1_000_000 - 1_000,
  scannerCheckMs: 60_000,
};

describe("planRefresh", () => {
  it("reloads at startup", () => {
    expect(planRefresh({ ...base, lastFullRefreshAt: -Infinity })).toBe("FULL");
  });

  it("reloads at once when the engine relays a completed scan", () => {
    expect(planRefresh({ ...base, requested: true })).toBe("REQUESTED");
  });

  it("checks for a new scanner run on its own interval — not every tick", () => {
    expect(planRefresh(base)).toBe("NONE");
    expect(planRefresh({ ...base, lastScannerCheckAt: base.now - 60_000 })).toBe("CHECK_SCANNER");
  });

  it("the periodic full reload still happens as a safety net", () => {
    expect(planRefresh({ ...base, lastFullRefreshAt: base.now - 600_000 })).toBe("FULL");
  });

  it("a due full reload subsumes a request and a check", () => {
    expect(
      planRefresh({
        ...base,
        lastFullRefreshAt: base.now - 600_000,
        requested: true,
        lastScannerCheckAt: -Infinity,
      }),
    ).toBe("FULL");
  });

  it("a request is not delayed by the check interval", () => {
    expect(planRefresh({ ...base, requested: true, lastScannerCheckAt: base.now })).toBe(
      "REQUESTED",
    );
  });
});
