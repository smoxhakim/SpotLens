import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";
import type { Timeframe } from "@/lib/market-data/provider";
import { formatConfirmationConnectionTest } from "@/lib/confirmation-watch";
import {
  DEFAULT_PREFERENCES,
  EVENT_PRIORITY,
  PREFERENCE_FOR_EVENT,
  formatConnectionTest,
  formatForTelegram,
  getTelegramBotUsername,
  getTelegramUpdates,
  isTelegramConfigured,
  isTelegramWorthy,
  renderInApp,
  sendTelegramMessage,
  tokenVariableFor,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationPreferences,
  type TelegramBot,
} from "@/lib/notifications";

/**
 * Delivery.
 *
 * The service decides three things and nothing else: whether the user asked for
 * this event, whether it has already been sent, and which channels to try.
 * What happened is the scanner's business, and how it reads is the formatter's.
 *
 * Nothing here throws. It is called from inside the scanner process, and a
 * notification layer that can abort a scan is worse than no notification layer.
 */

export interface DeliveryOutcome {
  created: number;
  sent: number;
  failed: number;
  suppressed: number;
  duplicates: number;
  /**
   * Events recorded and delivered in-app, but deliberately not pushed to
   * Telegram. Counted separately from `suppressed` because nothing was
   * suppressed — the event exists, the row exists, the user can read it. Only
   * the interruption was withheld.
   */
  telegramWithheld: number;
}

const NOTHING: DeliveryOutcome = {
  created: 0,
  sent: 0,
  failed: 0,
  suppressed: 0,
  duplicates: 0,
  telegramWithheld: 0,
};

/**
 * Routes a batch of events.
 *
 * Sequential rather than parallel: a scan can produce dozens of events, and
 * Telegram rate-limits per chat. Waiting is free here — nothing downstream is
 * blocked on it.
 */
export async function deliverEvents(events: NotificationEvent[]): Promise<DeliveryOutcome> {
  if (!isDatabaseConfigured || events.length === 0) return NOTHING;

  const totals = { ...NOTHING };

  for (const event of events) {
    const outcome = await deliverOne(event);
    totals.created += outcome.created;
    totals.sent += outcome.sent;
    totals.failed += outcome.failed;
    totals.suppressed += outcome.suppressed;
    totals.duplicates += outcome.duplicates;
    totals.telegramWithheld += outcome.telegramWithheld;
  }

  return totals;
}

async function deliverOne(event: NotificationEvent): Promise<DeliveryOutcome> {
  try {
    const prefs = await getPreferences(event.userId);

    // Wanted at all? The per-event switch is checked before the channels, so
    // turning an event type off silences it everywhere at once.
    if (!prefs[PREFERENCE_FOR_EVENT[event.type]]) {
      return { ...NOTHING, suppressed: 1 };
    }

    const channels: NotificationChannel[] = [];
    if (prefs.inAppEnabled) channels.push("IN_APP");

    // The second gate, and the only one that is per-channel: in-app keeps the
    // whole stream, Telegram gets the subset worth interrupting a phone for.
    // Whatever is withheld here is still recorded and still readable in the
    // app — this decides delivery, never recording.
    const worthPushing = isTelegramWorthy(event);
    if (prefs.telegramEnabled && worthPushing) channels.push("TELEGRAM");

    const withheld = prefs.telegramEnabled && !worthPushing ? 1 : 0;

    if (channels.length === 0) return { ...NOTHING, suppressed: 1, telegramWithheld: withheld };

    const totals = { ...NOTHING, telegramWithheld: withheld };

    for (const channel of channels) {
      const outcome = await deliverToChannel(event, channel);
      totals.created += outcome.created;
      totals.sent += outcome.sent;
      totals.failed += outcome.failed;
      totals.duplicates += outcome.duplicates;
    }

    return totals;
  } catch (err) {
    warnOnce("notifications:deliver", "[notifications] could not deliver an event.", err);
    return NOTHING;
  }
}

/**
 * One event on one channel.
 *
 * The row is written first, then delivery is attempted. That ordering is what
 * makes the layer idempotent: the unique index on
 * `(userId, channel, dedupeKey)` rejects a second insert for the same lifecycle
 * transition, so a re-observed setup cannot notify twice however many times the
 * scanner sees it.
 */
