import { describe, expect, it, vi } from "vitest";

import { ANALYSIS_DISCLAIMER } from "@/lib/constants/disclaimers";

import {
  dedupeKeyForDailySummary,
  dedupeKeyForSetupEvent,
  dedupeKeyForSystemError,
  eventTypeForTransition,
  isStructuralChange,
  isTelegramWorthy,
  telegramPriorityFor,
} from "./mapping";
import {
  REPLACEMENT_TITLE,
  TELEGRAM_TITLES,
  escape,
  formatConnectionTest,
  formatForTelegram,
} from "./telegram-format";
import { IN_APP_MARKERS, renderInApp, toneForNotification } from "./render";
import {
  MAX_RETRY_AFTER_MS,
  MAX_SEND_ATTEMPTS,
  getTelegramBotUsername,
  parseUpdates,
  resetTelegramIdentityCache,
  sendTelegramMessage,
} from "./telegram-provider";
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
    isReplacement: false,
    replacementZoneLow: null,
    replacementZoneHigh: null,
    everConfirmed: false,
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
      "SETUP_INVALIDATED (replacement)",
      event({
        type: "SETUP_INVALIDATED",
        setup: setupFacts({
          lifecycleStatus: "INVALIDATED",
          isReplacement: true,
          replacementZoneLow: 98.5,
          replacementZoneHigh: 101.25,
        }),
      }),
    ],
    [
      "SETUP_DETECTED (unmeasured reward)",
      event({
        type: "SETUP_DETECTED",
        setup: setupFacts({ riskRewardIsSynthetic: true, takeProfit1: null, takeProfit2: null }),
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

  it("gives a time a reader can parse at a glance, and names the zone", () => {
    const text = formatForTelegram(
      event({
        type: "SETUP_INVALIDATED",
        timestamp: Date.parse("2026-09-11T12:34:56.000Z"),
        setup: setupFacts({ invalidationReason: "Support lost on a closed candle." }),
      }),
    );

    // The requirement is the same one this test was written for — a readable
    // time with the zone named, not machine punctuation. Phase K shortened the
    // spelling for a phone: "11 Sep, 12:34 UTC" rather than a leading
    // `2026-09-11`, which reads as an ISO date even once the T is gone.
    expect(text).toContain("11 Sep, 12:34 UTC");
    expect(text).toContain("UTC");
    expect(text).not.toContain("T12:34:56");
    expect(text).not.toMatch(/\d{4}\\-\d{2}\\-\d{2}/);
  });

  it("calls the score quality, never a probability", () => {
    for (const type of ["SETUP_DETECTED", "CONFIRMATION_DETECTED"] as const) {
      const text = formatForTelegram(event({ type }));

      expect(text, type).toMatch(/\*Quality\*: 79\/100/);
      expect(text, type).not.toMatch(/%/);
      expect(text.toLowerCase(), type).not.toContain("probability");
      expect(text.toLowerCase(), type).not.toContain("chance");
    }
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
    // Looked up by name rather than by index, so adding a case above cannot
    // silently point this at a different message.
    const summary = types.find(([name]) => name === "DAILY_SUMMARY")![1];

    expect(formatForTelegram(summary)).toMatch(/normal outcome/i);
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

  /**
   * Telegram answers a flood wait with the number of seconds to wait. Retrying
   * inside that window cannot succeed, and since the dedupe index stops the
   * layer ever trying this event again, the two wasted attempts lose the
   * message outright.
   */
  it("waits as long as Telegram asked before retrying a 429", async () => {
    vi.useFakeTimers();
    withToken("123:FAKE");

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({
          ok: false,
          description: "Too Many Requests: retry after 4",
          parameters: { retry_after: 4 },
        }),
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response);

    const pending = sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });

    // The old backoff would have fired here and hit the same flood wait.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);

    restore();
    vi.useRealTimers();
  });

  it("bounds a flood wait, because the scanner is waiting behind it", async () => {
    vi.useFakeTimers();
    withToken("123:FAKE");

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ ok: false, description: "flood", parameters: { retry_after: 3_600 } }),
      } as unknown as Response)
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      } as unknown as Response);

    const pending = sendTelegramMessage({ chatId: "1", text: "hi", fetchImpl });

    await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_MS);
    const result = await pending;

    expect(result.ok).toBe(true);
    restore();
    vi.useRealTimers();
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

