import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { contextFromTrackedSetup, type TrackedSetupFacts } from "@/lib/coach";

/**
 * The decision page's "Confirmation" field.
 *
 * It read "Present" whatever the verdict — on the page where the reader
 * decides. Evidence on a setup the engine did not promote is now an amber
 * caution saying it is not approval, with the verdict named on HIGH_RISK.
 *
 * The API is a stub returning a context built by the real context builder.
 */

const fetchApi = vi.fn();
vi.mock("@/features/market/hooks/fetch-api", () => ({
  fetchApi: (url: string) => fetchApi(url),
  ApiError: class extends Error {},
}));

vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "authenticated" }) }));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { DecisionWorkflow } = await import("./components/DecisionWorkflow");

function facts(analysisStatus: string): TrackedSetupFacts {
  return {
    setupId: "setup-1",
    symbol: "ALGOUSDT",
    timeframe: "H1",
    lifecycleStatus: "CONFIRMATION_DETECTED",
    analysisStatus,
    score: 66,
    scoreGrade: "MODERATE",
    entryLow: 0.18,
    entryHigh: 0.182,
    stopLoss: 0.175,
    takeProfit1: 0.19,
    takeProfit2: 0.2,
    takeProfit3: null,
    riskReward: 2.6,
    riskRewardIsSynthetic: false,
    invalidationReason: null,
    createdAt: 1_700_000_100_000,
    snapshot: {},
    confirmationPayload: {
      status: "PRESENT",
      explanation: "A higher low formed after the touch.",
      evaluatedAt: 1_700_000_000_000,
      signals: [],
    },
  };
}

function renderFor(analysisStatus: string) {
  const context = contextFromTrackedSetup(facts(analysisStatus), "run-1");
  fetchApi.mockResolvedValue({ context, prefill: null, journal: null });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DecisionWorkflow symbol="ALGOUSDT" timeframe="H1" runId="run-1" setupId="setup-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchApi.mockReset();
});

describe("DecisionWorkflow — the Confirmation field", () => {
  it("stays an unqualified 'Present' on a potential setup", async () => {
    renderFor("POTENTIAL_SETUP");

    expect(await screen.findByText("Present")).toBeTruthy();
    expect(screen.queryByText(/not approval/)).toBeNull();
  });

  it("is an amber caution naming the verdict on a high-risk setup", async () => {
    renderFor("HIGH_RISK");

    const label = await screen.findByText("Evidence present — not approval");
    expect(label.className).toContain("text-amber-600");
    expect(screen.queryByText("Present")).toBeNull();
    // The stored verdict is the one given when the setup was first tracked.
    const note = screen.getByText(/rated this setup high risk when it was first tracked/);
    expect(note.className).toContain("text-amber-600");
  });

  it("is a caution on a setup that was waiting, too", async () => {
    renderFor("WAIT_FOR_CONFIRMATION");

    expect(await screen.findByText("Evidence present — not approval")).toBeTruthy();
    expect(screen.getByText(/not promoted to a potential setup/)).toBeTruthy();
  });
});
