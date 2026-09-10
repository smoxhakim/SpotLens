import { describe, expect, it, vi } from "vitest";

import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";

import {
  dedupeKeyForDailySummary,
  dedupeKeyForSetupEvent,
  dedupeKeyForSystemError,
  eventTypeForTransition,
  isStructuralChange,
} from "./mapping";
import { escape, formatConnectionTest, formatForTelegram } from "./telegram-format";
import { renderInApp } from "./render";
import { MAX_SEND_ATTEMPTS, parseUpdates, sendTelegramMessage } from "./telegram-provider";
import {
  DEFAULT_PREFERENCES,
  EVENT_PRIORITY,
  type NotificationEvent,
  type SetupFacts,
} from "./types";

/**
 * The notification layer consumes truth the lifecycle already established. Its
 * own job is narrow: decide what is worth saying, say it once, and never let
 * a dynamic value break the message it is embedded in.
 */

const SIGNALS = {
  volume: {
    type: "VOLUME_CONFIRMATION",
    signal: "positive",
    title: "Volume backs the move",
    detail: "d",
  },
  higherLow: {
    type: "HIGHER_LOW",
    signal: "positive",
    title: "A higher low has formed",
    detail: "d",
  },
  breakUp: {
    type: "STRUCTURE_BREAK",
    signal: "positive",
    title: "Local structure broken upward",
    detail: "d",
  },
  supportLost: { type: "RECLAIM", signal: "negative", title: "Support has been lost", detail: "d" },
};

function setupFacts(overrides: Partial<SetupFacts> = {}): SetupFacts {
  return {
    setupId: "setup-1",
    lifecycleStatus: "WAITING_CONFIRMATION",
    previousStatus: "SETUP_FORMING",
    entryLow: 100.5,
    entryHigh: 104.25,
    stopLoss: 96.1,
    takeProfit1: 118.4,
    takeProfit2: 130.2,
    riskReward: 2.1,
    riskRewardIsSynthetic: false,
    score: 79,
    scoreGrade: "STRONG",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    trend: "BULLISH",
    mtfAgreement: "ALIGNED_BULLISH",
    supportLow: 100,
    supportHigh: 104,
    entryReason: "The zone has been tested 3 times.",
    statusReason: "Price is in the entry zone.",
    confirmationSignals: [SIGNALS.volume, SIGNALS.higherLow],
    confirmationExplanation: "Confirmation is present.",
    invalidationReason: null,
    regime: { direction: "TRENDING_UP", volatility: "NORMAL" },
    ...overrides,
  };
}

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: "CONFIRMATION_DETECTED",
    userId: "user-1",
    priority: "HIGH",
    asset: "BTCUSDT",
    timeframe: "H1",
    timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
    dedupeKey: "setup-event:e1",
    setup: setupFacts(),
    summary: null,
    systemError: null,
    ...overrides,
  };
}

describe("which transitions are worth a notification", () => {
  it("reports a setup reaching the engine's highest state", () => {
    expect(
      eventTypeForTransition({ lifecycleStatus: "POTENTIAL_SETUP", confirmationSignals: [] }),
    ).toBe("SETUP_DETECTED");
  });

  it("reports confirmation being detected", () => {
    expect(
      eventTypeForTransition({ lifecycleStatus: "CONFIRMATION_DETECTED", confirmationSignals: [] }),
    ).toBe("CONFIRMATION_DETECTED");
  });

  it("reports an invalidation ahead of anything else true on the same candle", () => {
    expect(
      eventTypeForTransition({
        lifecycleStatus: "INVALIDATED",
        confirmationSignals: [SIGNALS.supportLost],
      }),
    ).toBe("SETUP_INVALIDATED");
  });

  it("says nothing when price merely arrives at a level already identified", () => {
    // The correction that matters: SETUP_FORMING -> WAITING_CONFIRMATION is
    // price moving, not structure changing. Announcing it would be announcing
    // that a chart is still a chart.
    expect(
      eventTypeForTransition({
        lifecycleStatus: "WAITING_CONFIRMATION",
        confirmationSignals: [SIGNALS.volume],
      }),
    ).toBeNull();

    expect(
      eventTypeForTransition({ lifecycleStatus: "SETUP_FORMING", confirmationSignals: [] }),
    ).toBeNull();
  });

  it("reports a structural change only when a level actually broke or was reclaimed", () => {
    // Taken from the confirmation engine's own signals rather than re-derived.
    expect(
      eventTypeForTransition({
        lifecycleStatus: "WAITING_CONFIRMATION",
        confirmationSignals: [SIGNALS.breakUp],
      }),
    ).toBe("STRUCTURE_CHANGED");

    expect(
      isStructuralChange({
        lifecycleStatus: "WAITING_CONFIRMATION",
        confirmationSignals: [SIGNALS.volume],
      }),
    ).toBe(false);
    expect(
      isStructuralChange({
        lifecycleStatus: "WAITING_CONFIRMATION",
        confirmationSignals: [SIGNALS.supportLost],
      }),
    ).toBe(true);
  });

  it("says nothing about a market that failed before producing a setup", () => {
    expect(eventTypeForTransition({ lifecycleStatus: null, confirmationSignals: [] })).toBeNull();
  });
});

