import {
  decodeEvidence,
  encodeEvidence,
  formatConfirmationAlert,
  planConfirmationWatch,
  renderConfirmationInApp,
  type ConfirmationAlert,
  type ConfirmationObservation,
  type SetupNumbers,
} from "@/lib/confirmation-watch";
import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";
import {
  EVENT_PRIORITY,
  PREFERENCE_FOR_EVENT,
  sendTelegramMessage,
  type NotificationEventType,
} from "@/lib/notifications";
import { getPreferences } from "@/services/notifications";

/**
 * Confirmation alert delivery.
 *
 * The only path to the confirmation bot, and structurally incapable of reaching
 * the main one: the channel is a constant here, `sendTelegramMessage` is always
 * called with `bot: "CONFIRMATION"`, and this function is never handed a
 * `NotificationEvent` — the main path's own type cannot even represent these
 * two event types.
 *
 * ## Ordering, and why a crash is survivable
 *
 * For each alert: write the notification row, send, then update the watch
 * state. Never the other way round. Updating the state first and crashing
 * before the row exists would lose the alert for good, because the state would
 * claim it had been announced. This order can only ever re-derive the same
 * alert on the next pass, where the unique index on
 * `(userId, channel, dedupeKey)` rejects the duplicate row — so the second
 * attempt is silent and the state catches up. The watch state decides *what
 * changed*; the index decides *how many times it may be said*.
 *
 * Nothing here throws. It runs inside the scanner process, and an alert channel
 * that can abort a scan is worse than no alert channel.
 */

const CHANNEL = "TELEGRAM_CONFIRMATION" as const;

export interface ConfirmationDeliveryOutcome {
  observed: number;
  baselined: number;
  created: number;
  sent: number;
  failed: number;
  duplicates: number;
  suppressed: number;
  quiet: number;
}

const NOTHING: ConfirmationDeliveryOutcome = {
  observed: 0,
  baselined: 0,
  created: 0,
  sent: 0,
  failed: 0,
  duplicates: 0,
  suppressed: 0,
  quiet: 0,
};

/**
 * Processes every confirmation observation from one scanner pass.
 *
 * Sequential rather than parallel, for the reason the main path is: Telegram
 * rate-limits per chat, and waiting costs nothing here because nothing
 * downstream is blocked on it.
 */
export async function deliverConfirmationAlerts(input: {
  userId: string;
  observations: ConfirmationObservation[];
}): Promise<ConfirmationDeliveryOutcome> {
  if (!isDatabaseConfigured || input.observations.length === 0) return NOTHING;

  const totals = { ...NOTHING };

  // Read once rather than per observation: a pass can carry ninety of these.
  let alertsEnabled: boolean;
  try {
    const prefs = await getPreferences(input.userId);
    alertsEnabled = prefs[PREFERENCE_FOR_EVENT.CONFIRMATION_REACHED];
  } catch (err) {
    warnOnce(
      "confirmation-alerts:preferences",
      "[confirmation] could not read notification preferences.",
      err,
    );
    return NOTHING;
  }

  for (const observation of input.observations) {
    // Ownership is asserted here rather than assumed from the caller. Every
    // observation in a pass belongs to the scan's owner, and a mismatch means
    // a wiring bug — not something to paper over by delivering anyway.
    if (observation.userId !== input.userId) {
      warnOnce(
        "confirmation-alerts:owner",
        "[confirmation] an observation did not belong to the scan's owner and was dropped.",
        null,
      );
      continue;
    }

    const outcome = await processOne(observation, alertsEnabled);
    totals.observed += outcome.observed;
    totals.baselined += outcome.baselined;
    totals.created += outcome.created;
    totals.sent += outcome.sent;
    totals.failed += outcome.failed;
    totals.duplicates += outcome.duplicates;
    totals.suppressed += outcome.suppressed;
    totals.quiet += outcome.quiet;
  }

  return totals;
}

