// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TIMEFRAME_MS, type Candle } from "@/lib/market-data/provider";
import { makeCandles } from "@/lib/test-utils/candles";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

/**
 * POST /api/analysis/mtf on a candle still forming (Phase B, P1-3).
 *
 * The analysis is shown and recorded whatever the clock says. What it may not do
 * mid-candle is create or move a tracked setup: that setup's snapshot is written
 * once, and the scanner — which reads closed candles only — would move it back.
 * And the higher timeframe's trend is read from closed candles only, on both
 * paths. No database, network or exchange is reached; every service is a stub.
 */

const PAIR_ID = "00000000-0000-4000-8000-000000000001";
const LOWER = pullbackIntoSupport();
const LAST = LOWER.at(-1)!;
const H4 = TIMEFRAME_MS.H4;

/** A rising H4 series whose newest candle is still forming at `now`. */
function higherAt(now: number): Candle[] {
  const formingOpen = Math.floor(now / H4) * H4;
  const count = 80;
  return makeCandles(
    Array.from({ length: count }, (_, i) => 100 + i),
    { timeframe: "H4", startTime: formingOpen - (count - 1) * H4 },
  );
}

const services = vi.hoisted(() => ({
  trackSetup: vi.fn(async () => ({ action: "NONE", setupId: null, status: null })),
  saveAnalysisSnapshot: vi.fn(async () => "snapshot-1"),
  higher: [] as Candle[],
}));

vi.mock("@/lib/auth", () => ({ currentUserId: async () => "user-1" }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { analysis: {} },
  enforceRateLimit: async () => null,
}));
vi.mock("@/services/markets", () => ({
  findMarketByPairId: async () => ({
    pairId: PAIR_ID,
    exchangeSymbol: "BTCUSDT",
    label: "BTC/USDT",
  }),
}));
vi.mock("@/services/candles", () => ({
  getCandles: async (q: { timeframe: string }) => ({
    candles: q.timeframe === "H4" ? services.higher : LOWER,
    stale: false,
  }),
}));
vi.mock("@/services/setups", () => ({ trackSetup: services.trackSetup }));
vi.mock("@/services/snapshots", () => ({ saveAnalysisSnapshot: services.saveAnalysisSnapshot }));
vi.mock("@/lib/analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis")>();
  return { ...actual, analyzeMultiTimeframe: vi.fn(actual.analyzeMultiTimeframe) };
});

const { POST } = await import("./route");
const { analyzeMultiTimeframe } = await import("@/lib/analysis");

async function analyseAt(now: number) {
  vi.setSystemTime(now);
  services.higher = higherAt(now);
  const response = await POST(
    new Request("http://t/api/analysis/mtf", {
      method: "POST",
      body: JSON.stringify({
        tradingPairId: PAIR_ID,
        lowerTimeframe: "H1",
        higherTimeframe: "H4",
      }),
    }) as never,
  );
  return { status: response.status, body: await response.json() };
}

/** Mid-candle: the newest H1 candle closes a minute from now. */
const FORMING = LAST.closeTime - 60_000;
/** Just after it closed. */
const CLOSED = LAST.closeTime + 1;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  services.trackSetup.mockClear();
  services.saveAnalysisSnapshot.mockClear();
  vi.mocked(analyzeMultiTimeframe).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tracking from a manual multi-timeframe analysis", () => {
  it("creates or moves no tracked setup while the entry candle is still forming", async () => {
    const { status, body } = await analyseAt(FORMING);

    expect(status).toBe(200);
    expect(body.result.incomplete).toBeNull();
    expect(services.trackSetup).not.toHaveBeenCalled();
    // The analysis itself is still shown and recorded, exactly as before.
    expect(services.saveAnalysisSnapshot).toHaveBeenCalledTimes(1);
    expect(body.snapshotId).toBe("snapshot-1");
  });

  it("tracks the same result it returns once the entry candle has closed", async () => {
    const { status, body } = await analyseAt(CLOSED);

    expect(status).toBe(200);
    expect(services.trackSetup).toHaveBeenCalledTimes(1);
    const [input] = services.trackSetup.mock.calls[0] as unknown as [
      { result: unknown; timeframe: string; analysisSnapshotId: string },
    ];
    expect(input.timeframe).toBe("H1");
    expect(input.analysisSnapshotId).toBe("snapshot-1");
    expect(JSON.parse(JSON.stringify(input.result))).toEqual(body.result);
  });

  it("keeps the response's shape", async () => {
    const { body } = await analyseAt(FORMING);

    expect(Object.keys(body).sort()).toEqual(
      ["asOf", "label", "pairId", "result", "snapshotId", "symbol", "timeframe"].sort(),
    );
    expect(body.asOf).toBe(LAST.openTime);
  });
});

describe("the higher timeframe's trend", () => {
  it.each([
    ["mid-candle", FORMING],
    ["after the close", CLOSED],
  ])("is read from closed candles only, %s", async (_when, now) => {
    await analyseAt(now);

    expect(analyzeMultiTimeframe).toHaveBeenCalledTimes(1);
    const [{ higherCandles }] = vi.mocked(analyzeMultiTimeframe).mock.calls[0];
    // The stub served 80 candles, the newest still forming; 79 had closed.
    expect(services.higher).toHaveLength(80);
    expect(services.higher.at(-1)!.closeTime).toBeGreaterThan(now);
    expect(higherCandles).toHaveLength(79);
    expect(higherCandles.every((c) => c.closeTime <= now)).toBe(true);
  });
});
