/**
 * The local scanner process.
 *
 * A plain long-running Node process, deliberately. SpotLens is a local
 * application: a queue, a cloud worker or a cron service would each be more
 * moving parts than a single `setTimeout` that wakes when a candle closes, and
 * none of them would make the result more correct.
 *
 *   npm run scanner        — schedule: wake after each candle close
 *   npm run scanner:once   — one pass over the universe, then exit
 *
 * Both load `.env` through Node's own `--env-file`, so the scanner reads the
 * same configuration the app does without a second copy of it anywhere.
 *
 * Stop it with Ctrl-C; an in-flight pass is allowed to unwind first.
 */
import { prisma } from "@/lib/db/prisma";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import {
  DEFAULT_CLOSE_DELAY_MS,
  DEFAULT_SCAN_TIMEFRAMES,
  nextScanWindow,
  sleep,
} from "@/lib/scanner";
import { buildDailySummary, eventsFromScan } from "@/services/notification-events";
import { deliverEvents } from "@/services/notifications";
import { DEFAULT_MAX_CONCURRENCY, resolveScannerUserId, runScan } from "@/services/scanner";
import { timeframeSchema } from "@/lib/market-data/schema";

const once = process.argv.includes("--once");

const timeframes = readTimeframes();
const concurrency = readNumber("SCANNER_MAX_CONCURRENCY", DEFAULT_MAX_CONCURRENCY);
const closeDelayMs = readNumber("SCANNER_CLOSE_DELAY_MS", DEFAULT_CLOSE_DELAY_MS);

const controller = new AbortController();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    controller.abort();
    log("Stopping after the current pass. Press Ctrl-C again to force.");
  });
}

