/**
 * The local scanner process.
 *
 * A plain long-running Node process, deliberately. SpotLens is a local
 * application: a queue, a cloud worker or a cron service would each be more
 * moving parts than a single `setTimeout` that wakes when a candle closes, and
 * none of them would make the result more correct.
 *
 *   npm run spotlens       — the usual way: run with the entry-zone monitor, under the engine
 *   npm run scanner        — schedule: wake after each candle close
 *   npm run scanner:once   — one pass over the universe, then exit
 *
 * `--catch-up` (the engine passes it) adds one pass on startup when no pass has
 * started since the most recent scan window — so a machine that was off does not
 * wait for the next close to refresh — and then follows the schedule unchanged.
 * One scanner per machine: a second one exits rather than racing the first.
 *
 * Both load `.env` through Node's own `--env-file`, so the scanner reads the
 * same configuration the app does without a second copy of it anywhere.
 *
 * Stop it with Ctrl-C; an in-flight pass is allowed to unwind first.
 */
import { prisma } from "@/lib/db/prisma";
import {
  holdLockOrExit,
  isCatchUpDue,
  scannerRunCompleted,
  stopWhenEngineGone,
} from "@/lib/engine";
import { TIMEFRAME_LABELS, type Timeframe } from "@/lib/market-data/provider";
import {
  DEFAULT_CLOSE_DELAY_MS,
  DEFAULT_SCAN_TIMEFRAMES,
  FAILED_PASS_RETRY_DELAYS_MS,
  classifyPass,
  classifyPassError,
  describeBreakdown,
  nextWake,
  recordPass,
  startSchedule,
  startupRetryDelay,
  classifyFailure,
  type PassOutcome,
  type ScheduleState,
  planScan,
  scanOnWake,
  settlementDelayMs,
  sleep,
} from "@/lib/scanner";
import { deliverConfirmationAlerts } from "@/services/confirmation-alerts";
import { buildDailySummary, eventsFromScan } from "@/services/notification-events";
import { deliverEvents } from "@/services/notifications";
import {
  DEFAULT_MAX_CONCURRENCY,
  closeAbandonedRuns,
  describeScannerUserFailure,
  lastSuccessfulPassStartedAt,
  resolveScannerUser,
  runScan,
} from "@/services/scanner";
import { timeframeSchema } from "@/lib/market-data/schema";

const once = process.argv.includes("--once");
const catchUp = process.argv.includes("--catch-up");

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