async function deliverToChannel(
  event: NotificationEvent,
  channel: NotificationChannel,
): Promise<DeliveryOutcome> {
  const { title, body } = renderInApp(event);

  let notificationId: string;

  try {
    const row = await prisma.notification.create({
      data: {
        userId: event.userId,
        type: event.type,
        channel,
        priority: EVENT_PRIORITY[event.type],
        status: channel === "IN_APP" ? "SENT" : "PENDING",
        sentAt: channel === "IN_APP" ? new Date() : null,
        title,
        body,
        trackedSetupId: event.setup?.setupId ?? null,
        asset: event.asset,
        timeframe: event.timeframe,
        dedupeKey: event.dedupeKey,
      },
      select: { id: true },
    });
    notificationId = row.id;
  } catch (err) {
    // P2002 is the unique index doing its job — the event was already
    // delivered on this channel. Any other failure is a real problem.
    if (isUniqueViolation(err)) return { ...NOTHING, duplicates: 1 };
    throw err;
  }

  // In-app needs no delivery step: the row *is* the notification.
  if (channel === "IN_APP") return { ...NOTHING, created: 1, sent: 1 };

  const result = await sendToTelegram(event.userId, formatForTelegram(event));

  await prisma.notification.update({
    where: { id: notificationId },
    data: {
      status: result.ok ? "SENT" : "FAILED",
      sentAt: result.ok ? new Date() : null,
      attempts: result.attempts,
      error: result.ok ? null : result.error,
    },
  });

  return { ...NOTHING, created: 1, sent: result.ok ? 1 : 0, failed: result.ok ? 0 : 1 };
}

/**
 * The main bot, named explicitly.
 *
 * `deliverEvents` is the lifecycle path and only ever speaks to MAIN.
 * Confirmation traffic has its own service, its own channel and its own bot,
 * and there is deliberately no parameter here that could send it down this one.
 */
async function sendToTelegram(userId: string, text: string) {
  const connection = await findConnection(userId, "MAIN");

  if (!connection?.chatId) {
    return {
      ok: false,
      error: "Telegram is not connected for this account.",
      retryable: false,
      attempts: 0,
    };
  }

  return sendTelegramMessage({ chatId: connection.chatId, text, bot: "MAIN" });
}

/** One binding, by owner and bot. The composite key is the whole lookup. */
function findConnection(userId: string, bot: TelegramBot) {
  return prisma.telegramConnection.findUnique({
    where: { userId_bot: { userId, bot } },
    select: { chatId: true },
  });
}

// --- preferences -----------------------------------------------------------

/** A user's settings, falling back to the conservative defaults. */
export async function getPreferences(userId: string): Promise<NotificationPreferences> {
  const row = await prisma.notificationPreference.findUnique({ where: { userId } });
  if (!row) return DEFAULT_PREFERENCES;

  return {
    inAppEnabled: row.inAppEnabled,
    telegramEnabled: row.telegramEnabled,
    setupDetected: row.setupDetected,
    confirmationDetected: row.confirmationDetected,
    setupInvalidated: row.setupInvalidated,
    structureChanged: row.structureChanged,
    dailySummary: row.dailySummary,
    systemError: row.systemError,
    confirmationAlerts: row.confirmationAlerts,
  };
}

export async function updatePreferences(
  userId: string,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const row = await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...DEFAULT_PREFERENCES, ...patch },
    update: patch,
  });

  return {
    inAppEnabled: row.inAppEnabled,
    telegramEnabled: row.telegramEnabled,
    setupDetected: row.setupDetected,
    confirmationDetected: row.confirmationDetected,
    setupInvalidated: row.setupInvalidated,
    structureChanged: row.structureChanged,
    dailySummary: row.dailySummary,
    systemError: row.systemError,
    confirmationAlerts: row.confirmationAlerts,
  };
}

// --- Telegram connection ---------------------------------------------------

/** How long a connection code is good for. Long enough to open Telegram. */
export const CONNECTION_CODE_TTL_MS = 10 * 60_000;
/**
 * Wrong codes before the current one is burned, so guessing is bounded.
 *
 * Counted per *guess* — a message sent to the bot that carried something
 * code-shaped and wrong — and never per poll. Settings polls this flow every
 * few seconds while the code is on screen, and counting those would burn the
 * code roughly thirty seconds into a ten-minute window, before the user has
 * finished switching to Telegram. The bound that matters is on what an
 * attacker can send the bot, which is what this counts.
 */
export const MAX_CLAIM_ATTEMPTS = 10;

/**
 * Starts a connection.
 *
 * The code is returned once, to the authenticated caller, and only its SHA-256
 * is stored. Anyone with read access to the table therefore cannot bind their
 * own chat to someone else's account.
 */
