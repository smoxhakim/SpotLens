import { isDatabaseConfigured, prisma } from "@/lib/db/prisma";
import {
  entryZoneEvent,
  groupBySymbol,
  initialMemory,
  mergeMemory,
  planEntryZoneWatch,
  type PriceObservation,
  type StoredWatch,
  type WatchMemory,
  type WatchedSetup,
} from "@/lib/entry-zone";
import { warnOnce } from "@/lib/log";
import { MarketDataError, type MarketDataProvider, type PriceQuote } from "@/lib/market-data";
import { loadSetupFacts } from "@/services/notification-events";
import { deliverEvents, type DeliveryOutcome } from "@/services/notifications";

/**
 * The live entry-zone monitor.
 *
 * One shared price poll for every watched symbol, evaluated in memory against
 * every open setup on that symbol. The database is read on a slow refresh and
 * written only on the two transitions that must survive a restart — a setup
 * first seen outside its zone, and its one alert. A price tick that changes
 * nothing writes nothing.
 *
 * ## What it never does
 *
 * It changes no lifecycle state, runs no confirmation check, creates no
 * decision and rewrites no setup number. It reads `entryLow`/`entryHigh` from
 * the immutable snapshot and compares a price against them; that is the whole
 * of its relationship with a setup.
 *
 * ## Why an alert cannot be duplicated
 *
 * For each alert: write the notification, then mark the watch reached. Never
 * the other way round — marking first and failing before the row exists would
 * lose the alert for good. This order can only ever re-derive the same alert on
 * the next tick, where the unique index on `(userId, channel, dedupeKey)`
 * rejects the second row, and the watch then catches up. The key is the setup
 * id alone, so a restart, a re-entry and a second monitor running at the same
 * moment all collapse to one notification per channel.
 */

export interface RefreshOutcome {
  ok: boolean;
  setups: number;
  symbols: number;
}

export interface TickOutcome {
  /** False when the price poll itself failed; nothing was evaluated. */
  polled: boolean;
  symbols: number;
  quotes: number;
  observed: number;
  skipped: number;
  armed: number;
  alerts: number;
  /** Alerts raised for setups the reload had not yet dropped, but the database had closed. */
  gone: number;
  /** Writes that failed and will be retried on the next tick. */
  failed: number;
}

export interface EntryZoneMonitor {
  refresh(): Promise<RefreshOutcome>;
  tick(): Promise<TickOutcome>;
  /** Setups currently watched, for the process's own logging. */
  watching(): number;
}

export interface MonitorDependencies {
  provider: MarketDataProvider;
  now?: () => number;
  staleAfterMs?: number;
  log?: (message: string) => void;
}

const EMPTY_TICK: TickOutcome = {
  polled: true,
  symbols: 0,
  quotes: 0,
  observed: 0,
  skipped: 0,
  armed: 0,
  alerts: 0,
  gone: 0,
  failed: 0,
};

