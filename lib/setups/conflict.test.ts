import { describe, expect, it } from "vitest";

import { TIMEFRAME_MS } from "@/lib/market-data/provider";

import {
  classifyLifecycleError,
  isStaleAnalysis,
  LifecycleConflictError,
  lifecycleLockKey,
  newestRecordedCandle,
  type TransactionPhase,
} from "./conflict";

const H = TIMEFRAME_MS.H1;
/** An H1 candle boundary, so arithmetic below lands on candles exactly. */
const T = Date.UTC(2026, 10, 4, 12);

describe("the lock key is the setup identity", () => {
  const identity = { userId: "u-1", tradingPairId: "p-1", timeframe: "H1" as const };

  it("names user, pair and entry timeframe", () => {
    expect(lifecycleLockKey(identity)).toBe("spotlens:tracked-setup:u-1:p-1:H1");
  });

  it("differs between H1 and H4 on one market, and between users and pairs", () => {
    const keys = new Set([
      lifecycleLockKey(identity),
      lifecycleLockKey({ ...identity, timeframe: "H4" }),
      lifecycleLockKey({ ...identity, userId: "u-2" }),
      lifecycleLockKey({ ...identity, tradingPairId: "p-2" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("ignores everything that is not identity", () => {
    // Narrower than identity would let two writers read one setup under two locks.
    const withExtras = { ...identity, result: { anything: true }, higherTimeframe: "D1" };
    expect(lifecycleLockKey(withExtras)).toBe(lifecycleLockKey(identity));
  });
});

describe("an older analysis cannot overwrite a newer state", () => {
  const none = { newestEvaluatedAt: null, newestUnstampedAt: null };
  const evaluatedOn = (open: number) => ({
    newestEvaluatedAt: open + H - 1,
    newestUnstampedAt: null,
  });

  it("refuses a strictly older candle than one recorded", () => {
    expect(
      isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: T - H, recorded: evaluatedOn(T) }),
    ).toBe(true);
  });

  it("admits the same candle again — the repeated pass must still plan", () => {
    expect(
      isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: T, recorded: evaluatedOn(T) }),
    ).toBe(false);
  });

  it("admits a newer candle", () => {
    expect(
      isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: T + H, recorded: evaluatedOn(T) }),
    ).toBe(false);
  });

  it("has nothing to judge against when nothing is recorded, or nothing was analysed", () => {
    expect(isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: T, recorded: none })).toBe(false);
    expect(
      isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: 0, recorded: evaluatedOn(T) }),
    ).toBe(false);
  });

  it("reads a close time written either way as the same candle", () => {
    for (const close of [T + H - 1, T + H]) {
      const recorded = { newestEvaluatedAt: close, newestUnstampedAt: null };
      expect(newestRecordedCandle("H1", recorded)).toBe(T);
      expect(isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: T, recorded })).toBe(false);
    }
  });

  it("ignores a zero evaluatedAt, which means no candle was judged", () => {
    expect(
      newestRecordedCandle("H1", { newestEvaluatedAt: 0, newestUnstampedAt: null }),
    ).toBeNull();
  });

  describe("an event with no confirmation payload", () => {
    // The "engine offered no setup" invalidation names no candle; it is bounded
    // by the newest candle that had closed when the row was written.
    it("is bounded by the candle that had closed when it was written", () => {
      const written = T + H + 90_000; // candle T closed at T+H; written in the settle window
      expect(
        newestRecordedCandle("H1", { newestEvaluatedAt: null, newestUnstampedAt: written }),
      ).toBe(T);
    });

    it("refuses an analysis older than that bound", () => {
      const recorded = { newestEvaluatedAt: T - 5 * H + H - 1, newestUnstampedAt: T + H + 90_000 };
      // The newest *stamped* event is older; without the bound this would pass.
      expect(isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: T - H, recorded })).toBe(true);
    });

    it("admits the candle the bound names", () => {
      const recorded = { newestEvaluatedAt: null, newestUnstampedAt: T + H + 90_000 };
      expect(isStaleAnalysis({ timeframe: "H1", analysedCandleOpen: T, recorded })).toBe(false);
    });

    it("takes the later of the two when both exist", () => {
      expect(
        newestRecordedCandle("H1", {
          newestEvaluatedAt: T + 3 * H - 1,
          newestUnstampedAt: T + 90_000,
        }),
      ).toBe(T + 2 * H);
    });
  });

  it("snaps weekly candles to the Monday boundary", () => {
    const monday = Date.UTC(2026, 10, 2); // 2026-11-02 is a Monday
    const week = TIMEFRAME_MS.W1;
    const recorded = { newestEvaluatedAt: monday + week - 1, newestUnstampedAt: null };
    expect(newestRecordedCandle("W1", recorded)).toBe(monday);
    expect(isStaleAnalysis({ timeframe: "W1", analysedCandleOpen: monday - week, recorded })).toBe(
      true,
    );
    expect(isStaleAnalysis({ timeframe: "W1", analysedCandleOpen: monday, recorded })).toBe(false);
  });
});