describe("deduplication keys", () => {
  it("derives a setup's key from the lifecycle event that caused it", () => {
    // One SetupEvent row per transition means one notification per transition,
    // for free, without a second notion of identity.
    expect(dedupeKeyForSetupEvent("abc")).toBe("setup-event:abc");
    expect(dedupeKeyForSetupEvent("abc")).toBe(dedupeKeyForSetupEvent("abc"));
    expect(dedupeKeyForSetupEvent("abc")).not.toBe(dedupeKeyForSetupEvent("abd"));
  });

  it("buckets system errors by the hour so a broken market does not spam", () => {
    const at = Date.UTC(2026, 0, 2, 3, 10, 0);
    const later = Date.UTC(2026, 0, 2, 3, 55, 0);
    const nextHour = Date.UTC(2026, 0, 2, 4, 1, 0);

    const key = (t: number) =>
      dedupeKeyForSystemError({ category: "MARKET_DATA_ERROR", symbol: "BTCUSDT", at: t });

    expect(key(at)).toBe(key(later));
    expect(key(at)).not.toBe(key(nextHour));
  });

  it("allows one summary per UTC day", () => {
    expect(dedupeKeyForDailySummary("2026-01-02")).toBe("daily-summary:2026-01-02");
    expect(dedupeKeyForDailySummary("2026-01-02")).not.toBe(dedupeKeyForDailySummary("2026-01-03"));
  });
});

