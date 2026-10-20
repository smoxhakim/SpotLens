import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  runAnalysis,
  staleEntryTimeframe,
  unavailableHigherTimeframe,
  type AnalysisResult,
} from "@/lib/analysis";
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
const { CompactTradeLevels } = await import("@/features/market/components/CompactTradeLevels");
const { AnalysisSummaryBar } = await import("./components/AnalysisSummaryBar");
const { chartLevelsFor } = await import("@/features/market/components/setup-levels");

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

/**
 * An analysis without the higher timeframe it needs is shown for information
 * only, and says so beside the levels — on both level views.
 */
describe("an incomplete analysis", () => {
  const INCOMPLETE = runAnalysis(pullbackIntoSupport(), {
    incomplete: unavailableHigherTimeframe("H4", "UNAVAILABLE"),
  });

  it("is marked incomplete on the trade-levels card, and is not a potential setup", () => {
    expect(INCOMPLETE.status).toBe("WAIT_FOR_CONFIRMATION");
    render(<TradeLevelsCard result={INCOMPLETE} isPending={false} error={null} />);

    const notice = screen.getByRole("status");
    expect(notice.textContent).toMatch(/^Incomplete analysis — 4h candles could not be loaded\./);
    expect(notice.textContent).toMatch(/cannot be a potential setup/);
    expect(notice.textContent).toMatch(/not tracked or made eligible for alerts/);
    // The levels stay, for information.
    expect(
      screen.getAllByText(formatPrice(INCOMPLETE.setup!.stopLoss.price)).length,
    ).toBeGreaterThan(0);
  });

  it("is marked incomplete on the compact strip", () => {
    render(<CompactTradeLevels result={INCOMPLETE} isPending={false} />);
    expect(screen.getByRole("status").textContent).toMatch(/^Incomplete analysis/);
  });

  it("carries no notice when the analysis is complete", () => {
    render(<TradeLevelsCard result={POTENTIAL} isPending={false} error={null} />);
    expect(screen.queryByText(/Incomplete analysis/)).toBeNull();
  });
});

/**
 * Nothing about an incomplete analysis may read as a plan: no sizing action,
 * no lines on the chart, and the status bar says so beside the verdict. Both
 * kinds — stale entry candles, and an unusable higher timeframe — are treated
 * alike. A complete analysis keeps every one of them.
 */
describe("an incomplete analysis is not actionable anywhere", () => {
  const CASES: [string, AnalysisResult][] = [
    [
      "an unusable higher timeframe",
      runAnalysis(pullbackIntoSupport(), {
        incomplete: unavailableHigherTimeframe("H4", "UNAVAILABLE"),
      }),
    ],
    [
      "stale entry candles",
      runAnalysis(pullbackIntoSupport(), { incomplete: staleEntryTimeframe("H1") }),
    ],
  ];

  it.each(CASES)("%s: never a potential setup", (_name, result) => {
    expect(result.status).not.toBe("POTENTIAL_SETUP");
  });

  it.each(CASES)("%s: no risk-calculator action", (_name, result) => {
    render(<TradeLevelsCard result={result} isPending={false} error={null} />);
    expect(screen.queryByRole("link", { name: /Calculate position size/ })).toBeNull();
    expect(screen.queryByText(/Opens the calculator/)).toBeNull();
  });

  it.each(CASES)("%s: the summary bar marks it incomplete beside the verdict", (_name, result) => {
    render(
      <AnalysisSummaryBar
        timeframe="H1"
        read={result.read}
        regime={null}
        result={result}
        isLoading={false}
      />,
    );
    const marker = screen.getByRole("status");
    expect(marker.textContent).toMatch(/^Incomplete — (4h|1h) data (unavailable|stale)$/);
    expect(marker.getAttribute("title")).toMatch(/These levels are not a trade plan/);
    expect(screen.getByText("Wait for confirmation")).toBeTruthy();
  });

  it.each(CASES)("%s: no levels drawn on the chart", (_name, result) => {
    expect(result.setup).not.toBeNull();
    expect(chartLevelsFor(result)).toEqual([]);
  });

  it("the stale-entry notice names the stale timeframe", () => {
    render(<TradeLevelsCard result={CASES[1][1]} isPending={false} error={null} />);
    const notice = screen.getByRole("status").textContent ?? "";
    expect(notice).toMatch(/The 1h candles being analysed are stale/);
    expect(notice).toMatch(/without current 1h data it cannot be a potential setup/);
    expect(notice).toMatch(/These levels are not a trade plan/);
  });
});

describe("a complete analysis keeps its existing behaviour", () => {
  it("offers the risk calculator", () => {
    render(<TradeLevelsCard result={POTENTIAL} isPending={false} error={null} />);
    expect(screen.getByRole("link", { name: /Calculate position size/ })).toBeTruthy();
  });

  it("shows the verdict with no incomplete marker", () => {
    render(
      <AnalysisSummaryBar
        timeframe="H1"
        read={POTENTIAL.read}
        regime={null}
        result={POTENTIAL}
        isLoading={false}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Potential setup")).toBeTruthy();
  });

  it("draws entry, stop and every target on the chart", () => {
    const levels = chartLevelsFor(POTENTIAL);
    expect(levels.map((l) => l.kind)).toEqual(expect.arrayContaining(["entry", "stop", "target"]));
    expect(levels.filter((l) => l.kind === "target")).toHaveLength(
      POTENTIAL.setup!.takeProfits.length,
    );
  });

  it("draws nothing before any analysis has run", () => {
    expect(chartLevelsFor(null)).toEqual([]);
  });
});
