import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import { warnOnce } from "@/lib/log";
import {
  EVENT_PRIORITY,
  PREFERENCE_FOR_EVENT,
  SCAN_REPORT_TIMEFRAME,
  dedupeKeyForScanReport,
  formatScanReport,
  planScanReport,
  scanReportRecord,
  sendTelegramMessage,
  type ReportedEvent,
  type ScanReportRefusal,
} from "@/lib/notifications";
import { getPreferences } from "@/services/notifications";
import { sendAndRecord, type Delivery } from "@/services/telegram-delivery";

/**
 * Hourly scan report delivery.
 *
 * Its own path, beside the lifecycle alerts rather than inside them. The
 * report is about a pass, not a setup, so it has nothing to do with the rules
 * that decide which alert is worth a phone — and keeping it out of
 * `deliverEvents` means its switch cannot silence an alert, nor an alert's
 * routing withhold it.
 *
 * ## Two switches, both off by default
 *
 * `telegramEnabled` is the master switch for every bot, and `scanReport` is
 * this report's own. Both must be on. With either off nothing is read beyond
 * the preferences, no row is written and nothing is sent. Turning the report
 * off leaves every alert exactly as it was; turning Telegram off stops both.
 *
 * ## Once per run
 *
 * The row is written PENDING first and its dedupe key is the run id
 * (`dedupeKeyForScanReport`), so the unique index on
 * `(userId, channel, dedupeKey)` makes a second report for the same pass
 * impossible — a repeated call, a restart or a second process all hit it.
 * Then `sendAndRecord` sends and writes the outcome, as for every other
 * Telegram message: at most once, never retried in the background.
 *
 * ## Only a pass with a completion record
 *
 * The report is built from the stored run, re-read here, never from the
 * scanner's memory of it: a run that never reached COMPLETED or PARTIAL with a
 * `completedAt` gets nothing. See `planScanReport` for the full rule.
 *
 * Nothing here throws. It runs inside the scanner process, and a report that
 * could end a scan would be worse than no report.
 */

const CHANNEL = "TELEGRAM" as const;

export type ScanReportSkip =
  | "NO_DATABASE"
  /** Telegram's master switch is off. */
  | "TELEGRAM_OFF"
  /** The report's own switch is off. */
  | "REPORT_OFF"
  | ScanReportRefusal;

export type ScanReportOutcome =
  | { status: "SKIPPED"; reason: ScanReportSkip }
  /** Already reported for this run. Nothing was sent. */
  | { status: "DUPLICATE" }
  | { status: "SENT" }
  | { status: "FAILED"; delivery: Delivery }
  /** Something unexpected; logged, and the scan carries on. */
  | { status: "ERROR" };

export async function deliverScanReport(input: {
  userId: string;
  /** Null when the pass could not record itself — there is then nothing to vouch for it. */
  runId: string | null;
  /** The same pass's scanner events. Only their type and timeframe are read. */
  events: readonly ReportedEvent[];
}): Promise<ScanReportOutcome> {
  if (!isDatabaseConfigured) return { status: "SKIPPED", reason: "NO_DATABASE" };
  if (input.runId === null) return { status: "SKIPPED", reason: "NO_RUN_RECORD" };

  try {
    const prefs = await getPreferences(input.userId);
    if (!prefs.telegramEnabled) return { status: "SKIPPED", reason: "TELEGRAM_OFF" };
    if (!prefs[PREFERENCE_FOR_EVENT.SCAN_REPORT]) {
      return { status: "SKIPPED", reason: "REPORT_OFF" };
    }

    const plan = await planFor(input.userId, input.runId, input.events);
    if (!plan.ok) return { status: "SKIPPED", reason: plan.refusal };

    const { facts } = plan;
    const { title, body } = scanReportRecord(facts);

    let notificationId: string;
    try {
      const row = await prisma.notification.create({
        data: {
          userId: input.userId,
          type: "SCAN_REPORT",
          channel: CHANNEL,
          priority: EVENT_PRIORITY.SCAN_REPORT,
          status: "PENDING",
          title,
          body,
          trackedSetupId: null,
          asset: null,
          timeframe: SCAN_REPORT_TIMEFRAME,
          dedupeKey: dedupeKeyForScanReport(facts.runId),
        },
        select: { id: true },
      });
      notificationId = row.id;
    } catch (err) {
      // The unique index doing its job: this run was already reported.
      if (isUniqueViolation(err)) return { status: "DUPLICATE" };
      throw err;
    }

    // Every outcome reaches the row — a failed connection lookup included — so
    // no row is left PENDING. See `sendAndRecord`.
    const result = await sendAndRecord({
      notificationId,
      label: "scan-report",
      send: async () => {
        const connection = await prisma.telegramConnection.findUnique({
          where: { userId_bot: { userId: input.userId, bot: "MAIN" } },
          select: { chatId: true },
        });
        return connection?.chatId
          ? // Already sanitised by the provider — it strips every configured
            // token before returning, so this cannot carry one into a row.
            sendTelegramMessage({
              chatId: connection.chatId,
              text: formatScanReport(facts),
              bot: "MAIN",
            })
          : { ok: false, error: "Telegram is not connected for this account.", attempts: 0 };
      },
    });

    return result.ok ? { status: "SENT" } : { status: "FAILED", delivery: result.delivery };
  } catch (err) {
    warnOnce("scan-report:deliver", "[scan-report] could not deliver the scan report.", err);
    return { status: "ERROR" };
  }
}

/**
 * The stored run, its 1h rows and the owner's open 1h setups, planned.
 *
 * Read only once both switches are on, so a report nobody asked for costs the
 * database nothing beyond the preferences.
 */
async function planFor(userId: string, runId: string, events: readonly ReportedEvent[]) {
  const run = await prisma.scannerRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      status: true,
      timeframes: true,
      startedAt: true,
      completedAt: true,
      durationMs: true,
    },
  });

  if (!run) return planScanReport({ run: null, results: [], events, openSetups: [] });

  const [results, open] = await Promise.all([
    prisma.scannerResult.findMany({
      where: { scannerRunId: run.id, timeframe: SCAN_REPORT_TIMEFRAME },
      select: { timeframe: true, status: true, analysisStatus: true },
    }),
    // Scoped by owner in the query: the report counts this account's setups
    // and nobody else's.
    prisma.trackedSetup.groupBy({
      by: ["status"],
      where: { userId, timeframe: SCAN_REPORT_TIMEFRAME, status: { not: "INVALIDATED" } },
      _count: { _all: true },
    }),
  ]);

  return planScanReport({
    run: {
      id: run.id,
      status: run.status,
      timeframes: run.timeframes,
      startedAt: run.startedAt.getTime(),
      completedAt: run.completedAt?.getTime() ?? null,
      durationMs: run.durationMs,
    },
    results,
    events,
    openSetups: open.map((group) => ({ status: group.status, count: group._count._all })),
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
