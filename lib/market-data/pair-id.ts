import { createHash } from "node:crypto";

/** Fixed namespace so fallback ids are stable across processes and restarts. */
const NAMESPACE = "8f4c1f52-8f9f-4a6d-9b6a-0f1f2b3c4d5e";

/**
 * Deterministic UUIDv5 for a trading pair, used when no database is configured
 * so the API can still hand the client a real uuid. With a database, ids come
 * from Postgres instead.
 */
export function deterministicPairId(exchangeSymbol: string): string {
  const ns = Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(exchangeSymbol.toUpperCase(), "utf8").digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}
