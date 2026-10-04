/**
 * The live entry-zone monitor process.
 *
 * Separate from the scanner on purpose. The scanner reads closed candles and
 * wakes when one closes; this reads the current price every few seconds and
 * knows nothing about candles. Running one does not require the other, and
 * neither can slow or distort the other.
 *
 *   npm run monitor        — poll until stopped (Ctrl-C)
 *   npm run monitor:once   — load setups, poll once, report, exit
 *
 *   ENTRY_MONITOR_POLL_MS     price poll interval     (default 10000, min 2000)
 *   ENTRY_MONITOR_REFRESH_MS  open-setup reload interval (default 600000, min 60000)
 *
 * Public market data only. No API key, no account, and nothing here — or
 * anywhere in SpotLens — can place an order.
 */
import { prisma } from "@/lib/db/prisma";
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_REFRESH_INTERVAL_MS } from "@/lib/entry-zone";
import { getMarketDataProvider } from "@/lib/market-data";
import { sleep } from "@/lib/scanner/concurrency";
import { createEntryZoneMonitor, type TickOutcome } from "@/services/entry-zone-monitor";

const once = process.argv.includes("--once");

const pollMs = readNumber("ENTRY_MONITOR_POLL_MS", DEFAULT_POLL_INTERVAL_MS, 2_000);
const refreshMs = readNumber("ENTRY_MONITOR_REFRESH_MS", DEFAULT_REFRESH_INTERVAL_MS, 60_000);

const controller = new AbortController();
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    controller.abort();
    log("Stopping after the current poll. Press Ctrl-C again to force.");
  });
}

async function main() {
  const monitor = createEntryZoneMonitor({ provider: getMarketDataProvider(), log });

  log(
    `Polling every ${pollMs / 1000}s, reloading setups every ${Math.round(refreshMs / 60_000)}m. ` +
      "Public prices only; informational alerts only.",
  );

  let lastRefresh = -Infinity;
  let lastPollFailed = false;

  while (!controller.signal.aborted) {
    const started = Date.now();

    if (started - lastRefresh >= refreshMs) {
      const refreshed = await monitor.refresh();
      // A failed reload is retried on the next tick rather than after a full
      // interval; the previous list keeps being watched meanwhile.
      if (refreshed.ok) lastRefresh = started;
      log(
        `${refreshed.ok ? "Watching" : "Reload failed; still watching"} ` +
          `${refreshed.setups} open setups across ${refreshed.symbols} markets.`,
      );
    }

    const outcome = await monitor.tick();

    if (!outcome.polled) lastPollFailed = true;
    else if (lastPollFailed) {
      lastPollFailed = false;
      log("Price poll recovered.");
    }

    if (once || isNoteworthy(outcome)) log(describe(outcome));
    if (once) break;

    await sleep(Math.max(0, pollMs - (Date.now() - started)), controller.signal);
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
