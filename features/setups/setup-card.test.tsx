import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { SetupCard } = await import("./components/SetupHistoryView");
type TrackedSetup = import("./components/SetupHistoryView").TrackedSetup;

/**
 * The setups page is where a stored setup is read back. Its numbers are never
 * rewritten, so the page has to say when they would not pass today's checks,
 * and it must not show confirmation evidence as approval.
 */

function setup(overrides: Partial<TrackedSetup> = {}): TrackedSetup {
  return {
    id: "910cfbdc-53be-4ea2-93a2-87ea85a38ae8",
    symbol: "LTCUSDT",
    timeframe: "H1",
    status: "WAITING_CONFIRMATION",
    entryLow: 58.6,
    entryHigh: 58.86,
    stopLoss: 56.4592687,
    takeProfit1: 59.09,
    takeProfit2: 71.76,
    takeProfit3: 67.8129,
    riskReward: 5.74,
    riskRewardIsSynthetic: false,
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    score: 70,
    scoreGrade: "MODERATE",
    createdAt: "2026-10-20T13:09:21.000Z",
    confirmedAt: null,
    invalidatedAt: null,
    invalidationReason: null,
    eventCount: 1,
    ...overrides,
  };
}

function renderCard(s: TrackedSetup) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SetupCard setup={s} />
    </QueryClientProvider>,
  );
}

describe("SetupCard — legacy target order", () => {
  it("shows all three stored targets and warns that TP3 sits below TP2", () => {
    renderCard(setup());

    expect(screen.getByText(/67\.81/)).toBeTruthy();
    expect(screen.getByText(/TP3 sits below TP2/)).toBeTruthy();
    expect(screen.getByText(/kept exactly as recorded/)).toBeTruthy();
  });

  it("shows no warning for a ladder in order", () => {
    renderCard(setup({ takeProfit3: 75 }));
    expect(screen.queryByText(/sits below/)).toBeNull();
  });
});

describe("SetupCard — confirmation evidence on a high-risk setup", () => {
  it("reads as evidence, names the verdict, and is not shown in green", () => {
    renderCard(
      setup({ status: "CONFIRMATION_DETECTED", analysisStatus: "HIGH_RISK", takeProfit3: 75 }),
    );

    const label = screen.getByText("Confirmation evidence present");
    expect(label.className).not.toContain("text-bullish");
    expect(screen.getByText("high risk")).toBeTruthy();
    expect(screen.getByText(/rated this setup high risk when it was first tracked/)).toBeTruthy();
    expect(screen.queryByText(/confirmation detected/i)).toBeNull();
  });
});
