import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConfirmationResult } from "@/lib/analysis";

import { ConfirmationPanel } from "./components/ConfirmationPanel";

/**
 * "Confirmation detected" in green, beside a HIGH_RISK verdict, read as a
 * green light. The panel now words it as evidence and says what it is not.
 */

const PRESENT: ConfirmationResult = {
  status: "PRESENT",
  signals: [
    {
      type: "HIGHER_LOW",
      signal: "positive",
      title: "A higher low formed after the touch",
      detail: "d",
    },
  ] as ConfirmationResult["signals"],
  explanation: "e",
  evaluatedAt: 0,
  invalidationReason: null,
};

describe("ConfirmationPanel", () => {
  it("says evidence, not detected, and names a high-risk verdict beside it", () => {
    render(<ConfirmationPanel confirmation={PRESENT} analysisStatus="HIGH_RISK" />);

    const label = screen.getByText("Confirmation evidence present");
    expect(label.className).not.toContain("text-bullish");
    expect(screen.queryByText(/confirmation detected/i)).toBeNull();
    expect(screen.getByText(/still rates this setup high risk/)).toBeTruthy();
  });

  it("says evidence is not approval while the setup is held at wait", () => {
    render(<ConfirmationPanel confirmation={PRESENT} analysisStatus="WAIT_FOR_CONFIRMATION" />);
    expect(screen.getByText(/another rule is still holding this setup at wait/)).toBeTruthy();
  });

  it("shows evidence in green, with no caveat, only on a potential setup", () => {
    render(<ConfirmationPanel confirmation={PRESENT} analysisStatus="POTENTIAL_SETUP" />);

    expect(screen.getByText("Confirmation evidence present").className).toContain("text-bullish");
    expect(screen.queryByText(/Evidence is not approval/)).toBeNull();
  });

  it("adds no caveat when there is no evidence to caveat", () => {
    render(
      <ConfirmationPanel
        confirmation={{ ...PRESENT, status: "NOT_PRESENT", signals: [] }}
        analysisStatus="HIGH_RISK"
      />,
    );
    expect(screen.getByText("Confirmation still required")).toBeTruthy();
    expect(screen.queryByText(/Evidence is not approval/)).toBeNull();
  });
});