export async function beginTelegramConnection(
  userId: string,
  bot: TelegramBot = "MAIN",
): Promise<{ code: string }> {
  // 32 bits of entropy in an unambiguous alphabet — no O/0 or I/1 — because
  // this gets retyped into a phone. Guessing is bounded by MAX_CLAIM_ATTEMPTS
  // and a ten-minute window, not by length alone.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");

  await prisma.telegramConnection.upsert({
    where: { userId_bot: { userId, bot } },
    create: {
      userId,
      bot,
      pendingCodeHash: hash(code),
      pendingExpires: new Date(Date.now() + CONNECTION_CODE_TTL_MS),
      claimAttempts: 0,
    },
    update: {
      pendingCodeHash: hash(code),
      pendingExpires: new Date(Date.now() + CONNECTION_CODE_TTL_MS),
      claimAttempts: 0,
    },
  });

  return { code };
}

export type ClaimResult =
  | { status: "CONNECTED"; chatLabel: string | null }
  | { status: "PENDING" }
  | { status: "EXPIRED" }
  | { status: "NO_CODE" }
  | { status: "TOO_MANY_ATTEMPTS" }
  | { status: "UNAVAILABLE"; error: string };

/**
 * Looks for the code in the bot's recent messages and binds the chat.
 *
 * Polling rather than a webhook: SpotLens is local-only, so a webhook would
 * mean exposing this machine to the internet to receive a message the user is
 * about to send anyway.
 *
 * The comparison is constant-time on the hash. A code is short enough to retype
 * that a timing side channel is worth closing even though the window is small.
 */
export async function claimTelegramConnection(
  userId: string,
  bot: TelegramBot = "MAIN",
): Promise<ClaimResult> {
  const connection = await prisma.telegramConnection.findUnique({
    where: { userId_bot: { userId, bot } },
  });

  if (!connection?.pendingCodeHash || !connection.pendingExpires) return { status: "NO_CODE" };

  if (connection.pendingExpires.getTime() < Date.now()) {
    await clearPendingCode(userId, bot);
    return { status: "EXPIRED" };
  }

  if (connection.claimAttempts >= MAX_CLAIM_ATTEMPTS) {
    await clearPendingCode(userId, bot);
    return { status: "TOO_MANY_ATTEMPTS" };
  }

  // The cursor is per bot. Each has its own update queue, so polling one with
  // the other's offset would either re-read old messages or skip the one the
  // user just sent.
  const offset = connection.lastUpdateId === null ? undefined : Number(connection.lastUpdateId) + 1;
  const updates = await getTelegramUpdates({ offset, bot });

  if (!updates.ok)
    return { status: "UNAVAILABLE", error: updates.error ?? "Telegram unavailable." };

  const match = updates.updates.find((update) =>
    matchesCode(update.text, connection.pendingCodeHash!),
  );

  const highestUpdateId = updates.updates.reduce(
    (max, u) => (u.updateId > max ? u.updateId : max),
    connection.lastUpdateId === null ? -1 : Number(connection.lastUpdateId),
  );

  if (!match) {
    // Only messages that actually carried something code-shaped count against
    // the allowance. A poll that found nothing — the common case, several
    // times a minute — must cost the user nothing.
    const wrongGuesses = updates.updates.reduce(
      (total, update) => total + codeCandidates(update.text).length,
      0,
    );

    if (highestUpdateId >= 0 || wrongGuesses > 0) {
      await prisma.telegramConnection.update({
        where: { userId_bot: { userId, bot } },
        data: {
          ...(highestUpdateId >= 0 ? { lastUpdateId: BigInt(highestUpdateId) } : {}),
          ...(wrongGuesses > 0 ? { claimAttempts: { increment: wrongGuesses } } : {}),
        },
      });
    }

    if (connection.claimAttempts + wrongGuesses >= MAX_CLAIM_ATTEMPTS) {
      await clearPendingCode(userId, bot);
      return { status: "TOO_MANY_ATTEMPTS" };
    }

    return { status: "PENDING" };
  }

  // Bind, and burn the code in the same write so it cannot be replayed.
  await prisma.telegramConnection.update({
    where: { userId_bot: { userId, bot } },
    data: {
      chatId: match.chatId,
      chatLabel: match.chatLabel,
      connectedAt: new Date(),
      pendingCodeHash: null,
      pendingExpires: null,
      claimAttempts: 0,
      lastUpdateId: BigInt(Math.max(highestUpdateId, match.updateId)),
    },
  });

  // A channel becomes useful only once a chat is bound, so this is the moment
  // to turn it on rather than making the user find a second switch. The two
  // bots own different switches: binding the confirmation bot must not silently
  // enable the main Telegram channel, which the user may have left off on
  // purpose.
  await updatePreferences(
    userId,
    bot === "CONFIRMATION" ? { confirmationAlerts: true } : { telegramEnabled: true },
  );

  return { status: "CONNECTED", chatLabel: match.chatLabel };
}

