import { beforeEach, describe, expect, it, vi } from "vitest";

import { reconcileSetup, type ExistingSetup } from "@/lib/setups";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";
import type { MarketSummary } from "@/types/market";

/**
 * An untracked candidate must not look like an invalidated setup anywhere a
 * count is kept.
 *
 * NEAR/USDT 4h and ARB/USDT 4h: levels, a score, a measured reward, and no
 * setup — confirmation was contradicted on a level nobody was tracking. An
 * earlier draft recorded that as `lifecycleStatus = INVALIDATED` on the
 * scanner row. Every invalidation count the app keeps — the run's
 * `invalidations`, the daily summary (which sums them), research (which counts
 * `TrackedSetup` rows) — is checked here against a pass made of nothing else.
 *
 * Persistence is a recording stub. No database is reached.
 */

const writes = vi.hoisted(() => ({
  results: [] as Record<string, unknown>[],
  runUpdates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/db/prisma", () => ({
  isDatabaseConfigured: true,
  prisma: {
    scannerRun: {
      create: async () => ({ id: "run-1" }),
      update: async (arg: { data: Record<string, unknown> }) => {
        writes.runUpdates.push(arg.data);
        return arg;
      },
    },
    scannerResult: {
      createMany: async (arg: { data: Record<string, unknown>[] }) => {
        writes.results.push(...arg.data);
        return { count: arg.data.length };
      },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

const CANDLES = pullbackIntoSupport();
vi.mock("@/services/candles", () => ({ getCandles: async () => ({ candles: CANDLES }) }));

/** Every analysis comes back as a WAIT whose confirmation was contradicted. */
vi.mock("@/lib/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis")>();
  const contradicted = (result: ReturnType<typeof actual.runAnalysis>) => ({
    ...result,
    status: "WAIT_FOR_CONFIRMATION" as const,
    confirmation: { ...result.confirmation!, status: "CONTRADICTED" as const },
  });
  return {
    ...actual,
    runAnalysis: (...args: Parameters<typeof actual.runAnalysis>) =>
      contradicted(actual.runAnalysis(...args)),
    // What the scanner calls. The same result as above, and diagnostics that say
    // what it says: the confirmation gate, the last rule, decided CONTRADICTED.
    // That is only coherent when every earlier gate passed, so the fixture must
    // still be a real potential setup; the outcomes come from the engine's own
    // `gateOutcomes`, not from this file.
    runAnalysisWithDiagnostics: (...args: Parameters<typeof actual.runAnalysisWithDiagnostics>) => {
      const { result, diagnostics } = actual.runAnalysisWithDiagnostics(...args);
      if (diagnostics.blockingGate !== null) {
        throw new Error(`Fixture no longer reaches confirmation: ${diagnostics.blockingGate}`);
      }
      const notApplicable = new Set(
        diagnostics.gates.filter((g) => g.outcome === "NOT_APPLICABLE").map((g) => g.gate),
      );
      return {
        result: contradicted(result),
        diagnostics: {
          ...diagnostics,
          blockingGate: "CONFIRMATION_CONTRADICTED" as const,
          gates: actual.gateOutcomes("CONFIRMATION_CONTRADICTED", {
            reached: "SCORE",
            notApplicable,
          }),
          confirmation: { ...diagnostics.confirmation!, status: "CONTRADICTED" as const },
        },
      };
    },
  };
});

/**
 * The lifecycle's own planner decides; this stands in only for the rows it
 * would write. `tracked` is the open setup, if the test gives it one.
 */
const tracking = vi.hoisted(() => ({ tracked: null as ExistingSetup | null, created: 0 }));
vi.mock("@/services/setups", () => ({
  trackSetup: async (input: { result: Parameters<typeof reconcileSetup>[0]["result"] }) => {
    const plan = reconcileSetup({ existing: tracking.tracked, result: input.result });
    switch (plan.action) {
      case "NONE":
        return {
          action: "NONE",
          setupId: tracking.tracked?.id ?? null,
          status: null,
          reason: plan.reason,
          cause: plan.cause,
        };
      case "TRANSITION":
        return {
          action: "TRANSITION",
          setupId: plan.transition.setupId,
          status: plan.transition.to,
          reason: null,
          cause: null,
        };
      default:
        tracking.created += 1;
        return { action: plan.action, setupId: "new", status: "X", reason: null, cause: null };
    }
  },
}));

const { runScan } = await import("./scanner");

const MARKETS = [
  { pairId: "pair-near", exchangeSymbol: "NEARUSDT", label: "NEAR/USDT" },
  { pairId: "pair-arb", exchangeSymbol: "ARBUSDT", label: "ARB/USDT" },
] as MarketSummary[];

const scan = () =>
  runScan({
    userId: "user-1",
    now: CANDLES.at(-1)!.closeTime + 1,
    markets: MARKETS,
    timeframes: ["H4"],
    maxConcurrency: 1,
  });

beforeEach(() => {
  writes.results.length = 0;
  writes.runUpdates.length = 0;
  tracking.tracked = null;
  tracking.created = 0;
});

describe("a pass of contradicted, never-tracked candidates", () => {
  it("counts no invalidation, creates no setup, and emits no invalidation event", async () => {
    const summary = await scan();

    expect(summary.invalidations).toBe(0);
    expect(writes.runUpdates).toEqual([expect.objectContaining({ invalidations: 0 })]);
    expect(tracking.created).toBe(0);
    expect(summary.events.filter((e) => e.type === "SETUP_INVALIDATED")).toEqual([]);
    // The pass's gate counts say what its results say.
    expect(summary.breakdown[0].blockingGates.CONFIRMATION_CONTRADICTED).toBe(2);
    expect(summary.breakdown[0].passed).toBe(0);
  });

  it("stores no lifecycle state on the scanner rows — nothing moved", async () => {
    await scan();

    expect(writes.results).toHaveLength(2);
    for (const row of writes.results) {
      expect(row.trackedSetupId).toBeNull();
      expect(row.lifecycleStatus).toBeNull();
      // The reason is not a column. It must not leak into one that means
      // something else.
      expect(Object.values(row)).not.toContain("INVALIDATED");
      expect(Object.values(row)).not.toContain("CONFIRMATION_CONTRADICTED");
    }
  });

  it("names the reason on this pass's results, and keeps them off its shortlist", async () => {
    const summary = await scan();

    expect(summary.results.map((r) => r.untrackedReason)).toEqual([
      "CONFIRMATION_CONTRADICTED",
      "CONFIRMATION_CONTRADICTED",
    ]);
    // Nothing to follow and confirmation contradicted: not offered for review,
    // and counted under that reason rather than as unrecorded.
    expect(summary.shortlist.allEligible).toEqual([]);
    expect(summary.shortlist.excluded.CONFIRMATION_CONTRADICTED).toBe(2);
    expect(summary.shortlist.excluded.NOT_TRACKED).toBe(0);
  });
});

describe("the contrast: a tracked setup that is contradicted", () => {
  it("is a real invalidation, and is counted as one", async () => {
    tracking.tracked = {
      id: "setup-1",
      status: "WAITING_CONFIRMATION",
      origin: { zoneLow: 0, zoneHigh: 1e9 },
      hasConfirmedAt: false,
    };

    const summary = await scan();

    expect(summary.invalidations).toBe(2);
    expect(writes.runUpdates).toEqual([expect.objectContaining({ invalidations: 2 })]);
    for (const row of writes.results) {
      expect(row.trackedSetupId).toBe("setup-1");
      expect(row.lifecycleStatus).toBe("INVALIDATED");
    }
    expect(summary.results.every((r) => r.untrackedReason === null)).toBe(true);
  });
});