async function processOne(
  observation: ConfirmationObservation,
  alertsEnabled: boolean,
): Promise<ConfirmationDeliveryOutcome> {
  try {
    const stored = await prisma.setupConfirmationWatch.findFirst({
      // Scoped by owner in the query, not filtered after it: one person's
      // setups must never be reachable from another account, and a watch row
      // for somebody else's setup should read as absent rather than as theirs.
      where: { trackedSetupId: observation.trackedSetupId, userId: observation.userId },
      select: { announcedEvidence: true, reachedAnnounced: true },
    });

    const plan = planConfirmationWatch({
      observation,
      existing: stored
        ? {
            announcedEvidence: decodeEvidence(stored.announcedEvidence),
            reachedAnnounced: stored.reachedAnnounced,
          }
        : null,
    });

    if (plan.action === "NONE") return { ...NOTHING, observed: 1, quiet: 1 };

    if (plan.action === "BASELINE") {
      // Recorded, and deliberately silent. Everything already true at the
      // moment the watcher first sees a setup is treated as known, so arming
      // it over setups that have been open for days cannot produce a burst.
      await writeState(observation, plan.state.announcedEvidence, plan.state.reachedAnnounced);
      return { ...NOTHING, observed: 1, baselined: 1 };
    }

    if (plan.action === "OBSERVE") {
      await writeState(observation, plan.state.announcedEvidence, plan.state.reachedAnnounced);
      return { ...NOTHING, observed: 1, quiet: 1 };
    }

    if (!alertsEnabled) {
      // The switch is off. The state still advances — otherwise turning alerts
      // back on later would announce everything that accumulated while they
      // were off, which is the burst this design exists to avoid.
      await writeState(observation, plan.state.announcedEvidence, plan.state.reachedAnnounced);
      return { ...NOTHING, observed: 1, suppressed: plan.alerts.length };
    }

    const numbers = await readSetupNumbers(observation);

    const totals = { ...NOTHING, observed: 1 };

    for (const alert of plan.alerts) {
      const outcome = await deliverOne(alert, numbers);
      totals.created += outcome.created;
      totals.sent += outcome.sent;
      totals.failed += outcome.failed;
      totals.duplicates += outcome.duplicates;
    }

    // Last, so that a crash anywhere above re-derives the same alert on the
    // next pass and is stopped by the unique index rather than lost.
    await writeState(observation, plan.state.announcedEvidence, plan.state.reachedAnnounced);

    return totals;
  } catch (err) {
    warnOnce(
      "confirmation-alerts:observe",
      "[confirmation] could not process an observation.",
      err,
    );
    return { ...NOTHING, observed: 1 };
  }
}

/**
 * One alert, on both of its channels.
 *
 * The in-app copy exists because "not worth a push" and "not worth recording"
 * are different judgements, and because the Notifications page is where a
 * reader goes to see what they missed. It never touches the main bot: the
 * in-app channel is not a bot at all.
 */
