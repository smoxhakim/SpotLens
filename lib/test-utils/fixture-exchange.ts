import { readFileSync } from "node:fs";
import http from "node:http";
import type net from "node:net";
import { gunzipSync } from "node:zlib";

/**
 * Stand-ins for the outside world, on this machine. The fault tests never reach Binance
 * or Telegram: the exchange is one of these servers, and `stubNetwork` answers Telegram
 * in-process and refuses every other host.
 */

const CANDLE_MS: Record<string, number> = { H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 };
const INTERVAL_TO_TIMEFRAME: Record<string, string> = { "1h": "H1", "4h": "H4", "1d": "D1" };

export interface ExchangeClock {
  readonly now: number;
}

interface RunningExchange {
  port: number;
  counters: { requests: number };
  close: () => Promise<void>;
}

function serve(handler: (url: URL, res: http.ServerResponse) => void): Promise<RunningExchange> {
  const counters = { requests: 0 };
  const server = http.createServer((req, res) => {
    counters.requests += 1;
    handler(new URL(req.url!, "http://exchange.test"), res);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        counters,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    ),
  );
}

interface FixtureCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type FixtureSeries = { H1: FixtureCandle[]; H4: FixtureCandle[] } | { status: number };

/**
 * Serves fixture candles for any symbol, ending at the last close before the clock, plus
 * a forming candle as the real exchange does. A symbol's entry can instead be a status
 * to answer with, and an unknown symbol is refused the way Binance refuses one.
 */
export async function startFixtureExchange(clock: ExchangeClock) {
  const series = new Map<string, FixtureSeries>();
  const running = await serve((url, res) => {
    const timeframe = INTERVAL_TO_TIMEFRAME[url.searchParams.get("interval")!];
    const spec = series.get(url.searchParams.get("symbol")!);
    if (!spec || "status" in spec) {
      res
        .writeHead(spec && "status" in spec ? spec.status : 400, {
          "content-type": "application/json",
        })
        .end(JSON.stringify({ code: -1121, msg: "Invalid symbol." }));
      return;
    }
    const candles = spec[timeframe as "H1" | "H4"] ?? spec.H4;
    const size = CANDLE_MS[timeframe];
    const bucket = Math.floor(clock.now / size) * size;
    const rows: unknown[][] = candles.map((c, i) => {
      const open = bucket - (candles.length - i) * size;
      return [
        open,
        String(c.open),
        String(c.high),
        String(c.low),
        String(c.close),
        String(c.volume),
        open + size - 1,
      ];
    });
    const last = String(candles.at(-1)!.close);
    rows.push([bucket, last, last, last, last, "0", bucket + size - 1]);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(rows));
  });
  return { ...running, series };
}

/**
 * Serves recorded candles as of the clock, from a gzipped CSV of
 * `symbol,timeframe,openTime,open,high,low,close,volume,closeTime`.
 */
export async function startRecordedExchange(gzPath: string, clock: ExchangeClock) {
  const index = new Map<string, string[][]>();
  for (const line of gunzipSync(readFileSync(gzPath)).toString("utf8").split("\n")) {
    if (!line) continue;
    const cells = line.split(",");
    const key = `${cells[0]}|${cells[1]}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(cells);
  }
  return serve((url, res) => {
    const timeframe = INTERVAL_TO_TIMEFRAME[url.searchParams.get("interval")!];
    const rows = index.get(`${url.searchParams.get("symbol")}|${timeframe}`);
    if (!rows) {
      res.writeHead(400).end("[]");
      return;
    }
    const size = CANDLE_MS[timeframe];
    const bucket = Math.floor(clock.now / size) * size;
    const limit = Number(url.searchParams.get("limit") ?? 500);
    const closed = rows.filter((r) => Number(r[2]) < bucket);
    const seen: unknown[][] = closed
      .slice(-(limit - 1))
      .map((r) => [Number(r[2]), r[3], r[4], r[5], r[6], r[7], Number(r[8])]);
    const lastClose = closed.at(-1)![6];
    // The forming candle: an open and very little else, as at the start of a bar.
    seen.push([
      bucket,
      lastClose,
      lastClose,
      lastClose,
      lastClose,
      "0.00000000",
      bucket + size - 1,
    ]);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(seen));
  });
}

export interface StubbedNetwork {
  mode: "OK" | "500" | "TIMEOUT";
  /** Which delivery a send belongs to, set by the test around each one. */
  phase: string;
  sends: { phase: string; text: string }[];
  /** Runs inside the next send, before it is answered. */
  onSend: null | (() => Promise<void>);
  /** Every host that something tried to reach and was refused. Should stay empty. */
  blocked: string[];
  restore: () => void;
}

/**
 * Replaces `fetch` in this process. Telegram is answered here, so nothing is ever sent
 * and no token is ever read by anyone. This machine passes, for the fixture exchange.
 * Anything else is refused and recorded.
 */
export function stubNetwork(): StubbedNetwork {
  const real = globalThis.fetch;
  const net: StubbedNetwork = {
    mode: "OK",
    phase: "NONE",
    sends: [],
    onSend: null,
    blocked: [],
    restore: () => {
      globalThis.fetch = real;
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname === "api.telegram.org") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      net.sends.push({ phase: net.phase, text: body.text ?? "" });
      if (net.onSend) {
        const during = net.onSend;
        net.onSend = null;
        await during();
      }
      if (net.mode === "500") {
        return new Response(JSON.stringify({ ok: false, description: "stub" }), { status: 500 });
      }
      if (net.mode === "TIMEOUT") {
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (url.hostname !== "127.0.0.1") {
      net.blocked.push(url.hostname);
      throw new Error(`blocked: ${url.hostname}`);
    }
    return real(input, init);
  }) as typeof fetch;
  return net;
}
