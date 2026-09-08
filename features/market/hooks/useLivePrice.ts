"use client";

import { useEffect, useRef, useState } from "react";

const WS_BASE = process.env.NEXT_PUBLIC_BINANCE_WS_BASE_URL || "wss://stream.binance.com:9443";
const MAX_BACKOFF_MS = 30_000;

export interface LivePrice {
  price: number;
  change24hPct: number;
  at: number;
}

/**
 * Streams the exchange's 24h mini-ticker for one symbol straight to the browser
 * — no server relay, per the architecture. TanStack Query polling in
 * `useTicker` remains the fallback whenever this is disconnected.
 */
export function useLivePrice(exchangeSymbol?: string) {
  const [price, setPrice] = useState<LivePrice | null>(null);
  const [connected, setConnected] = useState(false);
  const attemptRef = useRef(0);

  useEffect(() => {
    if (!exchangeSymbol || typeof window === "undefined") return;

    setPrice(null);
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const connect = () => {
      if (closed) return;
      socket = new WebSocket(`${WS_BASE}/ws/${exchangeSymbol.toLowerCase()}@ticker`);

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as {
            c?: string;
            P?: string;
            E?: number;
          };
          const last = Number(data.c);
          if (!Number.isFinite(last)) return;
          setPrice({
            price: last,
            change24hPct: Number(data.P ?? 0),
            at: data.E ?? Date.now(),
          });
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        // Exponential backoff with jitter, so a provider blip doesn't turn into
        // a reconnect storm across open tabs.
        const delay = Math.min(1000 * 2 ** attemptRef.current, MAX_BACKOFF_MS);
        attemptRef.current += 1;
        retryTimer = setTimeout(connect, delay * (0.5 + Math.random() / 2));
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
      setConnected(false);
    };
  }, [exchangeSymbol]);

  return { price, connected };
}
