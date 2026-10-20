import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { runAnalysis, type AnalysisResult } from "@/lib/analysis";
import { formatPrice } from "@/lib/format";
import { pullbackIntoSupport } from "@/lib/test-utils/scenarios";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { TradeLevelsCard } = await import("./components/TradeLevelsCard");

/**
 * The confirmation strip beside the levels — the page's primary answer.
 *
 * A green "✓ Present" there, on a HIGH_RISK setup, read as a go. Evidence is
 * green only on a potential setup; anything else is amber and says it is not
 * approval. The verdict, the levels and the confirmation are the engine's,
 * untouched — only their presentation is under test.
 */

/** A real run: a potential setup with confirmation present. */
const POTENTIAL = runAnalysis(pullbackIntoSupport());

function withVerdict(status: AnalysisResult["status"]): AnalysisResult {
  return { ...POTENTIAL, status };
}

describe("TradeLevelsCard — confirmation evidence", () => {
  it("is green and unqualified on a potential setup", () => {
    expect(POTENTIAL.status).toBe("POTENTIAL_SETUP");
    expect(POTENTIAL.confirmation?.status).toBe("PRESENT");

    render(<TradeLevelsCard result={POTENTIAL} isPending={false} error={null} />);

    const label = screen.getByText("Present");
    expect(label.className).toContain("text-bullish");
    expect(screen.queryByText(/not approval/)).toBeNull();
  });

  it("is an amber caution naming the verdict on a high-risk setup", () => {
    render(<TradeLevelsCard result={withVerdict("HIGH_RISK")} isPending={false} error={null} />);

    const label = screen.getByText("Evidence present — not approval");
    expect(label.className).toContain("text-amber-600");
    expect(label.className).not.toContain("text-bullish");
    expect(screen.queryByText("Present")).toBeNull();
    expect(screen.getByText(/still rates this setup high risk/).className).toContain(
      "text-amber-600",
    );
  });

  it("is a caution on a setup held at wait too", () => {
    render(
      <TradeLevelsCard
        result={withVerdict("WAIT_FOR_CONFIRMATION")}
        isPending={false}
        error={null}
      />,
    );

    expect(screen.getByText("Evidence present — not approval")).toBeTruthy();
    expect(screen.getByText(/another rule is still holding this setup at wait/)).toBeTruthy();
  });

  it("leaves the levels exactly as the engine produced them", () => {
    render(<TradeLevelsCard result={withVerdict("HIGH_RISK")} isPending={false} error={null} />);
    // Same setup object, same numbers: the engine's stop is what is shown.
    const stop = formatPrice(POTENTIAL.setup!.stopLoss.price);
    expect(screen.getAllByText(stop).length).toBeGreaterThan(0);
  });
});
