import { describe, expect, it } from "vitest";

import { parseBotParam, telegramBotSchema } from "@/lib/api/telegram-bot-param";
import { DEFAULT_PREFERENCES } from "@/lib/notifications";

/**
 * The contract every Telegram route shares.
 *
 * One parser, so the two bots cannot drift apart on what an acceptable value
 * is — and so a typo in the confirmation UI is refused rather than quietly
 * reconnecting the main channel, which is the failure that would be hardest to
 * notice from the outside.
 */
describe("the bot parameter", () => {
  it("defaults to the main bot when absent, so every existing caller is unchanged", () => {
    expect(parseBotParam(null)).toBe("MAIN");
    expect(parseBotParam(undefined)).toBe("MAIN");
    expect(parseBotParam("")).toBe("MAIN");
  });

  it("accepts the two bots", () => {
    expect(parseBotParam("MAIN")).toBe("MAIN");
    expect(parseBotParam("CONFIRMATION")).toBe("CONFIRMATION");
  });

  it("refuses anything else rather than falling back to the main bot", () => {
    // A silent fallback would mean a mistyped confirmation link rebinding the
    // channel the user did not ask about.
    for (const value of ["confirmation", "Main", "TELEGRAM", "CONFIRM", "../MAIN", "1"]) {
      expect(parseBotParam(value), value).toBeNull();
    }
  });

  it("is case-sensitive, matching the database enum exactly", () => {
    expect(telegramBotSchema.safeParse("main").success).toBe(false);
    expect(telegramBotSchema.safeParse("MAIN").success).toBe(true);
  });
});

describe("the preferences contract", () => {
  it("carries a switch for confirmation alerts", () => {
    expect(DEFAULT_PREFERENCES).toHaveProperty("confirmationAlerts");
  });

  it("defaults it on, because connecting the bot is the opt-in", () => {
    // Unlike `telegramEnabled`, which defaults off: these only reach a bot the
    // user had to create with BotFather and connect on purpose.
    expect(DEFAULT_PREFERENCES.confirmationAlerts).toBe(true);
    expect(DEFAULT_PREFERENCES.telegramEnabled).toBe(false);
  });
});
