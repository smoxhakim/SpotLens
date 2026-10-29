"use client";

import { useEffect, useState } from "react";

/**
 * The current time, re-read on an interval.
 *
 * Freshness is judged against this rather than against the moment a page
 * loaded, so a page left open turns stale by itself when a candle closes. It
 * only re-renders; it fetches nothing and starts nothing.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
