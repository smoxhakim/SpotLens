import { describe, expect, it } from "vitest";

import { formatCompact, formatPercent, formatPrice, priceDecimals, priceMinMove } from "./format";

/**
 * Price formatting is the one thing every surface shares.
 *
 * The chart axis, the crosshair, the entry under it, a Telegram message and
 * the risk calculator all render the same float, and the moment two of them
 * disagree about precision the product looks like it is quoting two prices.
 * So these tests pin the behaviour rather than the implementation.
 */

describe("precision follows the order of magnitude", () => {
  const cases: [string, number, string][] = [
    ["a four-figure price keeps cents", 75968, "75,968.00"],
    ["a large price with real cents", 3412.45, "3,412.45"],
    ["a two-figure price keeps four decimals", 50.92, "50.9200"],
    ["a single-figure price keeps four decimals", 6.797, "6.7970"],
    ["a price just above one", 1.0001, "1.0001"],
    ["a sub-unit price keeps five decimals", 0.12345, "0.12345"],
    ["a support zone edge", 0.05382, "0.05382"],
    ["a very low price keeps eight decimals", 0.0004912, "0.00049120"],
    ["an integer price is padded, not truncated", 50, "50.0000"],
    ["zero", 0, "0.00000000"],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(formatPrice(input)).toBe(expected);
  });

  it("separates thousands", () => {
    expect(formatPrice(1_234_567.891)).toBe("1,234,567.89");
  });

  it("keeps the sign on a negative value", () => {
    // Not a price in practice, but the formatter is used for deltas too and
    // must not silently drop the sign.
    expect(formatPrice(-50.92)).toBe("-50.9200");
  });
});

describe("what it must never emit", () => {
  const values = [0.0000004, 0.00000001, 1e-7, 75968.123456, 1e9, 0.1 + 0.2];

  it.each(values)("never uses scientific notation for %s", (value) => {
    // `String(0.0000004)` is "4e-7". A price axis reading 4e-7 is unusable,
    // and toLocaleString is what rules it out.
    expect(formatPrice(value)).not.toMatch(/e[+-]/i);
  });

  it.each(values)("never abbreviates %s with a magnitude suffix", (value) => {
    expect(formatPrice(value)).not.toMatch(/[KMB]/);
  });

  it("abbreviates only where abbreviation is the point", () => {
    // formatCompact is for volume, where "347.31K" is the readable form.
    expect(formatCompact(347_310)).toMatch(/K/);
    // ...and formatPrice is not, for the same number.
    expect(formatPrice(347_310)).toBe("347,310.00");
  });
});

describe("absent and unusable values", () => {
  it.each([null, undefined, NaN, Infinity, -Infinity])("renders %s as an em dash", (value) => {
    expect(formatPrice(value as number)).toBe("—");
  });
});

describe("decimals and tick size agree", () => {
  it.each([
    [75968, 2, 0.01],
    [50.92, 4, 0.0001],
    [0.12345, 5, 0.00001],
    [0.0004912, 8, 0.00000001],
  ])("%s → %s decimals, minMove %s", (price, decimals, minMove) => {
    expect(priceDecimals(price)).toBe(decimals);
    expect(priceMinMove(price)).toBe(minMove);
  });

  it("never ticks more finely than the label can render", () => {
    // Two gridlines carrying the same number is what happens when these drift
    // apart, so the relationship is asserted rather than assumed.
    for (const price of [0.00001, 0.005, 0.5, 5, 500, 5000, 50000]) {
      const rendered =
        formatPrice(price)
          .replace(/[^0-9.]/g, "")
          .split(".")[1] ?? "";
      expect(rendered.length).toBe(priceDecimals(price));
      expect(priceMinMove(price)).toBeCloseTo(10 ** -priceDecimals(price), 10);
    }
  });

  it("is a pure function of the magnitude, whatever the sign", () => {
    expect(priceDecimals(-50.92)).toBe(priceDecimals(50.92));
    expect(priceMinMove(-0.0004912)).toBe(priceMinMove(0.0004912));
  });
});

describe("the other formatters are unchanged", () => {
  it("formats a percentage with an explicit sign", () => {
    expect(formatPercent(3.27)).toBe("+3.27%");
    expect(formatPercent(-3.27)).toBe("-3.27%");
    expect(formatPercent(null)).toBe("—");
  });
});
