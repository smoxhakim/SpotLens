import { prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";

/**
 * Sends one Telegram notification and records what happened on its row.
 *
 * Shared by the lifecycle path (`services/notifications.ts`) and the
 * confirmation path (`services/confirmation-alerts.ts`), which both write the
 * row as PENDING first — the unique index on it is the dedupe — and then send.
 * Before this, anything that threw between the two (a database error looking up
 * the chat, say) left the row PENDING for ever: never sent, never marked
 * failed, and — because the dedupe key was already taken — never tried again.
 *
 * Now every outcome reaches the row. A send that threw before Telegram was
 * contacted is FAILED with "not sent". A send whose outcome is unknown (a
 * timeout) is FAILED with a message saying it may have been delivered; the
 * provider does not retry those, to avoid duplicates. Writing the outcome is
 * tried twice; if the database refuses both, the row stays PENDING and the
 * failure is logged — nothing here can repair a database that is down, and
 * nothing retries old rows in the background.
 */

/** What a send reports — `TelegramSendResult`, or a refusal made before sending. */
export interface SendOutcome {
  ok: boolean;
  /** Sanitised by the provider, or written here; never carries a token. */
  error: string | null;
  attempts: number;
}

/** Written when the send step itself threw, before Telegram was contacted. */
export const NOT_SENT_ERROR =
  "Not sent: the delivery step failed before Telegram was contacted (see the process log).";

const RECORD_ATTEMPTS = 2;

export async function sendAndRecord(input: {
  notificationId: string;
  send: () => Promise<SendOutcome>;
  /** For the log: which path this is. */
  label: string;
}): Promise<{ ok: boolean; recorded: boolean }> {
  let outcome: SendOutcome;
  try {
    outcome = await input.send();
  } catch (err) {
    // The provider never throws, so this was the lookup or the formatting — a
    // step before any request. The raw error goes to the log, not to the row.
    warnOnce(`${input.label}:send`, `[${input.label}] could not send a Telegram message.`, err);
    outcome = { ok: false, error: NOT_SENT_ERROR, attempts: 0 };
  }

  const data = {
    status: outcome.ok ? ("SENT" as const) : ("FAILED" as const),
    sentAt: outcome.ok ? new Date() : null,
    attempts: outcome.attempts,
    error: outcome.ok ? null : outcome.error,
  };

  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt += 1) {
    try {
      await prisma.notification.update({ where: { id: input.notificationId }, data });
      return { ok: outcome.ok, recorded: true };
    } catch (err) {
      if (attempt === RECORD_ATTEMPTS) {
        warnOnce(
          `${input.label}:record`,
          `[${input.label}] could not record a Telegram outcome; the row stays PENDING.`,
          err,
        );
      }
    }
  }
  return { ok: outcome.ok, recorded: false };
}
