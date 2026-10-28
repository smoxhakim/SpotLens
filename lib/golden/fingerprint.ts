import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/**
 * Full-result fingerprints for the golden-master baseline (Phase 5, step 0.5).
 *
 * The projection golden files (`project.ts`) record named fields, rounded to
 * twelve significant digits, so a diff in them is readable. What they cannot
 * see is a field they do not name: an added or removed key, a swing point, a
 * reason on one of the prefix cases, an explanation's detail. This closes that
 * gap. Every complete object is serialised canonically and hashed, so any
 * difference anywhere in it — a value, a key, a type — changes the fingerprint.
 *
 * ## Serialisation: `spotlens-canonical-json/1`
 *
 * JSON, with the rules plain `JSON.stringify` does not follow:
 *
 *   - Object keys are sorted by UTF-16 code unit, at every depth. Array order is
 *     kept: it is data.
 *   - Numbers are exact: the shortest text that round-trips the double, with no
 *     rounding. NaN, Infinity, -Infinity and -0 are written as
 *     `{"$number":"NaN"}` and so on, because JSON would turn the first three
 *     into `null` and the last into `0`.
 *   - A key whose value is `undefined` is kept, written as `{"$undefined":true}`,
 *     so a key that exists and holds nothing differs from a key that is absent.
 *     `JSON.stringify` drops it.
 *   - Anything that is not plain data throws instead of being dropped or
 *     coerced: a function, a symbol, a bigint, a class instance (a Map, a Date),
 *     a cycle, a sparse array, or an object key beginning with `$`, which would
 *     be ambiguous with the tags above.
 *
 * The fingerprint is the SHA-256 of that text encoded as UTF-8, in lowercase
 * hex. `decodeCanonical` reverses the tags, so a test can prove the encoding
 * loses nothing.
 *
 * Test code only — nothing in the application imports this file.
 */
export const FINGERPRINT_FORMAT = "spotlens-canonical-json/1, sha256 over utf-8, hex";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeNumber(value: number): string {
  if (Number.isNaN(value)) return '{"$number":"NaN"}';
  if (value === Infinity) return '{"$number":"Infinity"}';
  if (value === -Infinity) return '{"$number":"-Infinity"}';
  if (Object.is(value, -0)) return '{"$number":"-0"}';
  return String(value);
}

function encode(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return encodeNumber(value);
    case "undefined":
      return '{"$undefined":true}';
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: cannot encode a ${typeof value} at ${path}`);
  }

  const node = value as object;
  if (ancestors.has(node)) throw new TypeError(`canonicalJson: cycle at ${path}`);

  if (Array.isArray(node)) {
    ancestors.add(node);
    const items: string[] = [];
    for (let index = 0; index < node.length; index += 1) {
      // A hole is neither a value nor `undefined`, and JSON has no way to say so.
      if (!(index in node)) throw new TypeError(`canonicalJson: sparse array at ${path}`);
      items.push(encode(node[index], `${path}[${index}]`, ancestors));
    }
    ancestors.delete(node);
    return `[${items.join(",")}]`;
  }

  if (!isPlainObject(node)) {
    const name = Object.getPrototypeOf(node)?.constructor?.name ?? "unknown";
    throw new TypeError(`canonicalJson: cannot encode a ${name} instance at ${path}`);
  }

  ancestors.add(node);
  const keys = Object.keys(node).sort();
  const fields = keys.map((key) => {
    if (key.startsWith("$")) {
      throw new TypeError(`canonicalJson: key "${key}" at ${path} is reserved for tags`);
    }
    return `${JSON.stringify(key)}:${encode(node[key], `${path}.${key}`, ancestors)}`;
  });
  ancestors.delete(node);
  return `{${fields.join(",")}}`;
}

/** The canonical text of a value. Throws on anything that is not plain data. */
export function canonicalJson(value: unknown): string {
  return encode(value, "$", new Set());
}

/**
 * The reverse of the tags `canonicalJson` writes, applied to its parsed text.
 * Used by the tests to prove a round trip returns exactly the original value.
 */
export function decodeCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeCanonical);
  if (!isPlainObject(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$undefined" && value.$undefined === true) return undefined;
  if (keys.length === 1 && keys[0] === "$number") {
    switch (value.$number) {
      case "NaN":
        return NaN;
      case "Infinity":
        return Infinity;
      case "-Infinity":
        return -Infinity;
      case "-0":
        return -0;
    }
  }

  return Object.fromEntries(keys.map((key) => [key, decodeCanonical(value[key])]));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The fingerprint of a value: SHA-256 of its canonical text. */
export function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

/**
 * One golden line: an id, the fingerprint, and the canonical text's size.
 *
 * The full fingerprint is the guarantee. The rest is for diagnosis when it
 * changes: an array's length, or — for an object — every top-level key with a
 * short hash of its value, so a mismatch shows which part of the object moved
 * and whether a key was added or removed. Use the projection golden files to
 * see what the change was.
 */
export function fingerprintLine(id: string, value: unknown): string {
  const text = canonicalJson(value);
  const parts = [id, sha256(text), `${Buffer.byteLength(text, "utf8")}B`];

  if (Array.isArray(value)) {
    parts.push(`items=${value.length}`);
  } else if (isPlainObject(value)) {
    const sections = Object.keys(value)
      .sort()
      .map((key) => `${key}=${fingerprint(value[key]).slice(0, 12)}`);
    parts.push(sections.join(" "));
  }

  return parts.join("\t");
}
