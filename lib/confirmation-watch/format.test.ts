import { describe, expect, it } from "vitest";

import { ANALYSIS_DISCLAIMER, SPOT_ONLY_NOTE } from "@/lib/constants/disclaimers";
import { FORBIDDEN_PHRASES } from "@/lib/coach/rules";
import { escape } from "@/lib/notifications";

import {
  formatConfirmationAlert,
  formatConfirmationConnectionTest,
  renderConfirmationInApp,
  type SetupNumbers,
} from "./format";
import type { ConfirmationAlert } from "./types";

/**
 * What the confirmation bot is allowed to say.
 *
 * Two sweeps run over every message shape: MarkdownV2 escaping, because an
 * unescaped `.` in a price makes Telegram reject the whole send with a 400, and
 * instruction language, because a message on a phone is where "SpotLens
 * analyses, you decide" is easiest to forget. Both are mechanical rather than
 * a reading, which is the only way they stay true as the wording changes.
 */

const NUMBERS: SetupNumbers = {
  entryLow: 0.05382,
  entryHigh: 0.05476,
  stopLoss: 0.05121,
  score: 90,
  riskReward: 3.3,
  riskRewardIsSynthetic: false,
};

function alert(overrides: Partial<ConfirmationAlert> = {}): ConfirmationAlert {
  return {
    level: "DEVELOPING",
    trackedSetupId: "setup-a",
    userId: "user-1",
    symbol: "PYTHUSDT",
    timeframe: "H4",
    dedupeKey: "confirmation-evidence:setup-a:HIGHER_LOW",
    evaluatedAt: Date.UTC(2026, 8, 15, 12),
    newEvidence: [
      {
        type: "BULLISH_REJECTION",
        signal: "positive",
        title: "Bullish rejection at the zone",
        detail: "…",
      },
    ],
    knownEvidence: [
      { type: "HIGHER_LOW", signal: "positive", title: "A higher low has formed", detail: "…" },
    ],
    missingEvidence: ["RECLAIM", "VOLUME_CONFIRMATION"],
    caveats: [],
    lifecycleStatus: "WAITING_CONFIRMATION",
    confirmationStatus: "NOT_PRESENT",
    ...overrides,
  };
}

const REACHED = alert({
  level: "REACHED",
  dedupeKey: "confirmation-reached:setup-a",
  confirmationStatus: "PRESENT",
  lifecycleStatus: "CONFIRMATION_DETECTED",
  missingEvidence: ["VOLUME_CONFIRMATION"],
  knownEvidence: [
    { type: "HIGHER_LOW", signal: "positive", title: "A higher low has formed", detail: "…" },
    {
      type: "BULLISH_REJECTION",
      signal: "positive",
      title: "Bullish rejection at the zone",
      detail: "…",
    },
  ],
  newEvidence: [
    { type: "RECLAIM", signal: "positive", title: "The zone has been reclaimed", detail: "…" },
  ],
});

const CAVEATED = alert({
  caveats: [
    {
      type: "VOLUME_CONFIRMATION",
      signal: "negative",
      title: "Volume is too thin to confirm",
      detail: "…",
    },
  ],
});

const SHAPES: [string, string][] = [
  ["developing", formatConfirmationAlert(alert(), NUMBERS)],
  ["developing with a caveat", formatConfirmationAlert(CAVEATED, NUMBERS)],
  [
    "developing with an unmeasured reward",
    formatConfirmationAlert(alert(), { ...NUMBERS, riskRewardIsSynthetic: true }),
  ],
  ["developing with no stored levels", formatConfirmationAlert(alert(), null)],
  ["reached", formatConfirmationAlert(REACHED, NUMBERS)],
  ["connection test", formatConfirmationConnectionTest()],
];

