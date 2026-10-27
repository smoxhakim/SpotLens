import { describe, expect, it } from "vitest";

import { runAnalysis, staleEntryTimeframe, type AnalysisResult } from "@/lib/analysis";
import { downtrend, pullbackIntoSupport } from "@/lib/test-utils/scenarios";

import { mtfOf } from "./corpus";
import { canonicalJson, decodeCanonical, fingerprint, fingerprintLine } from "./fingerprint";

/**
 * The fingerprint is only a guarantee if the serialisation behind it loses
 * nothing. These check that directly: it is deterministic, independent of key
 * order, exact about numbers, explicit about what JSON would hide, refuses what
 * it cannot represent, and round-trips real analysis results without a single
 * difference.
 */

const roundTrip = (value: unknown) => decodeCanonical(JSON.parse(canonicalJson(value)));

describe("canonical serialisation", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,1,2]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("writes numbers exactly, with no rounding", () => {
    expect(canonicalJson(0.1 + 0.2)).toBe("0.30000000000000004");
    expect(canonicalJson(1e-7)).toBe("1e-7");
    expect(canonicalJson(123456789.12345679)).toBe(String(123456789.12345679));
    // Two doubles a single unit in the last place apart stay apart.
    expect(canonicalJson(1)).not.toBe(canonicalJson(1 + Number.EPSILON));
  });

  it("tags the numbers JSON would turn into null or 0", () => {
    expect(canonicalJson(NaN)).toBe('{"$number":"NaN"}');
    expect(canonicalJson(Infinity)).toBe('{"$number":"Infinity"}');
    expect(canonicalJson(-Infinity)).toBe('{"$number":"-Infinity"}');
    expect(canonicalJson(-0)).toBe('{"$number":"-0"}');
    expect(canonicalJson(0)).toBe("0");
  });

  it("keeps a key whose value is undefined, distinct from a missing key", () => {
    expect(canonicalJson({ a: undefined })).toBe('{"a":{"$undefined":true}}');
    expect(canonicalJson({ a: undefined })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({ a: undefined }));
  });

  it("refuses anything that is not plain data, rather than dropping it", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: number[] = new Array(3);
    sparse[0] = 1;
    sparse[2] = 3;

    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson({ s: Symbol("x") })).toThrow(TypeError);
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow(TypeError);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson({ m: new Map() })).toThrow(TypeError);
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
    expect(() => canonicalJson(sparse)).toThrow(TypeError);
    expect(() => canonicalJson({ $number: "1" })).toThrow(TypeError);
  });

  it("encodes the same value nested twice, which is not a cycle", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("decodes back to exactly the value it encoded", () => {
    const value = {
      text: "line\nbreak, a tab\t, a backslash \\ and ünïcode",
      flags: [true, false, null],
      numbers: [0, -0, NaN, Infinity, -Infinity, 1e-7, 0.30000000000000004],
      missing: undefined,
      nested: { deeper: { list: [{ a: 1 }, { b: [2, 3] }] } },
    };

    expect(roundTrip(value)).toStrictEqual(value);
  });
});

describe("fingerprints of real analysis results", () => {
  const results: [string, AnalysisResult][] = [
    ["a potential setup", runAnalysis(pullbackIntoSupport())],
    ["an avoid, with levels withheld", runAnalysis(downtrend())],
    [
      "a higher-timeframe veto",
      runAnalysis(pullbackIntoSupport(), { mtf: mtfOf(pullbackIntoSupport(), downtrend()) }),
    ],
    [
      "a result held for incomplete data",
      runAnalysis(pullbackIntoSupport(), { incomplete: staleEntryTimeframe("H1") }),
    ],
    ["an empty series", runAnalysis([])],
  ];

  it.each(results)("loses nothing when encoding %s", (_name, result) => {
    expect(roundTrip(result)).toStrictEqual(result);
  });

  it("is identical across repeated runs of the engine", () => {
    expect(fingerprint(runAnalysis(pullbackIntoSupport()))).toBe(
      fingerprint(runAnalysis(pullbackIntoSupport())),
    );
  });

  it("changes when any single field changes", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const base = fingerprint(result);

    expect(fingerprint({ ...result, statusReason: `${result.statusReason} ` })).not.toBe(base);
    expect(fingerprint({ ...result, extra: undefined })).not.toBe(base);
    expect(
      fingerprint({ ...result, read: { ...result.read, price: result.read.price + 1e-9 } }),
    ).not.toBe(base);
  });

  it("lists every top-level key of an object in its golden line", () => {
    const result = runAnalysis(pullbackIntoSupport());
    const sections = fingerprintLine("id", result).split("\t")[3];

    expect(sections.split(" ").map((s) => s.split("=")[0])).toEqual(Object.keys(result).sort());
  });
});