async function scan(triggeredBy: "SCHEDULE" | "MANUAL", due: Timeframe[], userId: string) {
  const started = Date.now();
  log(`Scanning ${due.map((t) => TIMEFRAME_LABELS[t]).join(" + ")}…`);

  const summary = await runScan({
    userId,
    timeframes: due,
    maxConcurrency: concurrency,
    triggeredBy,
    signal: controller.signal,
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  log(
    `${summary.status} in ${seconds}s — ${summary.succeeded}/${summary.analysed} analysed` +
      (summary.failed > 0 ? `, ${summary.failed} failed` : ""),
  );
  // No-trade outcomes are the majority and are reported as such: a scan where
  // most markets say avoid is the tool working, not a scan that found nothing.
  log(
    `   potential ${summary.potentialSetups} · waiting ${summary.waiting} · ` +
      `high risk ${summary.highRisk} · avoid ${summary.avoided}`,
  );

  if (summary.setupsCreated || summary.stateChanges || summary.invalidations) {
    log(
      `   setups created ${summary.setupsCreated} · state changes ${summary.stateChanges} · ` +
        `invalidations ${summary.invalidations}`,
    );
    for (const event of summary.events.filter((e) => e.type !== "ANALYSIS_FAILED")) {
      log(`   → ${event.type} ${event.symbol} ${event.timeframe}`);
    }
  } else {
    log("   nothing changed since the last pass");
  }

  for (const event of summary.events.filter((e) => e.type === "ANALYSIS_FAILED")) {
    log(`   ! ${event.symbol} ${event.timeframe}: ${event.failureCategory} — ${event.detail}`);
  }

  // Notifications are wired in here, not inside `runScan`. The scanner service
  // has no idea Telegram exists — this script is the composition root, and it
  // is the only place that knows both halves.
  await notify(summary.events, userId);

  const top = summary.results.filter((r) => r.ok).slice(0, 3);
  if (top.length > 0) {
    log("   best ranked:");
    for (const r of top) {
      // "Quality", never "probability" — the score orders a list and nothing more.
      log(
        `     ${r.symbol} ${r.timeframe} ${r.analysisStatus}` +
          (r.score === null ? "" : ` · quality ${r.score}/100`),
      );
    }
  }
}

/**
 * Routes a pass's events to the notification layer.
 *
 * Wrapped so that nothing it does can end a scan. A notification channel that
 * can abort the analysis is worse than no channel at all — the whole point of
 * the scanner is that it keeps running.
 */
async function notify(
  scannerEvents: Awaited<ReturnType<typeof runScan>>["events"],
  userId: string,
) {
  try {
    const events = await eventsFromScan({ userId, scannerEvents });
    if (events.length === 0) return;

    const outcome = await deliverEvents(events);

    if (outcome.created > 0 || outcome.duplicates > 0 || outcome.suppressed > 0) {
      log(
        `   notifications: ${outcome.sent} sent · ${outcome.failed} failed · ` +
          `${outcome.duplicates} already seen · ${outcome.suppressed} not subscribed`,
      );
    }
  } catch (err) {
    log(`   notifications skipped: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

/**
 * Sends the daily summary once per UTC day.
 *
 * The dedupe key is the date, so calling this on every pass is safe: the first
 * one after midnight writes a row and the rest are rejected by the unique
 * index. That is simpler than a second schedule, and it cannot drift out of
 * step with the scans it summarises.
 */
async function maybeSendDailySummary(userId: string) {
  try {
    const event = await buildDailySummary({ userId });
    if (!event) return;

    const outcome = await deliverEvents([event]);
    if (outcome.created > 0) log(`   daily summary sent for ${event.summary?.date}`);
  } catch (err) {
    log(`   daily summary skipped: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

async function main() {
  const userId = await resolveScannerUserId(process.env.SCANNER_USER_EMAIL);

  if (!userId) {
    log(
      "No account found. The scanner tracks setups against an owner — create one at /register, " +
        "or set SCANNER_USER_EMAIL to pick between several.",
    );
    process.exitCode = 1;
    return;
  }

  log(
    `Universe: every active curated market · timeframes ${timeframes.join(", ")} · ` +
      `concurrency ${concurrency}`,
  );

  if (once) {
    await scan("MANUAL", timeframes, userId);
    return;
  }

  log(`Scheduling ${closeDelayMs / 1000}s after each candle close. Ctrl-C to stop.`);

  while (!controller.signal.aborted) {
    const window = nextScanWindow(timeframes, Date.now(), closeDelayMs);
    const waitMs = window.at - Date.now();

    log(
      `Next: ${window.timeframes.join(" + ")} at ${new Date(window.at).toISOString()} ` +
        `(in ${Math.max(0, Math.round(waitMs / 1000))}s)`,
    );

    await sleep(waitMs, controller.signal);
    if (controller.signal.aborted) break;

    try {
      await scan("SCHEDULE", window.timeframes, userId);
      await maybeSendDailySummary(userId);
    } catch (err) {
      // A pass that blows up must not end the process — the next candle close
      // is another chance, and a scanner that dies overnight is useless.
      log(`Pass failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }

    // Past the close we just handled, so the next window is the following one.
    await sleep(1_000, controller.signal);
  }

  log("Stopped.");
}

function readTimeframes(): Timeframe[] {
  const raw = process.env.SCANNER_TIMEFRAMES;
  if (!raw) return DEFAULT_SCAN_TIMEFRAMES;

  const parsed = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => timeframeSchema.safeParse(part));

  const valid = parsed.flatMap((p) => (p.success ? [p.data] : []));

  if (valid.length !== parsed.length) {
    log(
      `Ignoring unrecognised entries in SCANNER_TIMEFRAMES; using ${valid.join(", ") || "defaults"}.`,
    );
  }

  return valid.length > 0 ? valid : DEFAULT_SCAN_TIMEFRAMES;
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function log(message: string) {
  // UTC in the log for the same reason it is UTC everywhere else: candle
  // timestamps are UTC, and mixing zones is how off-by-one-hour bugs start.
  console.log(`[scanner ${new Date().toISOString()}] ${message}`);
}

main()
  .catch((err) => {
    log(`Fatal: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
