import { beforeEach, describe, expect, it, vi } from "vitest";

import { successfulPassWhere } from "@/lib/scanner/runs";

/**
 * When a successful pass last found each setup still open.
 *
 * The same provenance the entry-zone monitor trusts — an OK result naming the
 * setup, on a run that finished as COMPLETED or PARTIAL — asked once for a whole
 * page of setups. Read-only: the stub has nothing that writes.
 */

const groupBy = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: { scannerResult: { groupBy: (a: unknown) => groupBy(a) } },
}));

const { lastScanReads } = await import("./setups");

beforeEach(() => {
  groupBy.mockReset();
});

describe("lastScanReads", () => {
  it("asks once, for OK results on successful passes only", async () => {
    groupBy.mockResolvedValue([]);
    await lastScanReads(["s1", "s2"]);

    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ["trackedSetupId"],
      where: {
        trackedSetupId: { in: ["s1", "s2"] },
        status: "OK",
        scannerRun: successfulPassWhere(),
      },
      _max: { analysedAtCandle: true, createdAt: true },
    });
  });

  it("returns the newest candle and write time per setup, and nothing for one never read", async () => {
    groupBy.mockResolvedValue([
      {
        trackedSetupId: "s1",
        _max: {
          analysedAtCandle: BigInt(Date.parse("2026-10-29T04:00:00Z")),
          createdAt: new Date("2026-10-29T08:01:40Z"),
        },
      },
      // A legacy row written before the candle was stored.
      {
        trackedSetupId: "s2",
        _max: { analysedAtCandle: null, createdAt: new Date("2026-10-20T13:00:00Z") },
      },
      { trackedSetupId: null, _max: { analysedAtCandle: null, createdAt: null } },
    ]);

    const reads = await lastScanReads(["s1", "s2", "s3"]);

    expect(reads.get("s1")).toEqual({
      analysedAtCandle: Date.parse("2026-10-29T04:00:00Z"),
      recordedAt: Date.parse("2026-10-29T08:01:40Z"),
    });
    expect(reads.get("s2")).toEqual({
      analysedAtCandle: null,
      recordedAt: Date.parse("2026-10-20T13:00:00Z"),
    });
    expect(reads.has("s3")).toBe(false);
    expect(reads.size).toBe(2);
  });

  it("does not query at all for an empty page", async () => {
    expect((await lastScanReads([])).size).toBe(0);
    expect(groupBy).not.toHaveBeenCalled();
  });
});