/**
 * The code-shaped tokens in a message.
 *
 * One place decides what counts as an attempt, so the matcher and the counter
 * can never disagree about what a guess is.
 */
function codeCandidates(text: string): string[] {
  return text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((token) => token.length === 8);
}

/** Finds the code anywhere in the message, so `/start ABC` works too. */
function matchesCode(text: string, expectedHash: string): boolean {
  const expected = Buffer.from(expectedHash, "hex");

  for (const token of codeCandidates(text)) {
    const candidate = Buffer.from(hash(token), "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }

  return false;
}

async function clearPendingCode(userId: string, bot: TelegramBot): Promise<void> {
  await prisma.telegramConnection.update({
    where: { userId_bot: { userId, bot } },
    data: { pendingCodeHash: null, pendingExpires: null, claimAttempts: 0 },
  });
}

/**
 * Unbinds one bot and turns its own switch off.
 *
 * Scoped to the bot named, so disconnecting confirmation alerts leaves the main
 * bot bound and delivering — and vice versa. `deleteMany` rather than `delete`
 * so disconnecting something that was never connected is not an error.
 */
export async function disconnectTelegram(userId: string, bot: TelegramBot = "MAIN"): Promise<void> {
  await prisma.telegramConnection.deleteMany({ where: { userId, bot } });
  await updatePreferences(
    userId,
    bot === "CONFIRMATION" ? { confirmationAlerts: false } : { telegramEnabled: false },
  );
}

/**
 * Connection status for the UI.
 *
 * Reports whether a token is configured on the server, never anything about
 * the token itself.
 */
export async function getTelegramStatus(userId: string, bot: TelegramBot = "MAIN") {
  const connection = await prisma.telegramConnection.findUnique({
    where: { userId_bot: { userId, bot } },
    select: { chatId: true, chatLabel: true, connectedAt: true, pendingExpires: true },
  });

  return {
    bot,
    configured: isTelegramConfigured(bot),
    /** The variable to set, so an unconfigured bot says which one is missing. */
    tokenVariable: tokenVariableFor(bot),
    // Public, unlike the token: this is the name anyone would see in the bot's
    // profile, and it is what lets Settings link straight to the right chat
    // instead of asking the user to go and find it.
    botUsername: await getTelegramBotUsername({ bot }),
    connected: Boolean(connection?.chatId),
    chatLabel: connection?.chatLabel ?? null,
    connectedAt: connection?.connectedAt?.toISOString() ?? null,
    pending:
      connection?.pendingExpires !== null &&
      connection?.pendingExpires !== undefined &&
      connection.pendingExpires.getTime() > Date.now(),
  };
}

/**
 * Sends the test message for one bot. Says nothing about any market, by design.
 *
 * Each bot gets its own wording, because the two carry different things and a
 * test that did not say which channel had just been proved would be a test of
 * nothing in particular.
 */
export async function sendTelegramTest(
  userId: string,
  bot: TelegramBot = "MAIN",
): Promise<{ ok: boolean; error: string | null }> {
  const connection = await findConnection(userId, bot);

  if (!connection?.chatId) {
    return {
      ok: false,
      error:
        bot === "CONFIRMATION"
          ? "The confirmation bot is not connected for this account."
          : "Telegram is not connected for this account.",
    };
  }

  const result = await sendTelegramMessage({
    chatId: connection.chatId,
    text: bot === "CONFIRMATION" ? formatConfirmationConnectionTest() : formatConnectionTest(),
    bot,
  });

  return { ok: result.ok, error: result.error };
}

// --- in-app reads ----------------------------------------------------------

export async function listNotifications(input: {
  userId: string;
  limit: number;
  unreadOnly?: boolean;
}) {
  const rows = await prisma.notification.findMany({
    where: {
      userId: input.userId,
      channel: "IN_APP",
      ...(input.unreadOnly ? { readAt: null } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: input.limit,
  });

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    priority: row.priority,
    title: row.title,
    body: row.body,
    asset: row.asset,
    timeframe: row.timeframe as Timeframe | null,
    trackedSetupId: row.trackedSetupId,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, channel: "IN_APP", readAt: null },
  });
}

/**
 * Marks one notification read.
 *
 * Scoped by `userId` in the `where`, so a caller cannot mark somebody else's
 * notification read by guessing an id. Returns false rather than throwing when
 * nothing matched, which the route turns into a 404.
 */
export async function markRead(userId: string, id: string): Promise<boolean> {
  const result = await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });

  return result.count > 0;
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, channel: "IN_APP", readAt: null },
    data: { readAt: new Date() },
  });

  return result.count;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}
