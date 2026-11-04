import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyzeMultiTimeframe, runAnalysis } from "@/lib/analysis";
import type { Candle } from "@/lib/market-data/provider";
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
const updateMany = vi.fn();
const eventCreate = vi.fn();

/**
 * Every write runs on the transaction client. The global client's model
 * methods record and refuse any call: `trackSetup` never throws, so a refusal
 * alone would be swallowed — the record is what the tests assert on.
 */
const globalCalls: string[] = [];
const refuse = (name: string) => () => {
  globalCalls.push(name);
  throw new Error(`${name} called on the global client`);
};

vi.mock("@/lib/db/prisma", () => {
  const tx = {
    trackedSetup: {
      findFirst: (a: unknown) => findFirst(a),
      create: (a: unknown) => create(a),
      updateMany: (a: unknown) => updateMany(a),
    },
    setupEvent: { create: (a: unknown) => eventCreate(a) },
    $executeRaw: async () => 1,
    $queryRaw: async () => [{ evaluated: null, unstamped: null }],
  };

  return {
    isDatabaseConfigured: true,
    prisma: {
      trackedSetup: {
        findFirst: refuse("trackedSetup.findFirst"),
        create: refuse("trackedSetup.create"),
        update: refuse("trackedSetup.update"),
        updateMany: refuse("trackedSetup.updateMany"),
      },
      setupEvent: { create: refuse("setupEvent.create") },
      $executeRaw: refuse("$executeRaw"),
      $queryRaw: refuse("$queryRaw"),
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  };
});

const { trackSetup } = await import("./setups");

/** Read the way a tracked H4 setup is: against D1, its canonical higher timeframe. */
function asTracked(candles: Candle[]) {
  return runAnalysis(candles, {
    mtf: analyzeMultiTimeframe({
      lowerCandles: candles,
      higherCandles: pullbackIntoSupport(),
      lowerTimeframe: "H4",
      higherTimeframe: "D1",
    }),
  });
}

const BULLISH = asTracked(pullbackIntoSupport());
const OTHER = asTracked(extendedAboveSupport());

const base = {
  userId: "user-1",
  tradingPairId: "pair-1",
  timeframe: "H4" as const,
};

/** The status write of a transition — the guarded one, keyed on the state it was planned from. */
const statusWrites = () =>
  updateMany.mock.calls.filter((call) => call[0].where.status !== undefined);

beforeEach(() => {
  findFirst.mockReset();
  create.mockReset();
  updateMany.mockReset();
  eventCreate.mockReset();
  globalCalls.length = 0;

  create.mockResolvedValue({ id: "setup-1", events: [{ id: "event-created" }] });
  updateMany.mockResolvedValue({ count: 1 });
  eventCreate.mockResolvedValue({ id: "event-1" });
});

afterEach(() => {
  expect(globalCalls, "a write escaped the transaction").toEqual([]);
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

    // Either it moved or it did nothing. If it moved, every write must touch
    // lifecycle columns only.
    expect(updateMany).toHaveBeenCalled();
    for (const call of updateMany.mock.calls) {
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

    expect(updateMany).toHaveBeenCalled();
    for (const call of updateMany.mock.calls) {
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

    expect(outcome.action).toBe("NONE");
    expect(updateMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(eventCreate).not.toHaveBeenCalled();
  });
});

describe("confirmedAt is the first confirmation, written once", () => {
  it("is not rewritten when a confirmed setup moves on", async () => {
    expect(BULLISH.status).toBe("POTENTIAL_SETUP");
    findFirst.mockResolvedValue({
      id: "setup-1",
      status: "CONFIRMATION_DETECTED",
      originZoneLow: BULLISH.setup!.entry.low,
      originZoneHigh: BULLISH.setup!.entry.high,
      confirmedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await trackSetup({ ...base, result: BULLISH });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].data.status).toBe("POTENTIAL_SETUP");
    expect(Object.keys(updateMany.mock.calls[0][0].data)).not.toContain("confirmedAt");
  });

  it("is written by the first transition that confirms, and only where it is unset", async () => {
    findFirst.mockResolvedValue({
      id: "setup-1",
      status: "WAITING_CONFIRMATION",
      originZoneLow: BULLISH.setup!.entry.low,
      originZoneHigh: BULLISH.setup!.entry.high,
      confirmedAt: null,
    });

    await trackSetup({ ...base, result: BULLISH });

    expect(statusWrites()).toHaveLength(1);
    expect(Object.keys(statusWrites()[0][0].data)).not.toContain("confirmedAt");

    const stamp = updateMany.mock.calls.find((call) => "confirmedAt" in call[0].data);
    expect(stamp?.[0].where).toEqual({ id: "setup-1", confirmedAt: null });
  });
});