export function createEntryZoneMonitor(deps: MonitorDependencies): EntryZoneMonitor {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => undefined);

  let setups: WatchedSetup[] = [];
  let memory = new Map<string, WatchMemory>();
  // Symbols the exchange refused as unknown. One delisted market would
  // otherwise fail the shared request for every other market on every tick.
  // Cleared on refresh, so a transient refusal is retried.
  let unknownSymbols = new Set<string>();

  function forget(setupId: string) {
    setups = setups.filter((s) => s.setupId !== setupId);
    memory.delete(setupId);
  }

  async function refresh(): Promise<RefreshOutcome> {
    try {
      const rows = await loadWatchedSetups();
      const next = new Map<string, WatchMemory>();

      for (const { setup, stored } of rows) {
        next.set(
          setup.setupId,
          mergeMemory(memory.get(setup.setupId), initialMemory(setup, stored)),
        );
      }

      setups = rows.map((r) => r.setup);
      memory = next;
      unknownSymbols = new Set();

      return { ok: true, setups: setups.length, symbols: groupBySymbol(setups).size };
    } catch (err) {
      // Keep watching what was already loaded. A reload that fails is a reason
      // to try again later, not to stop watching levels that were fine a
      // minute ago.
      warnOnce("entry-zone:refresh", "[entry-zone] could not reload open setups.", err);
      return { ok: false, setups: setups.length, symbols: groupBySymbol(setups).size };
    }
  }

  async function tick(): Promise<TickOutcome> {
    if (setups.length === 0) return EMPTY_TICK;

    const groups = groupBySymbol(setups);
    const symbols = [...groups.keys()].filter((s) => !unknownSymbols.has(s));

    let quotes: Map<string, PriceQuote>;
    try {
      quotes = await fetchQuotes(deps.provider, symbols, unknownSymbols);
    } catch (err) {
      // No price, no evaluation. Nothing is fabricated, nothing is assumed
      // outside or inside, and the memory of every setup is untouched.
      log(`price poll failed (${errorCode(err)}); nothing evaluated, retrying next tick`);
      return { ...EMPTY_TICK, polled: false, symbols: symbols.length };
    }

    const outcome: TickOutcome = { ...EMPTY_TICK, symbols: symbols.length, quotes: quotes.size };

    for (const [symbol, group] of groups) {
      const quote = quotes.get(symbol);
      if (!quote) continue;

      for (const setup of group) {
        const current = memory.get(setup.setupId) ?? initialMemory(setup, null);
        const observation: PriceObservation = {
          symbol: quote.symbol,
          price: quote.price,
          receivedAt: quote.receivedAt,
        };

        const decision = planEntryZoneWatch({
          setup,
          memory: current,
          observation,
          now: now(),
          staleAfterMs: deps.staleAfterMs,
        });

        if (decision.kind === "SKIPPED") {
          outcome.skipped += 1;
          continue;
        }

        outcome.observed += 1;

        if (decision.arm) {
          if (!(await persistArm(setup, observation.receivedAt))) {
            // Memory is not advanced, so the next tick plans the same write.
            outcome.failed += 1;
            continue;
          }
          outcome.armed += 1;
        }

        if (decision.alert) {
          const result = await raiseAlert(setup, observation);

          if (result === "GONE") {
            outcome.gone += 1;
            forget(setup.setupId);
            continue;
          }

          if (result === "FAILED") {
            outcome.failed += 1;
            continue;
          }

          outcome.alerts += 1;
          log(
            `entry zone reached: ${setup.symbol} ${setup.timeframe} at ${observation.price} ` +
              `(setup ${setup.setupId})`,
          );
        }

        memory.set(setup.setupId, decision.next);
      }
    }

    return outcome;
  }

  return { refresh, tick, watching: () => setups.length };
}

// --- reads -----------------------------------------------------------------

/**
 * Every open tracked setup, for every owner, with what is known about it.
 *
 * Open means not INVALIDATED — the one terminal state. Each setup carries its
 * own owner, and an alert only ever goes to that owner, so watching every
 * account's setups at once cannot cross accounts.
 */
export async function loadWatchedSetups(): Promise<
  { setup: WatchedSetup; stored: StoredWatch | null }[]