describe("MarkdownV2 escaping", () => {
  it("escapes every character Telegram reserves", () => {
    // Missing one does not corrupt the formatting — it makes Telegram reject
    // the whole message with a 400.
    for (const char of "_*[]()~`>#+-=|{}.!\\") {
      expect(escape(char)).toBe(`\\${char}`);
    }
  });

  it("neutralises an attempt to inject markup through a dynamic value", () => {
    const hostile = "*bold* [link](https://evil.example) `code`";
    const escaped = escape(hostile);

    expect(escaped).not.toMatch(/(^|[^\\])\*/);
    expect(escaped).not.toMatch(/(^|[^\\])\[/);
    expect(escaped).toContain("\\*");
    expect(escaped).toContain("\\[");
  });

  it("renders a missing value as a dash rather than 'null'", () => {
    expect(escape(null)).toBe("—");
    expect(escape(undefined)).toBe("—");
  });

  it("escapes the decimal point in a price, which is the usual cause of a 400", () => {
    expect(escape("104.25")).toBe("104\\.25");
  });
});

describe("Telegram messages", () => {
  const types = [
    ["SETUP_DETECTED", event({ type: "SETUP_DETECTED" })],
    ["CONFIRMATION_DETECTED", event({ type: "CONFIRMATION_DETECTED" })],
    [
      "SETUP_INVALIDATED",
      event({
        type: "SETUP_INVALIDATED",
        setup: setupFacts({
          lifecycleStatus: "INVALIDATED",
          invalidationReason: "Support has been lost at 100 – 104.",
        }),
      }),
    ],
    [
      "STRUCTURE_CHANGED",
      event({
        type: "STRUCTURE_CHANGED",
        setup: setupFacts({ confirmationSignals: [SIGNALS.breakUp] }),
      }),
    ],
    [
      "DAILY_SUMMARY",
      event({
        type: "DAILY_SUMMARY",
        asset: null,
        timeframe: null,
        setup: null,
        summary: {
          date: "2026-01-02",
          runs: 24,
          marketsScanned: 45,
          analysesByTimeframe: [{ timeframe: "H1", count: 45 }],
          potentialSetups: 0,
          waiting: 24,
          highRisk: 21,
          avoided: 45,
          failures: 1,
          setupsCreated: 2,
          confirmations: 3,
          invalidations: 1,
          topRanked: [
            {
              symbol: "NEARUSDT",
              timeframe: "H4",
              analysisStatus: "WAIT_FOR_CONFIRMATION",
              score: 91,
            },
          ],
        },
      }),
    ],
    [
      "SYSTEM_ERROR",
      event({
        type: "SYSTEM_ERROR",
        setup: null,
        systemError: {
          category: "MARKET_DATA_ERROR",
          symbol: "BTCUSDT",
          timeframe: "H1",
          message: "TIMEOUT: took too long",
          affectedMarkets: 1,
        },
      }),
    ],
  ] as const;

  it.each(types)("renders %s without leaving a reserved character unescaped", (_name, e) => {
    const text = formatForTelegram(e);

    expect(text.length).toBeGreaterThan(0);
    // Every unescaped reserved character must be one this formatter emitted
    // deliberately as markup: * for bold, _ for italic, \ for an escape.
    const stray = text.replace(/\\./g, "").match(/[[\]()~`>#+=|{}.!-]/g);
    expect(stray, `stray reserved characters in ${_name}: ${stray?.join("")}`).toBeNull();
  });

  it.each(types)("never uses instruction or certainty language in %s", (_name, e) => {
    // The disclaimer is removed first because it legitimately contains the word
    // "guaranteed" — in the sentence denying that anything is. A naive banned
    // word list would flag the very text that makes the message honest.
    const text = formatForTelegram(e)
      .toLowerCase()
      .split(escape(ANALYSIS_DISCLAIMER).toLowerCase())
      .join(" ");

    for (const banned of [
      "buy now",
      "sell now",
      "execute",
      "place order",
      "guaranteed profit",
      "is guaranteed",
      "sure win",
      "don't miss",
      "easy money",
      "you should buy",
      "you must enter",
      "100% ",
      "win probability",
      "chance of winning",
    ]) {
      expect(text, `${_name} contained "${banned}"`).not.toContain(banned);
    }
  });

  it.each(types)("carries the shared disclaimer rather than its own wording in %s", (_name, e) => {
    const text = formatForTelegram(e);
    const isMarketFacing = e.type !== "SYSTEM_ERROR";

    // Disclaimer wording lives in lib/constants/disclaimers.ts and nowhere
    // else, so it cannot drift between the app and a phone.
    expect(text.includes(escape(ANALYSIS_DISCLAIMER))).toBe(isMarketFacing);
  });

  it("calls the score quality, never a probability", () => {
    const text = formatForTelegram(event({ type: "SETUP_DETECTED" }));

    expect(text).toMatch(/Setup quality/);
    expect(text).not.toMatch(/%/);
  });

  it("refuses to present an unmeasured reward as a measured one", () => {
    // Phase A's rule, carried all the way to the phone.
    const text = formatForTelegram(
      event({
        type: "SETUP_DETECTED",
        setup: setupFacts({ riskReward: 2.5, riskRewardIsSynthetic: true }),
      }),
    );

    expect(text).toMatch(/not measurable/i);
    expect(text).not.toMatch(/1:2\\?\.5/);
  });

  it("handles a setup with no targets at all", () => {
    const text = formatForTelegram(
      event({
        type: "SETUP_DETECTED",
        setup: setupFacts({ takeProfit1: null, takeProfit2: null }),
      }),
    );

    expect(text).toContain("—");
  });

  it("says plainly when a day produced nothing", () => {
    const text = formatForTelegram(types[4][1]);
    expect(text).toMatch(/normal outcome/i);
  });

  it("keeps the connection test free of anything about a market", () => {
    const text = formatConnectionTest();

    expect(text).toMatch(/connection test successful/i);
    expect(text.toLowerCase()).not.toMatch(/entry|stop|target|setup quality/);
  });
});

describe("in-app rendering", () => {
  it("summarises each type in one line", () => {
    for (const [, e] of [
      ["a", event({ type: "SETUP_DETECTED" })],
      ["b", event({ type: "CONFIRMATION_DETECTED" })],
      ["c", event({ type: "SETUP_INVALIDATED" })],
    ] as const) {
      const { title, body } = renderInApp(e);
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
    }
  });

  it("mentions the asset and timeframe in the title", () => {
    expect(renderInApp(event({ type: "SETUP_DETECTED" })).title).toContain("BTCUSDT");
  });
});

describe("Telegram provider", () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;

  function withToken(token: string | undefined) {
    if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = token;
  }

  function restore() {
    withToken(originalToken);
  }

  const ok = () =>
    ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response;

  it("reports a clear failure when no token is configured", async () => {
    withToken(undefined);
    const result = await sendTelegramMessage({ chatId: "1", text: "hi" });
    restore();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not configured/i);
    expect(result.retryable).toBe(false);
  });

  it("sends successfully on the first attempt", async () => {
    withToken("123:FAKE");
    const fetchImpl = vi.fn().mockResolvedValue(ok());

    const result = await sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });
    restore();

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and gives up at the ceiling", async () => {
    withToken("123:FAKE");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, description: "Too Many Requests" }),
    } as unknown as Response);

    const result = await sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });
    restore();

    expect(fetchImpl).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);
    expect(result.ok).toBe(false);
  });

  it("does not retry a 400, which is a message that will always be rejected", async () => {
    withToken("123:FAKE");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "can't parse entities" }),
    } as unknown as Response);

    const result = await sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });
    restore();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });

  it("treats a network failure as retryable and never throws", async () => {
    withToken("123:FAKE");
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed"));

    const result = await sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });
    restore();

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_SEND_ATTEMPTS);
  });

  it("survives a malformed response body", async () => {
    withToken("123:FAKE");
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    const result = await sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });
    restore();

    expect(result.ok).toBe(false);
  });

  it("never lets the bot token reach the stored error", async () => {
    const token = "7654321:AAHsuperSecretTokenValue";
    withToken(token);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      // Telegram echoing the request URL back is exactly how a token leaks.
      json: async () => ({
        ok: false,
        description: `Unauthorized for https://api.telegram.org/bot${token}/sendMessage`,
      }),
    } as unknown as Response);

    const result = await sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });
    restore();

    expect(result.error).not.toContain(token);
    expect(result.error).not.toContain("superSecret");
    expect(result.error).toContain("[redacted]");
  });
});

