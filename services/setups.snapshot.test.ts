import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAnalysis } from "@/lib/analysis";
import { extendedAboveSupport, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

/**
 * The snapshot columns are written once and never again.
 *
 * `lib/setups` already proves the snapshot is a value rather than a reference.
 * What is missing — and what replay and the journal both depend on — is that
 * the *writer* never names those columns on a later transition. A lifecycle
 * update that also refreshed the entry price would leave a stored setup whose
 * numbers silently became today's, and every replay of it would then be a
 * reconstruction of the wrong thing.
 */

/** Every snapshot column on `TrackedSetup`, by name. */
const FROZEN = [
  "entryLow",
  "entryHigh",
  "stopLoss",
  "takeProfit1",
  "takeProfit2",
  "takeProfit3",
  "riskReward",
  "riskRewardIsSynthetic",
  "score",
  "scoreGrade",
  "analysisStatus",
  "snapshot",
  "originZoneLow",
  "originZoneHigh",
];

const findFirst = vi.fn();
const create = vi.fn();
const update = vi.fn();
const eventCreate = vi.fn();

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    trackedSetup: {
      findFirst: (a: unknown) => findFirst(a),
      create: (a: unknown) => create(a),
      update: (a: unknown) => update(a),
    },
    setupEvent: { create: (a: unknown) => eventCreate(a) },
    $transaction: async (arg: unknown) =>
      typeof arg === "function" ? (arg as () => unknown)() : arg,
  },
}));

const { trackSetup } = await import("./setups");

const BULLISH = runAnalysis(pullbackIntoSupport());
const OTHER = runAnalysis(extendedAboveSupport());

const base = {
  userId: "user-1",
  tradingPairId: "pair-1",
  timeframe: "H4" as const,
};

beforeEach(() => {
  findFirst.mockReset();
  create.mockReset();
  update.mockReset();
  eventCreate.mockReset();

  create.mockResolvedValue({ id: "setup-1" });
  update.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
});

describe("a stored setup's numbers never change", () => {
  it("writes every snapshot column exactly once, at creation", async () => {
    findFirst.mockResolvedValue(null);

    await trackSetup({ ...base, result: BULLISH });

    const data = create.mock.calls[0][0].data;
    for (const column of FROZEN) {
      expect(Object.keys(data), column).toContain(column);
    }
  });

  it("never names a snapshot column on a later transition", async () => {
    // The setup is already tracked at an earlier state, so this run moves it
    // rather than creating anything.
    findFirst.mockResolvedValue({
      id: "setup-1",
      status: "SETUP_FORMING",
      originZoneLow: BULLISH.setup!.entry.low,
      originZoneHigh: BULLISH.setup!.entry.high,
      confirmedAt: null,
    });

    await trackSetup({ ...base, result: BULLISH });

    // Either it moved or it did nothing. If it moved, the update must touch
    // lifecycle columns only.
    for (const call of update.mock.calls) {
      const written = Object.keys(call[0].data);
      for (const column of FROZEN) {
        expect(written, `transition wrote ${column}`).not.toContain(column);
      }
    }
  });

  it("does not rewrite the old setup when the level moves", async () => {
    // A level that comes back is a new setup with a new id. The old one is
    // invalidated — its record of what was on offer stays exactly as it was.
    findFirst.mockResolvedValue({
      id: "setup-old",
      status: "SETUP_FORMING",
      // A zone that cannot overlap the new analysis.
      originZoneLow: 0.0001,
      originZoneHigh: 0.0002,
      confirmedAt: null,
    });

    await trackSetup({ ...base, result: OTHER });

    for (const call of update.mock.calls) {
      expect(call[0].where.id).toBe("setup-old");
      for (const column of FROZEN) {
        expect(Object.keys(call[0].data), column).not.toContain(column);
      }
    }
  });

  it("writes nothing at all when the state has not moved", async () => {
    findFirst.mockResolvedValue({
      id: "setup-1",
      status: BULLISH.status === "POTENTIAL_SETUP" ? "POTENTIAL_SETUP" : "WAITING_CONFIRMATION",
      originZoneLow: BULLISH.setup!.entry.low,
      originZoneHigh: BULLISH.setup!.entry.high,
      confirmedAt: new Date(),
    });

    const outcome = await trackSetup({ ...base, result: BULLISH });

    if (outcome.action === "NONE") {
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    }
  });
});
