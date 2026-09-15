import { z } from "zod";

import type { TelegramBot } from "@/lib/notifications";

/**
 * Which bot a Telegram route is about.
 *
 * One schema, used by every Telegram route, so the two bots cannot drift apart
 * on what an acceptable value is. Absent means MAIN: every existing caller —
 * and the whole main-bot flow — keeps working without sending anything new, and
 * an unrecognised value is refused rather than quietly treated as the main bot,
 * which would let a typo in the confirmation UI reconnect the wrong channel.
 */
export const telegramBotSchema = z.enum(["MAIN", "CONFIRMATION"]);

export function parseBotParam(value: string | null | undefined): TelegramBot | null {
  if (value === null || value === undefined || value === "") return "MAIN";
  const parsed = telegramBotSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