// Under the engine: if the engine goes away — however it went — stop as if told
// to, so no scanner is left running unsupervised with no one reading its output.
stopWhenEngineGone(process, () => {
  if (stopping) return;
  stopping = true;
  controller.abort();
  log("The engine is gone; stopping after the current pass.");
});

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
    `${summary.status}${summary.interrupted ? " (interrupted)" : ""} in ${seconds}s — ` +
      `${summary.succeeded}/${summary.analysed} analysed` +
      (summary.failed > 0 ? `, ${summary.failed} failed` : ""),
  );
  // No-trade outcomes are the majority and are reported as such: a scan where
  // most markets say avoid is the tool working, not a scan that found nothing.
  log(
    `   potential ${summary.potentialSetups} · waiting ${summary.waiting} · ` +
      `high risk ${summary.highRisk} · avoid ${summary.avoided}`,
  );
  // Why, per timeframe: the gate that held each analysis back. Counts of what
  // the engine already decided, so a pass with no potential setup says which
  // rule refused them.
  for (const counts of summary.breakdown) log(`   ${describeBreakdown(counts)}`);

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

  // The second channel, and deliberately a second call rather than a branch
  // inside the first. The two paths share no delivery code: lifecycle events go
  // to the main bot, confirmation activity to its own, and neither function can
  // reach the other's destination.
  await watchConfirmation(summary.observations, userId);

  // The shortlist, not the first three of everything: ninety analyses is more
  // than anyone reads, and the counts either side of it are what say how much
  // was looked at and refused.
  const { shortlist } = summary;
  // Every bucket, so the numbers add up to the total on the line above. An
  // earlier version omitted the failures and the arithmetic silently stopped
  // balancing, which is how a miscategorised exclusion went unnoticed.
  const { excluded } = shortlist;
  log(
    `   shortlist: ${shortlist.totalEligible} of ${shortlist.totalAnalysed} eligible · ` +
      `excluded ${excluded.AVOID} avoid, ${excluded.HIGH_RISK} high risk, ` +
      `${excluded.NO_LEVELS} without levels, ${excluded.BELOW_QUALITY_BAR} below the quality bar, ` +
      `${excluded.REWARD_NOT_MEASURED} unmeasured reward, ${excluded.FAILED} failed`,
  );

  if (shortlist.top5.length > 0) {
    log("   top opportunities to review:");
    for (const c of shortlist.top5) {
      // "Quality", never "probability" — the score orders a list and nothing more.
      log(
        `     ${c.rank}. ${c.symbol} ${c.timeframe} ${c.analysisStatus} · quality ${c.score}/100` +
          (c.riskRewardIsMeasured
            ? ` · R:R 1:${c.riskReward!.toFixed(1)}`
            : " · R:R not measured") +
          (c.untrackedReason
            ? ` · not tracked (${c.untrackedReason.toLowerCase().replace(/_/g, " ")})`
            : ""),
      );
    }
  } else {
    log("   nothing met the shortlist bar this pass. That is a normal outcome.");
  }

  // Under the engine, tell it the pass is complete: every setup this pass
  // created, moved or invalidated is written by now, and the entry-zone monitor
  // reloads on this instead of waiting for its next check. Run on its own, the
  // scanner has no IPC channel and this does nothing. The callback makes a
  // channel that closed mid-pass a non-event rather than an unhandled error.
  if (process.connected)
    process.send?.(scannerRunCompleted(summary.runId), undefined, {}, () => undefined);

  return summary;
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

    if (
      outcome.created > 0 ||
      outcome.duplicates > 0 ||
      outcome.suppressed > 0 ||
      outcome.telegramWithheld > 0
    ) {
      log(
        `   notifications: ${outcome.sent} sent · ${outcome.failed} failed · ` +
          `${outcome.duplicates} already seen · ${outcome.suppressed} not subscribed · ` +
          // Recorded and in the app, deliberately not pushed. Reported so the
          // difference between "quiet" and "broken" stays visible from the log.
          `${outcome.telegramWithheld} in-app only`,
      );
    }
  } catch (err) {
    log(`   notifications skipped: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

/**
 * Follows each tracked setup's confirmation evidence.
 *
 * Wrapped like `notify`, and for the same reason: a bot being unreachable must
 * not end a scan. The first observation of any setup is a baseline that records
 * what is already true and says nothing, so arming this over setups that have
 * been open for days cannot produce a burst.
 */
async function watchConfirmation(
  observations: Awaited<ReturnType<typeof runScan>>["observations"],
  userId: string,
) {
  try {
    if (observations.length === 0) return;

    const outcome = await deliverConfirmationAlerts({ userId, observations });

    if (outcome.baselined > 0 || outcome.created > 0 || outcome.duplicates > 0) {
      log(
        `   confirmation: ${outcome.observed} watched · ${outcome.baselined} baselined · ` +
          `${outcome.sent} sent · ${outcome.failed} failed · ` +
          `${outcome.duplicates} already announced · ${outcome.suppressed} not subscribed`,
      );
    }
  } catch (err) {
    log(`   confirmation alerts skipped: ${err instanceof Error ? err.message : "unknown error"}`);
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

/** Returned by `withStartupRetries` when the scanner was stopped while waiting. */
const STOPPED = Symbol("stopped");

/**
 * A startup read of the database, retried while the database or network is
 * unreachable — 1, 2, 5 and 10 minutes apart (`startupRetryDelay`) — and given
 * up on at once for an error waiting would not fix. One attempt at a time; a
 * stop during the wait ends it at once. Gives up by throwing an error that
 * says what to check, which `main` reports and exits 1 on.
 */
async function withStartupRetries<T>(
  what: string,
  read: () => Promise<T>,
): Promise<T | typeof STOPPED> {
  const started = Date.now();
  for (let failed = 1; ; failed += 1) {
    try {
      return await read();
    } catch (err) {
      if (controller.signal.aborted) return STOPPED;
      // Sanitised: no connection string or credential reaches the log.
      const detail = classifyFailure(err).message;
      const delay = startupRetryDelay(err, failed);
      if (delay === null) {
        const transient = classifyPassError(err, false) === "FAILED_TRANSIENT";
        throw new Error(
          transient
            ? `${what} failed ${failed} times over ${Math.round((Date.now() - started) / 60_000)} ` +
                `min; the database is still unreachable (${detail}). Check the network and ` +
                "DATABASE_URL, then start the scanner again."
            : `${what} failed with an error that retrying will not fix (${detail}). Check ` +
                "DATABASE_URL and the database credentials, then start the scanner again.",
        );
      }
      log(
        `${what} failed (${detail}). The database or network looks unavailable; retrying in ` +
          `${Math.round(delay / 60_000)} min (retry ${failed} of ${FAILED_PASS_RETRY_DELAYS_MS.length}).`,
      );
      await sleep(delay, controller.signal);
      if (controller.signal.aborted) return STOPPED;
    }
  }
}

/** Says what the schedule will do about a pass that failed transiently, if anything. */
function announceRetry(schedule: ScheduleState) {
  if (schedule.retry) {
    log(
      `   every market failed, probably transiently (network, timeout, exchange or database ` +
        `unavailable). Retrying in ${Math.round((schedule.retry.at - Date.now()) / 60_000)} min ` +
        `(retry ${schedule.retry.attempt} of ${FAILED_PASS_RETRY_DELAYS_MS.length}).`,
    );
  } else if (schedule.notBefore !== null) {
    log(
      "   every market failed again; no more retries before the next window at " +
        `${new Date(schedule.notBefore).toISOString()}, which rescans these timeframes too.`,
    );
  }
}

/** `closeAbandonedRuns`, logged. A failure here must never stop a scan. */
async function recoverAbandonedRuns() {
  try {
    const closed = await closeAbandonedRuns();
    if (closed > 0) {
      log(`Closed ${closed} scanner run(s) left RUNNING by a scanner that was stopped mid-pass.`);
    }
  } catch (err) {
    log(`Could not close abandoned runs: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

/**
 * One pass on startup if the schedule has missed a window.
 *
 * Same settle delay, same pass, same notifications as any scheduled one; the
 * only difference is that it does not wait for the next close. A failure is
 * logged and the schedule carries on — a catch-up pass is a convenience.
 */
async function maybeCatchUp(userId: string): Promise<CatchUpResult | null> {
  // When the catch-up pass was decided — what it covers. Null if none ran.
  let decidedAt: number | null = null;
  let outcome: PassOutcome = "SUCCEEDED";
  try {
    // A FAILED pass is finished but scanned nothing, so it does not count. If
    // the check itself fails, catch up anyway: an unneeded pass costs one scan,
    // a skipped one leaves setups unverified until the next close — and a pass
    // that fails because the database is still down is retried like any other.
    let last: Date | null = null;
    let checked = true;
    try {
      last = await lastSuccessfulPassStartedAt();
    } catch (err) {
      checked = false;
      log(
        `Could not check when the last successful pass ran (${classifyFailure(err).message}); ` +
          "catching up anyway, so no window is skipped.",
      );
    }

    const due =
      !checked ||
      isCatchUpDue({
        lastCompletedRunStartedAt: last?.getTime() ?? null,
        timeframes,
        now: Date.now(),
        delayMs: closeDelayMs,
      });

    if (!due) {
      log("Up to date with the schedule; no catch-up pass needed.");
      return null;
    }

    if (checked) {
      log(
        `The last successful pass started ${last ? last.toISOString() : "never"}, ` +
          "before the most recent scan window. Catching up now.",
      );
    }

    const settle = settlementDelayMs(timeframes, Date.now(), closeDelayMs);
    if (settle > 0) await sleep(settle, controller.signal);
    if (controller.signal.aborted) return null;

    decidedAt = Date.now();
    outcome = classifyPass(await scan("SCHEDULE", timeframes, userId));
    await maybeSendDailySummary(userId);
  } catch (err) {
    log(`Catch-up pass failed: ${err instanceof Error ? err.message : "unknown error"}`);
    if (decidedAt !== null) outcome = classifyPassError(err, controller.signal.aborted);
  }
  return decidedAt === null ? null : { decidedAt, finishedAt: Date.now(), outcome };
}

interface CatchUpResult {
  decidedAt: number;
  finishedAt: number;
  outcome: PassOutcome;
}

async function main() {
  holdLockOrExit("scanner", log);

  // The scanner keeps its lock while it waits: a second one must not start
  // just because this one is waiting for the database.
  const owner = await withStartupRetries("Looking up the scanner's owner", () =>
    resolveScannerUser(process.env.SCANNER_USER_EMAIL),
  );
  if (owner === STOPPED) {
    log("Stopped.");
    return;
  }

  // Refused before anything is scanned, because the owner decides who every
  // setup, lifecycle event and notification belongs to. A pass that guessed
  // would write all of it against the wrong account.
  if (!owner.ok) {
    log(describeScannerUserFailure(owner.failure));
    process.exitCode = 1;
    return;
  }

  const userId = owner.userId;

  // This process holds the scanner lock and has not started a pass, so no run of
  // its own is live; see `closeAbandonedRuns` for everyone else's.
  await recoverAbandonedRuns();

  log(
    `Universe: every active curated market · timeframes ${timeframes.join(", ")} · ` +
      `concurrency ${concurrency}`,
  );

  if (once) {
    // The same settlement policy the schedule uses. Zero almost always, and a
    // short wait when this pass happens to land in the window just after a
    // candle closed — where the exchange may not have finished settling the bar
    // this scan is about to read. Analysing it early is what churned setups for
    // markets that had not moved.
    const settle = settlementDelayMs(timeframes, Date.now(), closeDelayMs);

    if (settle > 0) {
      log(
        `A candle closed moments ago. Waiting ${Math.ceil(settle / 1000)}s for the exchange to ` +
          "settle it — set SCANNER_CLOSE_DELAY_MS=0 to scan immediately instead.",
      );
      await sleep(settle, controller.signal);
      if (controller.signal.aborted) return;
    }

    await scan("MANUAL", timeframes, userId);
    // Reachable from a single pass too. The dedupe key is the UTC date, so
    // running `scanner:once` five times in an afternoon still produces exactly
    // one summary — the unique index rejects the rest.
    await maybeSendDailySummary(userId);
    return;
  }

  const caughtUp = catchUp ? await maybeCatchUp(userId) : null;

  log(`Scheduling ${closeDelayMs / 1000}s after each candle close. Ctrl-C to stop.`);

  // What each timeframe has been scanned through, and any retry of a failed
  // pass. Everything up to now counts as covered (by the catch-up, or skipped as
  // before); a close still settling does not, so the first plan takes it. A
  // catch-up pass covers what had settled when it *started*, and one that failed
  // transiently is retried like any other. See `ScannedThrough`, `recordPass`.
  let schedule = startSchedule({
    timeframes,
    now: Date.now(),
    delayMs: closeDelayMs,
    catchUp: caughtUp,
  });
  announceRetry(schedule);

  while (!controller.signal.aborted) {
    const wakeAt = nextWake({ state: schedule, timeframes, delayMs: closeDelayMs });
    const waitMs = wakeAt.at - Date.now();

    if (wakeAt.retryAttempt === null) {
      const window = planScan({
        timeframes,
        scannedThrough: schedule.covered,
        delayMs: closeDelayMs,
      });
      log(
        `Next: ${window.timeframes.join(" + ")} at ${new Date(wakeAt.at).toISOString()} ` +
          `(in ${Math.max(0, Math.round(waitMs / 1000))}s)`,
      );
    }

    await sleep(waitMs, controller.signal);
    if (controller.signal.aborted) break;

    // Recalculated from the clock, not taken from the plan: after a sleep, every
    // timeframe that closed meanwhile is due, not just the one the plan named;
    // on a retry, the timeframes the failed pass left uncovered.
    const now = Date.now();
    const wake = scanOnWake({
      timeframes,
      scannedThrough: schedule.covered,
      plannedAt: wakeAt.at,
      now,
      delayMs: closeDelayMs,
    });
    // Only if the clock went backwards; plan again rather than scan.
    if (wake.timeframes.length === 0) {
      schedule = { ...schedule, retry: null };
      continue;
    }
    if (wake.late && wakeAt.retryAttempt === null) {
      log(
        `Woke ${Math.round(wake.lateByMs / 60_000)} min after the planned window — the machine ` +
          `was probably asleep. Scanning ${wake.timeframes.join(" + ")}: every timeframe that ` +
          "closed meanwhile.",
      );
    }

    let outcome: PassOutcome;
    try {
      outcome = classifyPass(await scan("SCHEDULE", wake.timeframes, userId));
      await maybeSendDailySummary(userId);
      // Between passes again: a run abandoned since startup is closed within
      // the hour it becomes old enough, not at the next restart.
      await recoverAbandonedRuns();
    } catch (err) {
      // A pass that blows up must not end the process — the next candle close
      // is another chance, and a scanner that dies overnight is useless.
      log(`Pass failed: ${err instanceof Error ? err.message : "unknown error"}`);
      outcome = classifyPassError(err, controller.signal.aborted);
    }

    schedule = recordPass(schedule, {
      timeframes,
      scanned: wake.timeframes,
      decidedAt: now,
      finishedAt: Date.now(),
      outcome,
      delayMs: closeDelayMs,
    });
    if (outcome === "FAILED_PERMANENT") {
      log(
        "   every market failed, for reasons a retry would not change; moving on to the next window.",
      );
    }
    announceRetry(schedule);

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