async function deliverOne(
  alert: ConfirmationAlert,
  numbers: SetupNumbers | null,
): Promise<ConfirmationDeliveryOutcome> {
  const type: NotificationEventType =
    alert.level === "REACHED" ? "CONFIRMATION_REACHED" : "CONFIRMATION_EVIDENCE";

  const { title, body } = renderConfirmationInApp(alert, numbers);

  const totals = { ...NOTHING };

  // In-app first: it is the record, and it must survive Telegram being down.
  const inApp = await insertRow({ alert, type, channel: "IN_APP", title, body, sent: true });
  if (inApp === "DUPLICATE") totals.duplicates += 1;
  else totals.created += 1;

  const row = await insertRow({ alert, type, channel: CHANNEL, title, body, sent: false });

  if (row === "DUPLICATE") {
    // Already announced on a previous pass, or by a concurrent one. Not an
    // error, and specifically not a reason to send anything.
    return { ...totals, duplicates: totals.duplicates + 1 };
  }

  const connection = await prisma.telegramConnection.findUnique({
    where: { userId_bot: { userId: alert.userId, bot: "CONFIRMATION" } },
    select: { chatId: true },
  });

  const result = connection?.chatId
    ? await sendTelegramMessage({
        chatId: connection.chatId,
        text: formatConfirmationAlert(alert, numbers),
        bot: "CONFIRMATION",
      })
    : {
        ok: false as const,
        // Named precisely, because "Telegram is not connected" would send the
        // reader to the main bot's connection, which is working fine.
        error: "The confirmation bot is not connected for this account.",
        attempts: 0,
      };

  await prisma.notification.update({
    where: { id: row },
    data: {
      status: result.ok ? "SENT" : "FAILED",
      sentAt: result.ok ? new Date() : null,
      attempts: result.attempts,
      // Already sanitised by the provider — it strips every configured token
      // before returning, so this cannot carry one into a row.
      error: result.ok ? null : result.error,
    },
  });

  return {
    ...totals,
    created: totals.created + 1,
    sent: result.ok ? 1 : 0,
    failed: result.ok ? 0 : 1,
  };
}

/** Writes the row, or reports that the unique index already had it. */
async function insertRow(input: {
  alert: ConfirmationAlert;
  type: NotificationEventType;
  channel: "IN_APP" | typeof CHANNEL;
  title: string;
  body: string;
  sent: boolean;
}): Promise<string | "DUPLICATE"> {
  try {
    const row = await prisma.notification.create({
      data: {
        userId: input.alert.userId,
        type: input.type,
        channel: input.channel,
        priority: EVENT_PRIORITY[input.type],
        status: input.sent ? "SENT" : "PENDING",
        sentAt: input.sent ? new Date() : null,
        title: input.title,
        body: input.body,
        trackedSetupId: input.alert.trackedSetupId,
        asset: input.alert.symbol,
        timeframe: input.alert.timeframe,
        dedupeKey: input.alert.dedupeKey,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) return "DUPLICATE";
    throw err;
  }
}

/**
 * The levels this setup was created with.
 *
 * Read from the `Decimal(24,8)` columns of the immutable snapshot, never from a
 * live analysis. Those columns are written once; later analysis moving the
 * entry is the market, not a correction, and quoting today's numbers under a
 * setup created three days ago would show a different entry than every other
 * surface in the product.
 */
async function readSetupNumbers(
  observation: ConfirmationObservation,
): Promise<SetupNumbers | null> {
  const setup = await prisma.trackedSetup.findFirst({
    where: { id: observation.trackedSetupId, userId: observation.userId },
    select: {
      entryLow: true,
      entryHigh: true,
      stopLoss: true,
      score: true,
      riskReward: true,
      riskRewardIsSynthetic: true,
    },
  });

  if (!setup) return null;

  return {
    entryLow: Number(setup.entryLow),
    entryHigh: Number(setup.entryHigh),
    stopLoss: Number(setup.stopLoss),
    score: setup.score,
    riskReward: Number(setup.riskReward),
    riskRewardIsSynthetic: setup.riskRewardIsSynthetic,
  };
}

async function writeState(
  observation: ConfirmationObservation,
  announced: Parameters<typeof encodeEvidence>[0],
  reached: boolean,
): Promise<void> {
  const announcedEvidence = encodeEvidence(announced);

  await prisma.setupConfirmationWatch.upsert({
    where: { trackedSetupId: observation.trackedSetupId },
    create: {
      trackedSetupId: observation.trackedSetupId,
      userId: observation.userId,
      announcedEvidence,
      reachedAnnounced: reached,
      lastEvaluatedAt: BigInt(observation.evaluatedAt),
    },
    update: {
      announcedEvidence,
      reachedAnnounced: reached,
      lastEvaluatedAt: BigInt(observation.evaluatedAt),
    },
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "P2002"
  );
}
