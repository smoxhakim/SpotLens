const seen = new Set<string>();

/**
 * Logs a warning the first time a given key is hit. Used for expected,
 * persistent degradations (e.g. no database configured) so they are visible
 * once instead of on every request.
 */
export function warnOnce(key: string, message: string, detail?: unknown) {
  if (seen.has(key)) return;
  seen.add(key);
  if (detail === undefined) console.warn(message);
  else console.warn(message, detail instanceof Error ? detail.message : detail);
}
