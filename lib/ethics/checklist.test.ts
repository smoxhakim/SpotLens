import { describe, expect, it } from "vitest";

import { CURATED_ASSETS } from "@/lib/market-data/curated-assets";

import { ETHICAL_CHECKLISTS, findChecklist } from "./checklist";

describe("ethical research checklist", () => {
  it("covers every curated asset", () => {
    const covered = new Set(ETHICAL_CHECKLISTS.map((c) => c.symbol));
    const missing = CURATED_ASSETS.filter((a) => !covered.has(a.symbol)).map((a) => a.symbol);

    expect(missing).toEqual([]);
  });

  it("has no duplicate entries", () => {
    const symbols = ETHICAL_CHECKLISTS.map((c) => c.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("explains every answer", () => {
    // An answer without a reason is a verdict, which is exactly what this
    // checklist must not be.
    for (const entry of ETHICAL_CHECKLISTS) {
      expect(entry.whatProjectDoes.length, entry.symbol).toBeGreaterThan(40);
      expect(entry.tokenUtility.length, entry.symbol).toBeGreaterThan(30);
      expect(entry.involvesInterestLendingNote.length, entry.symbol).toBeGreaterThan(30);
      expect(entry.supportsGamblingNote.length, entry.symbol).toBeGreaterThan(30);
      expect(entry.supportsProhibitedNote.length, entry.symbol).toBeGreaterThan(30);
      expect(entry.hasClearUtilityNote.length, entry.symbol).toBeGreaterThan(30);
    }
  });

  it("never rules on permissibility", () => {
    // The checklist is research material. Any wording that reads as a ruling
    // contradicts the disclaimer it ships with.
    const forbidden = /\b(halal|haram|permissible|impermissible|forbidden|sinful|compliant)\b/i;

    for (const entry of ETHICAL_CHECKLISTS) {
      const text = [
        entry.whatProjectDoes,
        entry.tokenUtility,
        entry.involvesInterestLendingNote,
        entry.supportsGamblingNote,
        entry.supportsProhibitedNote,
        entry.hasClearUtilityNote,
      ].join(" ");

      expect(text, entry.symbol).not.toMatch(forbidden);
    }
  });

  it("answers YES for protocols whose core business is interest-bearing lending", () => {
    for (const symbol of ["AAVE", "COMP", "SKY"]) {
      const entry = findChecklist(symbol)!;
      expect(entry.involvesInterestLending, symbol).toBe("YES");
      expect(entry.involvesInterestLendingNote, symbol).toMatch(/interest|stability fee/i);
    }
  });

  it("does not claim a general-purpose chain is free of what runs on it", () => {
    // Ethereum does not lend, but lending protocols run on it. A flat "no"
    // would hide the distinction the reader came here for.
    const eth = findChecklist("ETH")!;
    expect(eth.involvesInterestLending).toBe("UNCLEAR");
    expect(eth.involvesInterestLendingNote).toMatch(/third parties|infrastructure/i);
  });

  it("answers NO where a network genuinely does not host applications", () => {
    const btc = findChecklist("BTC")!;
    expect(btc.involvesInterestLending).toBe("NO");
    expect(btc.supportsGambling).toBe("NO");
  });

  it("uses only the three allowed answers", () => {
    for (const entry of ETHICAL_CHECKLISTS) {
      for (const answer of [
        entry.involvesInterestLending,
        entry.supportsGambling,
        entry.supportsProhibitedIndustries,
        entry.hasClearUtility,
      ]) {
        expect(["YES", "NO", "UNCLEAR"]).toContain(answer);
      }
    }
  });
});