describe("bot identity", () => {
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;

  function restore() {
    resetTelegramIdentityCache();
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }

  it("reports no username when no token is configured", async () => {
    resetTelegramIdentityCache();
    delete process.env.TELEGRAM_BOT_TOKEN;
    const fetchImpl = vi.fn();

    expect(await getTelegramBotUsername({ fetchImpl })).toBeNull();
    // Nothing is asked of Telegram when there is nothing to ask with.
    expect(fetchImpl).not.toHaveBeenCalled();
    restore();
  });

  it("reads the username and asks Telegram only once for it", async () => {
    resetTelegramIdentityCache();
    process.env.TELEGRAM_BOT_TOKEN = "123:token";
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { username: "SpotLensBot" } }),
    } as unknown as Response);

    expect(await getTelegramBotUsername({ fetchImpl })).toBe("SpotLensBot");
    expect(await getTelegramBotUsername({ fetchImpl })).toBe("SpotLensBot");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    restore();
  });

  it("does not cache a failure, so a machine that was offline recovers", async () => {
    resetTelegramIdentityCache();
    process.env.TELEGRAM_BOT_TOKEN = "123:token";
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { username: "SpotLensBot" } }),
      } as unknown as Response);

    expect(await getTelegramBotUsername({ fetchImpl })).toBeNull();
    expect(await getTelegramBotUsername({ fetchImpl })).toBe("SpotLensBot");
    restore();
  });

  it("never lets an identity failure carry the token", async () => {
    resetTelegramIdentityCache();
    process.env.TELEGRAM_BOT_TOKEN = "123:super-secret";
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("failed to fetch https://x/bot123:super-secret/getMe"));

    // The contract is stronger than sanitising: nothing is returned at all.
    expect(await getTelegramBotUsername({ fetchImpl })).toBeNull();
    restore();
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
  it("is quiet out of the box, except for the one message worth reading", () => {
    // Measured across the recorded history: one potential setup in
    // sixty-nine notifications. Defaulting the rarest and most useful event
    // off while the noisiest defaulted on was backwards, and the channel
    // routing — not the preference — is what keeps the volume down.
    expect(DEFAULT_PREFERENCES.setupDetected).toBe(true);

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

/**
 * Phase K: which events are worth interrupting a phone for.
 *
 * The rules read facts the lifecycle already established — whether the engine
 * re-anchored, whether the setup ever confirmed, the engine's own verdict, and
 * whether the reward was measurable. Nothing here re-derives strategy, so these
 * tests are about the routing decision and not about the market.
 */
describe("Telegram routing", () => {
  const cases: [string, Parameters<typeof telegramPriorityFor>[0], "HIGH" | "MEDIUM" | "LOW"][] = [
    [
      "a potential setup is always worth a push",
      { type: "SETUP_DETECTED", setup: setupFacts() },
      "HIGH",
    ],
    [
      "a measured confirmation on a setup the engine has not disqualified",
      { type: "CONFIRMATION_DETECTED", setup: setupFacts() },
      "HIGH",
    ],
    [
      "a confirmation on a high-risk setup stays in the app",
      { type: "CONFIRMATION_DETECTED", setup: setupFacts({ analysisStatus: "HIGH_RISK" }) },
      "LOW",
    ],
    [
      "a confirmation whose reward was never measurable stays in the app",
      { type: "CONFIRMATION_DETECTED", setup: setupFacts({ riskRewardIsSynthetic: true }) },
      "LOW",
    ],
    [
      "a level that had confirmed and then failed is the loudest invalidation",
      { type: "SETUP_INVALIDATED", setup: setupFacts({ everConfirmed: true }) },
      "HIGH",
    ],
    [
      "a level that never got going still reports its failure",
      { type: "SETUP_INVALIDATED", setup: setupFacts({ everConfirmed: false }) },
      "MEDIUM",
    ],
    [
      "a re-anchored setup is bookkeeping, whatever it had reached",
      {
        type: "SETUP_INVALIDATED",
        setup: setupFacts({ isReplacement: true, everConfirmed: true }),
      },
      "LOW",
    ],
    [
      "a structure signal never reaches Telegram",
      { type: "STRUCTURE_CHANGED", setup: setupFacts() },
      "LOW",
    ],
    ["the daily summary is worth one message", { type: "DAILY_SUMMARY", setup: null }, "MEDIUM"],
    ["a scanner failure is worth knowing about", { type: "SYSTEM_ERROR", setup: null }, "HIGH"],
  ];

  it.each(cases)("%s", (_name, facts, expected) => {
    expect(telegramPriorityFor(facts)).toBe(expected);
    expect(isTelegramWorthy(facts)).toBe(expected !== "LOW");
  });

  it("is a pure function of the facts, so the same event always routes the same way", () => {
    const facts = { type: "CONFIRMATION_DETECTED" as const, setup: setupFacts() };

    expect(telegramPriorityFor(facts)).toBe(telegramPriorityFor(facts));
  });

  it("routes on the engine's verdict before the measurement, so both disqualify", () => {
    // Nine of the seventeen confirmations ever sent were high risk, and the
    // levels were printed above the disqualifier. Either condition is enough.
    const both = {
      type: "CONFIRMATION_DETECTED" as const,
      setup: setupFacts({ analysisStatus: "HIGH_RISK", riskRewardIsSynthetic: true }),
    };

    expect(telegramPriorityFor(both)).toBe("LOW");
  });
});

describe("confirmation evidence is not confirmation", () => {
  const text = () => formatForTelegram(event({ type: "CONFIRMATION_DETECTED" }));

  it("never announces a confirmation as though the setup were approved", () => {
    const message = text().toLowerCase();

    // The exact contradiction the audit found: a headline claiming detection
    // sitting above a status line denying it.
    expect(message).not.toContain("confirmation detected");
    expect(message).toContain("confirmation evidence");
    expect(message).toContain("has not been promoted");
    expect(message).toContain("evidence is not approval");
  });

  it("separates what this transition proves from what was frozen at creation", () => {
    const message = text();

    // "Held at" is the fact reaching this lifecycle state establishes: the
    // engine found its evidence and still did not promote the setup.
    expect(message).toMatch(/\*HELD AT\*/);
    // "At creation" is TrackedSetup.analysisStatus, which is written once and
    // never updated — labelled as historical rather than presented as current.
    expect(message).toMatch(/\*AT CREATION\*/);
  });

  it("does not print a bare status line that reads as a denial of the title", () => {
    // The old message said "Status: wait for confirmation" with no indication
    // that the value was a snapshot from creation time.
    expect(text()).not.toMatch(/\*Status\*:/);
  });

  it("groups missing evidence apart from evidence that is present", () => {
    const thinVolume = {
      type: "VOLUME_CONFIRMATION",
      signal: "negative",
      title: "Volume is too thin to confirm",
      detail: "d",
    };

    const message = formatForTelegram(
      event({
        type: "CONFIRMATION_DETECTED",
        setup: setupFacts({ confirmationSignals: [SIGNALS.higherLow, thinVolume] }),
      }),
    );

    const present = message.indexOf("✓ A higher low has formed");
    const notYet = message.indexOf("*Not yet*");
    const volume = message.indexOf("Volume is too thin");

    expect(present).toBeGreaterThan(-1);
    // Thin volume is an absence, not a refutation — it belongs under "not yet"
    // rather than as a ✕ beneath a heading implying it contradicts anything.
    expect(notYet).toBeGreaterThan(present);
    expect(volume).toBeGreaterThan(notYet);
    expect(message).not.toContain("✕ Volume is too thin to confirm");
  });

  it("marks a primary signal firing against the setup as opposing, not missing", () => {
    const message = formatForTelegram(
      event({
        type: "CONFIRMATION_DETECTED",
        setup: setupFacts({ confirmationSignals: [SIGNALS.supportLost] }),
      }),
    );

    expect(message).toContain("*Against*");
    expect(message).toContain("✕ Support has been lost");
  });
});

describe("a replacement is not an invalidation", () => {
  const replacement = event({
    type: "SETUP_INVALIDATED",
    setup: setupFacts({
      lifecycleStatus: "INVALIDATED",
      isReplacement: true,
      replacementZoneLow: 98.5,
      replacementZoneHigh: 101.25,
      invalidationReason: "The entry no longer rests on this level.",
    }),
  });

  const genuine = event({
    type: "SETUP_INVALIDATED",
    setup: setupFacts({
      lifecycleStatus: "INVALIDATED",
      previousStatus: "CONFIRMATION_DETECTED",
      everConfirmed: true,
      invalidationReason: "Support has been lost at 100 – 104.",
    }),
  });

  it("never dresses a re-anchoring as a failed premise", () => {
    const message = formatForTelegram(replacement);

    expect(message).toContain("re\\-anchored");
    expect(message).not.toContain("Setup invalidated");
    expect(message).toContain("Nothing about the market invalidated it");
  });

  it("names both zones, so the reader does not have to go and look", () => {
    const message = formatForTelegram(replacement);

    expect(message).toContain("*Previous zone*");
    expect(message).toContain("*New zone*");
    expect(message).toContain("98\\.5");
    expect(message).toContain("101\\.25");
  });

  it("says what it can when the replacement zone was not recorded", () => {
    const message = formatForTelegram(
      event({
        type: "SETUP_INVALIDATED",
        setup: setupFacts({ isReplacement: true }),
      }),
    );

    expect(message).toContain("*New zone*");
    expect(message).not.toContain("NaN");
    expect(message).not.toContain("undefined");
  });

  it("still reports a genuine invalidation as one", () => {
    const message = formatForTelegram(genuine);

    expect(message).toContain("*Setup invalidated*");
    expect(message).toContain("Support has been lost");
    expect(message).not.toContain("re\\-anchored");
  });

  it("routes them to different channels", () => {
    expect(isTelegramWorthy(replacement)).toBe(false);
    expect(isTelegramWorthy(genuine)).toBe(true);
  });

  it("shows the reader words rather than database enums", () => {
    const message = formatForTelegram(genuine);

    expect(message).toContain("Confirmation evidence present");
    for (const leaked of [
      "CONFIRMATION_DETECTED",
      "WAITING_CONFIRMATION",
      "SETUP_FORMING",
      "WAIT_FOR_CONFIRMATION",
      "HIGH_RISK",
    ]) {
      expect(message, `leaked ${leaked}`).not.toContain(leaked);
    }
  });
});

describe("a structure signal on a setup being seen for the first time", () => {
  // The exact case both structure messages in the recorded history were: a
  // CREATED event with no prior state, carrying a positive structural signal.
  const creation = {
    lifecycleStatus: "WAITING_CONFIRMATION" as const,
    confirmationSignals: [SIGNALS.breakUp],
  };

  it("is still recorded, because the database keeps everything", () => {
    expect(eventTypeForTransition(creation)).toBe("STRUCTURE_CHANGED");
  });

  it("never reaches Telegram", () => {
    expect(
      isTelegramWorthy({
        type: "STRUCTURE_CHANGED",
        setup: setupFacts({ previousStatus: null, confirmationSignals: [SIGNALS.breakUp] }),
      }),
    ).toBe(false);
  });

  it("is called a signal rather than a change, in-app and on Telegram alike", () => {
    const facts = setupFacts({ previousStatus: null, confirmationSignals: [SIGNALS.breakUp] });

    expect(renderInApp(event({ type: "STRUCTURE_CHANGED", setup: facts })).title).toContain(
      "Structure signal",
    );
    expect(formatForTelegram(event({ type: "STRUCTURE_CHANGED", setup: facts }))).toContain(
      "*Structure signal*",
    );
  });
});

describe("human-facing presentation", () => {
  it("gives every event type the approved title", () => {
    expect(TELEGRAM_TITLES).toEqual({
      SETUP_DETECTED: "🟢 Potential setup",
      CONFIRMATION_DETECTED: "🔵 Confirmation evidence",
      SETUP_INVALIDATED: "🔴 Setup invalidated",
      STRUCTURE_CHANGED: "🟠 Structure signal",
      DAILY_SUMMARY: "📊 Daily summary",
      SYSTEM_ERROR: "⚠️ Scanner error",
    });
    expect(REPLACEMENT_TITLE).toBe("🔄 Setup re-anchored");
  });

  it("prints a time a person can read, from the event rather than a clock", () => {
    const at = Date.UTC(2026, 8, 12, 13, 55, 41, 247);
    const message = formatForTelegram(
      event({
        type: "SETUP_INVALIDATED",
        timestamp: at,
        setup: setupFacts({ lifecycleStatus: "INVALIDATED" }),
      }),
    );

    expect(message).toContain("12 Sep, 13:55 UTC");
    // The raw ISO string the old message printed, millisecond precision and all.
    expect(message).not.toContain("2026\\-09\\-12T13:55:41");
  });

  it("renders the same event identically however many times it is formatted", () => {
    const e = event({ type: "SETUP_DETECTED" });

    expect(formatForTelegram(e)).toBe(formatForTelegram(e));
  });

  it("does not print the support zone twice under two headings", () => {
    // entry.low === sourceZone.low in the engine, so the old message showed the
    // identical pair as both "Entry zone" and "Support".
    const message = formatForTelegram(event({ type: "SETUP_DETECTED" }));

    expect(message).toContain("*ENTRY*");
    expect(message).not.toMatch(/\*Support\*/);
  });

  it("refuses to print an unmeasured reward as a ratio", () => {
    const message = formatForTelegram(
      event({
        type: "SETUP_DETECTED",
        setup: setupFacts({ riskRewardIsSynthetic: true, riskReward: 2.5 }),
      }),
    );

    expect(message).toContain("not measurable");
    expect(message).not.toMatch(/1:2\\\\.5/);
  });
});

describe("no database enum reaches a reader", () => {
  it("names the scanner failure category in words, in-app too", () => {
    const rendered = renderInApp(
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
    );

    expect(rendered.title).not.toContain("MARKET_DATA_ERROR");
    expect(rendered.title).toContain("market data error");
  });

  it("falls back to words for a value no label table knows", () => {
    // A status added later, or a row written by an older version, must still
    // read as English rather than as SNAKE_CASE.
    const message = formatForTelegram(
      event({
        type: "SETUP_INVALIDATED",
        setup: setupFacts({
          lifecycleStatus: "INVALIDATED",
          previousStatus: "SOMETHING_NEW" as never,
        }),
      }),
    );

    expect(message).not.toContain("SOMETHING_NEW");
    expect(message).toContain("Something new");
  });
});

/**
 * A re-anchored setup and a failed one are both SETUP_INVALIDATED, and the
 * stored row carries no flag that separates them. The tone has to come from
 * what the renderer wrote, or the list paints bookkeeping in the failure colour
 * and tells the reader a level broke when none did.
 */
describe("in-app tone", () => {
  const replacement = event({
    type: "SETUP_INVALIDATED",
    setup: setupFacts({
      lifecycleStatus: "INVALIDATED",
      isReplacement: true,
      replacementZoneLow: 98.5,
      replacementZoneHigh: 101.25,
    }),
  });

  const genuine = event({
    type: "SETUP_INVALIDATED",
    setup: setupFacts({ lifecycleStatus: "INVALIDATED" }),
  });

  it("never gives a re-anchored setup the tone of a failed one", () => {
    const row = { type: replacement.type, ...renderInApp(replacement) };

    expect(toneForNotification(row)).toBe("NEUTRAL");
    expect(toneForNotification(row)).not.toBe(
      toneForNotification({
        type: genuine.type,
        ...renderInApp(genuine),
      }),
    );
  });

  it("still marks a genuine invalidation as one", () => {
    expect(toneForNotification({ type: genuine.type, ...renderInApp(genuine) })).toBe("NEGATIVE");
  });

  it.each([
    ["SETUP_DETECTED", "POSITIVE"],
    ["CONFIRMATION_DETECTED", "INFO"],
    ["STRUCTURE_CHANGED", "WARNING"],
    ["DAILY_SUMMARY", "NEUTRAL"],
    ["SYSTEM_ERROR", "NEGATIVE"],
  ] as const)("gives %s the %s tone", (type, tone) => {
    const e = event({
      type,
      setup: type === "DAILY_SUMMARY" || type === "SYSTEM_ERROR" ? null : setupFacts(),
      summary:
        type === "DAILY_SUMMARY"
          ? {
              date: "2026-09-12",
              runs: 1,
              marketsScanned: 45,
              analysesByTimeframe: [],
              potentialSetups: 0,
              waiting: 0,
              highRisk: 0,
              avoided: 0,
              failures: 0,
              setupsCreated: 0,
              confirmations: 0,
              invalidations: 0,
              topRanked: [],
            }
          : null,
      systemError:
        type === "SYSTEM_ERROR"
          ? {
              category: "MARKET_DATA_ERROR",
              symbol: "BTCUSDT",
              timeframe: "H1",
              message: "TIMEOUT",
              affectedMarkets: 1,
            }
          : null,
    });

    expect(toneForNotification({ type, ...renderInApp(e) })).toBe(tone);
  });

  it("falls back to the event type for a row written before the markers existed", () => {
    // The 166 rows already in the database have no marker, and none of them was
    // ever distinguished as a replacement, so the type is the right answer.
    expect(
      toneForNotification({ type: "SETUP_INVALIDATED", title: "Setup invalidated — BTCUSDT H1" }),
    ).toBe("NEGATIVE");
    expect(
      toneForNotification({ type: "SETUP_DETECTED", title: "Potential setup — BTCUSDT H1" }),
    ).toBe("POSITIVE");
  });

  it("opens every in-app title with a marker the tone lookup recognises", () => {
    const markers = Object.values(IN_APP_MARKERS);

    for (const type of [
      "SETUP_DETECTED",
      "CONFIRMATION_DETECTED",
      "SETUP_INVALIDATED",
      "STRUCTURE_CHANGED",
    ] as const) {
      const title = renderInApp(event({ type })).title;
      expect(
        markers.some((m) => title.startsWith(m)),
        `${type}: ${title}`,
      ).toBe(true);
    }

    // And the replacement, which is the one the type cannot express.
    expect(renderInApp(replacement).title.startsWith(IN_APP_MARKERS.reAnchored)).toBe(true);
  });
});
