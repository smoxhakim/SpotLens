import { sleep } from "@/lib/scanner";

/**
 * Telegram delivery.
 *
 * The only place in the codebase that reads `TELEGRAM_BOT_TOKEN`. It is read
 * from the environment at call time and never returned, logged, stored, or put
 * in an error message — a token that reaches a database is a token in every
 * backup of it, and one that reaches a log is a token in every log shipper.
 *
 * There are no trading commands here and no way to add one: this module can
 * send a message and read updates, and that is the whole surface.
 */

const API_BASE = "https://api.telegram.org";
const REQUEST_TIMEOUT_MS = 10_000;

/** One attempt, then two more. Enough for a blip, short of a retry storm. */
export const MAX_SEND_ATTEMPTS = 3;
export const SEND_RETRY_BASE_MS = 500;

export interface TelegramSendResult {
  ok: boolean;
  /** Sanitised — safe to store on the notification row. */
  error: string | null;
  /** Whether trying again could plausibly work. */
  retryable: boolean;
  attempts: number;
}

export interface TelegramUpdate {
  updateId: number;
  chatId: string;
  chatLabel: string | null;
  text: string;
}

/** Present only when a token is configured. Never reveals the token itself. */
export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

/**
 * A message, with bounded retries.
 *
 * Never throws. A notification channel that can take down its caller is worse
 * than no channel, and this one is called from the scanner process.
 */
export async function sendTelegramMessage(input: {
  chatId: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return {
      ok: false,
      error: "Telegram is not configured on this machine (TELEGRAM_BOT_TOKEN is unset).",
      retryable: false,
      attempts: 0,
    };
  }

  let last: TelegramSendResult = {
    ok: false,
    error: "No attempt was made.",
    retryable: false,
    attempts: 0,
  };

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    last = { ...(await attemptSend(token, input)), attempts: attempt };

    if (last.ok || !last.retryable || attempt === MAX_SEND_ATTEMPTS) return last;

    await sleep(SEND_RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  return last;
}

async function attemptSend(
  token: string,
  input: { chatId: string; text: string; fetchImpl?: typeof fetch },
): Promise<Omit<TelegramSendResult, "attempts">> {
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await doFetch(`${API_BASE}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        text: input.text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      error_code?: number;
    } | null;

    if (response.ok && body?.ok) return { ok: true, error: null, retryable: false };

    // 429 and 5xx are worth another go; a 400 means the message itself is
    // wrong — usually an escaping bug — and will fail identically forever.
    const status = response.status;
    const retryable = status === 429 || status >= 500;

    return {
      ok: false,
      error: sanitise(`Telegram ${status}: ${body?.description ?? "no description"}`, token),
      retryable,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      error: sanitise(aborted ? "Telegram request timed out." : describeError(error), token),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads pending updates for the bot.
 *
 * Used only by the connection flow, to find the code a user sent the bot. The
 * offset makes Telegram drop everything already seen, so a poll cannot re-read
 * an old message and re-bind an account.
 */
export async function getTelegramUpdates(input: {
  offset?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; updates: TelegramUpdate[]; error: string | null }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, updates: [], error: "Telegram is not configured on this machine." };
  }

  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = new URL(`${API_BASE}/bot${token}/getUpdates`);
    url.searchParams.set("timeout", "0");
    url.searchParams.set("allowed_updates", JSON.stringify(["message"]));
    if (input.offset !== undefined) url.searchParams.set("offset", String(input.offset));

    const response = await doFetch(url.toString(), { signal: controller.signal });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    } | null;

    if (!response.ok || !body?.ok) {
      return {
        ok: false,
        updates: [],
        error: sanitise(`Telegram ${response.status}: ${body?.description ?? "unknown"}`, token),
      };
    }

    return { ok: true, updates: parseUpdates(body.result), error: null };
  } catch (error) {
    return { ok: false, updates: [], error: sanitise(describeError(error), token) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads only what is needed out of whatever Telegram sent.
 *
 * Defensive on purpose: this is untrusted input from outside the process, so
 * every field is checked rather than assumed, and anything unrecognised is
 * skipped instead of throwing.
 */
export function parseUpdates(result: unknown): TelegramUpdate[] {
  if (!Array.isArray(result)) return [];

  const updates: TelegramUpdate[] = [];

  for (const raw of result) {
    if (typeof raw !== "object" || raw === null) continue;

    const update = raw as {
      update_id?: unknown;
      message?: {
        text?: unknown;
        chat?: { id?: unknown; username?: unknown; first_name?: unknown };
      };
    };

    const updateId = update.update_id;
    const chatId = update.message?.chat?.id;
    const text = update.message?.text;

    if (typeof updateId !== "number") continue;
    if (typeof chatId !== "number" && typeof chatId !== "string") continue;
    if (typeof text !== "string") continue;

    const username = update.message?.chat?.username;
    const firstName = update.message?.chat?.first_name;

    updates.push({
      updateId,
      chatId: String(chatId),
      chatLabel:
        typeof username === "string"
          ? `@${username}`
          : typeof firstName === "string"
            ? firstName
            : null,
      // Bounded: a chat message is attacker-controlled, and nothing downstream
      // needs more than a connection code's worth of it.
      text: text.slice(0, 200),
    });
  }

  return updates;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown Telegram error.";
}

/**
 * Last line of defence.
 *
 * The token is interpolated into every request URL, so any error text that
 * quotes a URL could carry it. This removes it explicitly rather than trusting
 * that no library ever echoes the request back.
 */
function sanitise(message: string, token: string): string {
  return message
    .split(token)
    .join("[redacted]")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