describe("a failure is retried only when it certainly rolled back", () => {
  const prismaError = (code: string, message = "provider text", meta?: object) =>
    Object.assign(new Error(message), { code, ...(meta ? { meta } : {}) });

  const cases: [string, unknown, TransactionPhase, string, string][] = [
    // [label, error, phase, kind, code]
    [
      "our guard conflict",
      new LifecycleConflictError("s", "SETUP_FORMING"),
      "BODY",
      "RETRY",
      "LIFECYCLE_CONFLICT",
    ],
    [
      "lock timeout via raw query",
      prismaError("P2010", "x", { code: "55P03" }),
      "BODY",
      "RETRY",
      "55P03",
    ],
    ["write conflict or deadlock", prismaError("P2034"), "BODY", "RETRY", "P2034"],
    ["transaction timed out mid-body", prismaError("P2028"), "BODY", "NOT_WRITTEN", "P2028"],
    ["connection lost mid-body", prismaError("P1017"), "BODY", "NOT_WRITTEN", "P1017"],
    ["any other error in the body", new TypeError("boom"), "BODY", "NOT_WRITTEN", "TypeError"],
    ["pool exhausted before BEGIN", prismaError("P2024"), "BEGIN", "RETRY", "P2024"],
    [
      "could not start in time",
      prismaError(
        "P2028",
        "Transaction API error: Unable to start a transaction in the given time.",
      ),
      "BEGIN",
      "RETRY",
      "P2028",
    ],
    ["database unreachable before BEGIN", prismaError("P1001"), "BEGIN", "NOT_WRITTEN", "P1001"],
    [
      "commit refused on an expired transaction",
      prismaError(
        "P2028",
        "Transaction already closed: A commit cannot be executed on an expired transaction.",
      ),
      "COMMIT",
      "NOT_WRITTEN",
      "P2028",
    ],
    ["connection lost at COMMIT", prismaError("P1017"), "COMMIT", "UNCERTAIN", "P1017"],
    [
      "another transaction error at COMMIT",
      prismaError("P2028", "Transaction not found"),
      "COMMIT",
      "UNCERTAIN",
      "P2028",
    ],
    ["an unknown error at COMMIT", new Error("socket hang up"), "COMMIT", "UNCERTAIN", "Error"],
    ["not even an Error", "nope", "COMMIT", "UNCERTAIN", "UNKNOWN"],
  ];

  it.each(cases)("%s", (_label, err, phase, kind, code) => {
    expect(classifyLifecycleError(err, phase)).toEqual({ kind, code });
  });

  it("never carries the provider's message", () => {
    const failure = classifyLifecycleError(
      prismaError("P1017", "postgresql://user:secret@host/db"),
      "COMMIT",
    );
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
});
