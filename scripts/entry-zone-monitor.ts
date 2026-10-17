/**
 * The live entry-zone monitor process.
 *
 * Separate from the scanner on purpose. The scanner reads closed candles and
 * wakes when one closes; this reads the current price every few seconds and
 * knows nothing about candles. Running one does not require the other, and
 * neither can slow or distort the other.
 *
 *   npm run spotlens       — the usual way: run with the scanner, under the engine
 *   npm run monitor        — poll until stopped (Ctrl-C)
 *   npm run monitor:once   — load setups, poll once, report, exit
 *
 *   ENTRY_MONITOR_POLL_MS           price poll interval        (default 10000, min 2000)
 *   ENTRY_MONITOR_REFRESH_MS        full open-setup reload     (default 600000, min 60000)
 *   ENTRY_MONITOR_SCANNER_CHECK_MS  new-scanner-run check      (default 60000, min 10000)
 *
 * Open setups are reloaded when a scan completes — at once when the engine
 * relays it, or at the next scanner-run check otherwise — and on the full
 * interval as a safety net. One monitor per machine: a second one exits.
 *
 * Public market data only. No API key, no account, and nothing here — or
 * anywhere in SpotLens — can place an order.
 */
import { prisma } from "@/lib/db/prisma";
import { holdLockOrExit, isScannerRunCompleted } from "@/lib/engine";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_REFRESH_INTERVAL_MS,
  DEFAULT_SCANNER_CHECK_MS,
  planRefresh,
} from "@/lib/entry-zone";
import { getMarketDataProvider } from "@/lib/market-data";
import { sleep } from "@/lib/scanner/concurrency";
import { createEntryZoneMonitor, type TickOutcome } from "@/services/entry-zone-monitor";

const once = process.argv.includes("--once");

const pollMs = readNumber("ENTRY_MONITOR_POLL_MS", DEFAULT_POLL_INTERVAL_MS, 2_000);
const refreshMs = readNumber("ENTRY_MONITOR_REFRESH_MS", DEFAULT_REFRESH_INTERVAL_MS, 60_000);
const scannerCheckMs = readNumber(
  "ENTRY_MONITOR_SCANNER_CHECK_MS",
  DEFAULT_SCANNER_CHECK_MS,
  10_000,
);

const controller = new AbortController();
let stopping = false;

// "A scan completed", relayed by the engine. It cuts the current wait short
// and asks for a reload; the message itself carries nothing the monitor uses.
let reloadRequested = false;
let wake = new AbortController();
process.on("message", (message) => {
  if (!isScannerRunCompleted(message)) return;
  reloadRequested = true;
  wake.abort();
});
// Under the engine this process has an IPC channel, and a channel with a
// listener keeps a process alive after its work is done — observed as a monitor
// that printed "Stopped." and then sat until the engine's stop timeout killed
// it. Unref'd, the channel still delivers messages but no longer holds the
// process open; the poll loop is what keeps it running.
process.channel?.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    controller.abort();
    log("Stopping after the current poll. Press Ctrl-C again to force.");
  });
}

async function main() {
  holdLockOrExit("entry-zone", log);

  const monitor = createEntryZoneMonitor({ provider: getMarketDataProvider(), log });

  log(
    `Polling every ${pollMs / 1000}s; reloading setups when a scan completes ` +
      `(checked every ${Math.round(scannerCheckMs / 1000)}s, or at once under the engine) ` +
      `and every ${Math.round(refreshMs / 60_000)}m regardless. ` +
      "Public prices only; informational alerts only.",
  );

  let lastRefresh = -Infinity;
  let lastScannerCheck = -Infinity;
  let lastPollFailed = false;

  async function reload(reason: string, started: number) {
    reloadRequested = false;
    const refreshed = await monitor.refresh();
    // A failed reload is retried on the next tick rather than after a full
    // interval; the previous list keeps being watched meanwhile.
    if (refreshed.ok) {
      lastRefresh = started;
      lastScannerCheck = started;
    }
    log(
      `${refreshed.ok ? "Watching" : "Reload failed; still watching"} ` +
        `${refreshed.setups} open setups across ${refreshed.symbols} markets (${reason}).`,
    );
  }

  while (!controller.signal.aborted) {
    const started = Date.now();

    const plan = planRefresh({
      now: started,
      lastFullRefreshAt: lastRefresh,
      refreshMs,
      requested: reloadRequested,
      lastScannerCheckAt: lastScannerCheck,
      scannerCheckMs,
    });

    if (plan === "FULL") {
      await reload(lastRefresh === -Infinity ? "startup" : "periodic reload", started);
    } else if (plan === "REQUESTED") {
      await reload("a scan just completed", started);
    } else if (plan === "CHECK_SCANNER") {
      lastScannerCheck = started;
      const newer = await monitor.newerScannerRun();
      if (newer) await reload(`new scanner run ${newer.slice(0, 8)}`, started);
    }

    const outcome = await monitor.tick();

    if (!outcome.polled) lastPollFailed = true;
    else if (lastPollFailed) {
      lastPollFailed = false;
      log("Price poll recovered.");
    }

    if (once || isNoteworthy(outcome)) log(describe(outcome));
    if (once) break;

    if (!reloadRequested) wake = new AbortController();
    await sleep(
      Math.max(0, pollMs - (Date.now() - started)),
      AbortSignal.any([controller.signal, wake.signal]),
    );
  }

  log("Stopped.");
}

/** Quiet unless something happened — a ten-second loop should not scroll. */
function isNoteworthy(o: TickOutcome): boolean {
  return o.armed > 0 || o.alerts > 0 || o.failed > 0 || o.gone > 0;
}

function describe(o: TickOutcome): string {
  if (!o.polled) return `Poll failed for ${o.symbols} markets; nothing evaluated.`;
  return (
    `${o.quotes}/${o.symbols} prices · ${o.observed} observed · ${o.skipped} skipped · ` +
    `${o.armed} armed · ${o.alerts} alerts · ${o.failed} retrying · ${o.gone} closed`
  );
}

function readNumber(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  // A floor, so a typo cannot turn the poll into a rate-limit incident.
  return Math.max(value, min);
}

function log(message: string) {
  console.log(`[entry-zone ${new Date().toISOString()}] ${message}`);
}

main()
  .catch((err) => {
    log(`Fatal: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