> {
  if (!isDatabaseConfigured) return [];

  const rows = await prisma.trackedSetup.findMany({
    where: { status: { not: "INVALIDATED" } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      userId: true,
      timeframe: true,
      entryLow: true,
      entryHigh: true,
      tradingPair: { select: { exchangeSymbol: true } },
      // The creation event's state is what proves a setup began outside.
      events: {
        where: { type: "CREATED" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { toStatus: true },
      },
      entryZoneWatch: { select: { armedAt: true, reachedAt: true } },
    },
  });

  return rows.map((row) => ({
    setup: {
      setupId: row.id,
      userId: row.userId,
      symbol: row.tradingPair.exchangeSymbol,
      timeframe: row.timeframe,
      entryLow: Number(row.entryLow),
      entryHigh: Number(row.entryHigh),
      createdOutside: row.events[0]?.toStatus === "SETUP_FORMING",
    },
    stored: row.entryZoneWatch
      ? {
          armedAt: row.entryZoneWatch.armedAt?.getTime() ?? null,
          reachedAt: row.entryZoneWatch.reachedAt?.getTime() ?? null,
        }
      : null,
  }));
}

/**
 * One shared request for every symbol.
 *
 * If the exchange refuses the batch because one symbol is unknown, each symbol
 * is asked for alone, once, and the refused ones are remembered until the next
 * refresh. A symbol the exchange simply omits is absent — never filled in.
 */
async function fetchQuotes(
  provider: MarketDataProvider,
  symbols: string[],
  unknownSymbols: Set<string>,
): Promise<Map<string, PriceQuote>> {
  if (symbols.length === 0) return new Map();

  try {
    return toMap(await provider.getPrices(symbols));
  } catch (err) {
    if (!(err instanceof MarketDataError) || err.code !== "UNKNOWN_SYMBOL" || symbols.length < 2) {
      throw err;
    }
  }

  const quotes = new Map<string, PriceQuote>();
  for (const symbol of symbols) {
    try {
      for (const quote of await provider.getPrices([symbol])) quotes.set(quote.symbol, quote);
    } catch (err) {
      if (err instanceof MarketDataError && err.code === "UNKNOWN_SYMBOL") {
        unknownSymbols.add(symbol);
        continue;
      }
      throw err;
    }
  }
  return quotes;
}

function toMap(quotes: PriceQuote[]): Map<string, PriceQuote> {
  return new Map(quotes.map((q) => [q.symbol, q]));
}

// --- writes ----------------------------------------------------------------

/**
 * Records that a setup has been seen outside its zone.
 *
 * Insert-if-absent, then set `armedAt` only if still empty: two monitors
 * arming the same setup keep the first time, and neither fails. `skipDuplicates`
 * is `ON CONFLICT DO NOTHING`, so an existing row is not an error — a caught
 * P2002 would still be printed by Prisma's own error log on every alert.
 */
async function persistArm(setup: WatchedSetup, at: number): Promise<boolean> {
  try {
    await stamp(setup, { armedAt: new Date(at) }, "armedAt");
    return true;
  } catch (err) {
    warnOnce("entry-zone:arm", "[entry-zone] could not record an armed setup.", err);
    return false;
  }
}

type AlertResult = "RAISED" | "GONE" | "FAILED";

/**
 * Raises the one alert a setup is allowed.
 *
 * Re-checks the setup is still open, and still this owner's, at the moment of
 * raising — the in-memory list is up to one refresh old, and a scan may have
 * invalidated the setup since. Then notification first, watch second.
 */
async function raiseAlert(
  setup: WatchedSetup,
  observation: PriceObservation,
): Promise<AlertResult> {
  try {
    const open = await prisma.trackedSetup.findFirst({
      where: { id: setup.setupId, userId: setup.userId, status: { not: "INVALIDATED" } },
      select: { id: true },
    });
    if (!open) return "GONE";

    const facts = (await loadSetupFacts([setup.setupId])).get(setup.setupId);
    if (!facts) return "GONE";

    const outcome = await deliverEvents([entryZoneEvent({ setup, facts, observation })]);

    // `deliverEvents` never throws; a delivery that failed outright reports
    // nothing at all. Recorded means a row now exists (or already did), or the
    // owner's preferences declined it — either way the decision is final.
    if (!wasRecorded(outcome)) return "FAILED";

    await markReached(setup, observation);
    return "RAISED";
  } catch (err) {
    warnOnce("entry-zone:alert", "[entry-zone] could not raise an entry-zone alert.", err);
    return "FAILED";
  }
}

export function wasRecorded(outcome: DeliveryOutcome): boolean {
  return outcome.created + outcome.duplicates + outcome.suppressed > 0;
}

/** Stamps the alert onto the watch, once. A second writer leaves the first stamp. */
async function markReached(setup: WatchedSetup, observation: PriceObservation): Promise<void> {
  await stamp(
    setup,
    { reachedAt: new Date(observation.receivedAt), reachedPrice: observation.price },
    "reachedAt",
  );
}

/**
 * Writes one watch field set, once, on a row that may or may not exist yet.
 *
 * The row is created if absent; if it already existed, the fields are written
 * only where `guard` is still null. Either way the first writer's value stands.
 */
async function stamp(
  setup: WatchedSetup,
  data: { armedAt: Date } | { reachedAt: Date; reachedPrice: number },
  guard: "armedAt" | "reachedAt",
): Promise<void> {
  const created = await prisma.setupEntryZoneWatch.createMany({
    data: [{ trackedSetupId: setup.setupId, userId: setup.userId, ...data }],
    skipDuplicates: true,
  });
  if (created.count > 0) return;

  await prisma.setupEntryZoneWatch.updateMany({
    where: { trackedSetupId: setup.setupId, userId: setup.userId, [guard]: null },
    data,
  });
}

/**
 * A provider failure, reduced to its category.
 *
 * Never the message: a `MarketDataError` can carry a snippet of the response
 * body, and nothing from a provider belongs in a log line verbatim.
 */
function errorCode(err: unknown): string {
  return err instanceof MarketDataError ? err.code : "UNKNOWN";
}