describe("parsing Telegram updates", () => {
  it("reads a well-formed message", () => {
    const updates = parseUpdates([
      { update_id: 7, message: { text: "/start ABCD2345", chat: { id: 42, username: "someone" } } },
    ]);

    expect(updates).toEqual([
      { updateId: 7, chatId: "42", chatLabel: "@someone", text: "/start ABCD2345" },
    ]);
  });

  it("skips anything that is not shaped like a message", () => {
    // Untrusted input from outside the process: every field is checked.
    expect(parseUpdates("nonsense")).toEqual([]);
    expect(parseUpdates([null, 5, {}, { update_id: "x" }])).toEqual([]);
    expect(parseUpdates([{ update_id: 1, message: { chat: { id: 1 } } }])).toEqual([]);
  });

  it("bounds the text it keeps", () => {
    const updates = parseUpdates([
      { update_id: 1, message: { text: "x".repeat(5_000), chat: { id: 1 } } },
    ]);

    expect(updates[0].text.length).toBeLessThanOrEqual(200);
  });
});

describe("defaults and priorities", () => {
  it("is quiet out of the box", () => {
    // A first scan created 20 setups at forming or waiting. A channel that
    // announced all of them would be ignored within a day.
    expect(DEFAULT_PREFERENCES.setupDetected).toBe(false);
    expect(DEFAULT_PREFERENCES.structureChanged).toBe(false);
    expect(DEFAULT_PREFERENCES.dailySummary).toBe(false);

    expect(DEFAULT_PREFERENCES.confirmationDetected).toBe(true);
    expect(DEFAULT_PREFERENCES.setupInvalidated).toBe(true);
    expect(DEFAULT_PREFERENCES.systemError).toBe(true);

    // Telegram off until a chat is actually bound.
    expect(DEFAULT_PREFERENCES.telegramEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.inAppEnabled).toBe(true);
  });

  it("ranks a confirmation and an invalidation above a summary", () => {
    expect(EVENT_PRIORITY.CONFIRMATION_DETECTED).toBe("HIGH");
    expect(EVENT_PRIORITY.SETUP_INVALIDATED).toBe("HIGH");
    expect(EVENT_PRIORITY.DAILY_SUMMARY).toBe("LOW");
  });
});
