import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getTelegramBotUsername,
  getTelegramUpdates,
  isTelegramConfigured,
  resetTelegramIdentityCache,
  sendTelegramMessage,
  tokenVariableFor,
} from "./telegram-provider";

/**
 * Two tokens in one file, and neither may ever escape it.
 *
 * The reason the two bots share a provider is that a token scrubber which
 * exists twice is one that will eventually only strip one of them. These tests
 * are what make that argument true rather than merely plausible: every one of
 * them asserts on the *other* bot's token as well as its own.
 */

const MAIN_TOKEN = "111111:MAIN-TOKEN-AAAAAAAAAAAAAAAAAAAAAAA";
const CONFIRM_TOKEN = "222222:CONFIRMATION-TOKEN-BBBBBBBBBBBBBBB";

beforeEach(() => {
  resetTelegramIdentityCache();
  process.env.TELEGRAM_BOT_TOKEN = MAIN_TOKEN;
  process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN = CONFIRM_TOKEN;
});

afterEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN;
  resetTelegramIdentityCache();
});

/** The URL each call was made to, so the token in it can be checked. */
function urlOf(fetchImpl: ReturnType<typeof vi.fn>): string {
  return String(fetchImpl.mock.calls[0][0]);
}

describe("each bot uses its own token", () => {
  it("sends through the main token by default", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await sendTelegramMessage({ chatId: "1", text: "hello", fetchImpl });

    expect(urlOf(fetchImpl)).toContain(MAIN_TOKEN);
    expect(urlOf(fetchImpl)).not.toContain(CONFIRM_TOKEN);
  });

  it("sends through the confirmation token when asked for that bot", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

    await sendTelegramMessage({
      chatId: "1",
      text: "hello",
      bot: "CONFIRMATION",
      fetchImpl,
    });

    expect(urlOf(fetchImpl)).toContain(CONFIRM_TOKEN);
    expect(urlOf(fetchImpl)).not.toContain(MAIN_TOKEN);
  });

  it("polls each bot's own update queue with its own token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: [] }) });

    await getTelegramUpdates({ bot: "CONFIRMATION", fetchImpl });

    expect(urlOf(fetchImpl)).toContain(CONFIRM_TOKEN);
  });

  it("caches each bot's username separately", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { username: "SpotLensBot" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { username: "SpotLensConfirmBot" } }),
      });

    expect(await getTelegramBotUsername({ fetchImpl })).toBe("SpotLensBot");
    expect(await getTelegramBotUsername({ bot: "CONFIRMATION", fetchImpl })).toBe(
      "SpotLensConfirmBot",
    );
    // Cached: a second ask makes no third request, and does not return the
    // other bot's name.
    expect(await getTelegramBotUsername({ fetchImpl })).toBe("SpotLensBot");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("a missing token fails safely", () => {
  it("reports the confirmation bot unconfigured without touching the main one", () => {
    delete process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN;

    expect(isTelegramConfigured("CONFIRMATION")).toBe(false);
    expect(isTelegramConfigured("MAIN")).toBe(true);
  });

  it("treats a blank value as unset rather than as a token", () => {
    process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN = "   ";
    expect(isTelegramConfigured("CONFIRMATION")).toBe(false);
  });

  it("returns a result instead of throwing when the token is missing", async () => {
    delete process.env.TELEGRAM_CONFIRMATION_BOT_TOKEN;

    const result = await sendTelegramMessage({
      chatId: "1",
      text: "hello",
      bot: "CONFIRMATION",
    });

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.attempts).toBe(0);
    // Names the variable an operator has to set. "Add TELEGRAM_BOT_TOKEN" would
    // be advice that cannot work, now that there are two.
    expect(result.error).toContain("TELEGRAM_CONFIRMATION_BOT_TOKEN");
  });

  it("names the right variable for each bot", () => {
    expect(tokenVariableFor("MAIN")).toBe("TELEGRAM_BOT_TOKEN");
    expect(tokenVariableFor("CONFIRMATION")).toBe("TELEGRAM_CONFIRMATION_BOT_TOKEN");
  });
});

describe("no token reaches a caller", () => {
  it("strips both tokens from an error raised on either bot's request", async () => {
    // The case a per-bot scrubber would miss: an error on the confirmation
    // bot's request that happens to quote the main bot's URL.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        ok: false,
        description: `bad request to bot${MAIN_TOKEN} from bot${CONFIRM_TOKEN}`,
      }),
    });

    const result = await sendTelegramMessage({
      chatId: "1",
      text: "hello",
      bot: "CONFIRMATION",
      fetchImpl,
    });

    expect(result.error).not.toContain(MAIN_TOKEN);
    expect(result.error).not.toContain(CONFIRM_TOKEN);
    expect(result.error).toContain("redacted");
  });

  it("strips a token from a thrown network error too", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`connect failed: bot${CONFIRM_TOKEN}`));

    const result = await sendTelegramMessage({
      chatId: "1",
      text: "hello",
      bot: "CONFIRMATION",
      fetchImpl,
    });

    expect(result.error).not.toContain(CONFIRM_TOKEN);
  });

  it("says nothing at all when a username lookup fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error(`boom bot${CONFIRM_TOKEN}`));

    // Returning null rather than an error is deliberate: the caller only needs
    // to know whether a link can be built, and the error text here is the one
    // place a request URL could surface.
    expect(await getTelegramBotUsername({ bot: "CONFIRMATION", fetchImpl })).toBeNull();
  });
});

describe("the retry policy is shared, and unchanged", () => {
  it("retries a 5xx on the confirmation bot the same way it does on the main one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ ok: false }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const result = await sendTelegramMessage({
      chatId: "1",
      text: "hello",
      bot: "CONFIRMATION",
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("does not retry a 400, which would fail identically forever", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false }) });

    const result = await sendTelegramMessage({
      chatId: "1",
      text: "hello",
      bot: "CONFIRMATION",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it("honours a flood wait the confirmation bot is asked for", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ ok: false, parameters: { retry_after: 2 } }),
    });

    const result = await sendTelegramMessage({
      chatId: "1",
      text: "hello",
      bot: "CONFIRMATION",
      fetchImpl,
    });

    expect(result.retryAfterMs).toBe(2000);
    expect(result.retryable).toBe(true);
  });
});