describe("MarkdownV2 escaping", () => {
  it.each(SHAPES)("leaves no stray reserved character in %s", (_name, text) => {
    expect(text.length).toBeGreaterThan(0);
    // Every unescaped reserved character must be one the formatter emitted
    // deliberately as markup: * for bold, _ for italic, \ for an escape.
    const stray = text.replace(/\\./g, "").match(/[[\]()~`>#+=|{}.!-]/g);
    expect(stray, `stray reserved characters in ${_name}: ${stray?.join("")}`).toBeNull();
  });

  it("escapes the decimal points in a price, which is what a 400 comes from", () => {
    const text = formatConfirmationAlert(alert(), NUMBERS);
    expect(text).toContain("0\\.05382");
    expect(text).not.toMatch(/(?<!\\)\d\.\d/);
  });
});

describe("what it may never say", () => {
  it.each(SHAPES)("uses no instruction or certainty language in %s", (_name, text) => {
    // The disclaimer legitimately contains "guaranteed", in the sentence
    // denying that anything is — a naive word list would flag the very text
    // that makes the message honest.
    const body = text.toLowerCase().split(escape(ANALYSIS_DISCLAIMER).toLowerCase()).join(" ");

    for (const banned of FORBIDDEN_PHRASES) {
      expect(body, `${_name} contained "${banned}"`).not.toContain(banned);
    }
  });

  it.each(SHAPES)("never claims a probability or a win rate in %s", (_name, text) => {
    for (const banned of ["100%", "win probability", "chance of winning", "% chance"]) {
      expect(text.toLowerCase(), `${_name} contained "${banned}"`).not.toContain(banned);
    }
  });

  it("calls the score quality, never a probability", () => {
    expect(formatConfirmationAlert(alert(), NUMBERS)).toContain("Quality");
  });

  it.each(SHAPES.filter(([name]) => name !== "connection test"))(
    "carries the shared disclaimers rather than its own wording in %s",
    (_name, text) => {
      expect(text).toContain(escape(ANALYSIS_DISCLAIMER));
      expect(text).toContain(escape(SPOT_ONLY_NOTE));
    },
  );
});

describe("what it says about the evidence", () => {
  it("separates new evidence from what was already present", () => {
    const text = formatConfirmationAlert(alert(), NUMBERS);
    expect(text).toContain("NEW EVIDENCE");
    expect(text).toContain("Bullish rejection at the zone");
    expect(text).toContain("Already present");
    expect(text).toContain("A higher low has formed");
  });

  it("marks absent evidence as not yet, never as evidence against", () => {
    const text = formatConfirmationAlert(alert(), NUMBERS);
    expect(text).toContain("Not yet");
    // ✕ is the main bot's mark for opposing evidence. An absence is not one,
    // and the difference between NOT_PRESENT and CONTRADICTED is the reason.
    expect(text).not.toContain("✕");
  });

  it("states a caveat as worth noting rather than as a refutation", () => {
    const text = formatConfirmationAlert(CAVEATED, NUMBERS);
    expect(text).toContain("Worth noting");
    expect(text).toContain("Volume is too thin to confirm");
  });

  it("lists every confirming signal when confirmation is reached", () => {
    const text = formatConfirmationAlert(REACHED, NUMBERS);
    expect(text).toContain("A higher low has formed");
    expect(text).toContain("Bullish rejection at the zone");
    expect(text).toContain("The zone has been reclaimed");
  });

  it("says plainly that evidence is not approval", () => {
    expect(formatConfirmationAlert(alert(), NUMBERS)).toContain("not approval");
    expect(formatConfirmationAlert(REACHED, NUMBERS)).toContain("not a recommendation");
  });
});

describe("the numbers", () => {
  it("quotes the stored levels and computes nothing", () => {
    const text = formatConfirmationAlert(alert(), NUMBERS);
    expect(text).toContain("0\\.05382");
    expect(text).toContain("0\\.05476");
    expect(text).toContain("90/100");
    expect(text).toContain("1:3\\.3");
  });

  it("refuses to present an unmeasured reward as measured", () => {
    const text = formatConfirmationAlert(alert(), { ...NUMBERS, riskRewardIsSynthetic: true });
    expect(text).toContain("not measurable");
    expect(text).not.toContain("1:3\\.3");
  });

  it("says so rather than printing a zero when there are no stored levels", () => {
    const text = formatConfirmationAlert(alert(), null);
    expect(text).toContain("Levels are not available");
    expect(text).not.toMatch(/Entry zone/);
  });

  it("names the candle it was judged on, in UTC, from the event's own timestamp", () => {
    const text = formatConfirmationAlert(
      alert({ evaluatedAt: Date.parse("2026-09-15T12:00:00.000Z") }),
      NUMBERS,
    );
    expect(text).toContain("15 Sep, 12:00 UTC");
  });
});

describe("the in-app copy", () => {
  it("marks the two levels apart so the list can colour them", () => {
    expect(renderConfirmationInApp(alert(), NUMBERS).title.startsWith("🟡")).toBe(true);
    expect(renderConfirmationInApp(REACHED, NUMBERS).title.startsWith("🟩")).toBe(true);
  });

  it("names the market and uses no instruction language", () => {
    for (const a of [alert(), REACHED]) {
      const { title, body } = renderConfirmationInApp(a, NUMBERS);
      expect(title).toContain("PYTHUSDT H4");
      for (const banned of FORBIDDEN_PHRASES) {
        expect(`${title} ${body}`.toLowerCase()).not.toContain(banned);
      }
    }
  });
});

describe("determinism", () => {
  it("renders identically for identical input", () => {
    expect(formatConfirmationAlert(alert(), NUMBERS)).toBe(
      formatConfirmationAlert(alert(), NUMBERS),
    );
  });
});
