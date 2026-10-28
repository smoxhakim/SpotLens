import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { runAnalysis } from "@/lib/analysis";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { RiskCalculatorLink } = await import("./components/RiskCalculatorLink");

/**
 * The analysis panel's link into the calculator sizes from the top of the entry
 * zone — the worst fill inside it — exactly as the decision pages do. The stop
 * and the measured target are the engine's, untouched.
 */
describe("RiskCalculatorLink", () => {
  const setup = runAnalysis(pullbackIntoSupport()).setup!;

  it("carries the top of the entry zone as the entry, with the engine's stop and target", () => {
    render(<RiskCalculatorLink setup={setup} />);

    const href = screen
      .getByRole("link", { name: /Calculate position size/ })
      .getAttribute("href")!;
    const params = new URLSearchParams(href.split("?")[1]);
    const measured = setup.takeProfits.find((t) => t.label === setup.riskReward.measuredTo)!;

    expect(params.get("entry")).toBe(String(setup.entry.high));
    expect(params.get("entry")).not.toBe(String(setup.entry.mid));
    expect(params.get("stop")).toBe(String(setup.stopLoss.price));
    expect(params.get("tp")).toBe(String(measured.level));
  });

  it("says which entry it assumed", () => {
    render(<RiskCalculatorLink setup={setup} />);

    expect(screen.getByText(/the top of the entry zone as the entry/)).toBeTruthy();
  });
});
