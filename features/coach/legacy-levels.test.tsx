import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDeterministicReview,
  contextFromTrackedSetup,
  type TrackedSetupFacts,
} from "@/lib/coach";

/**
 * A stored setup whose levels fail the long-only order check is shown as
 * recorded, never rewritten — and flagged on every page that shows them, so it
 * is not read as a valid ladder or a trade plan.
 *
 * The API is a stub returning a context built by the real context builder. No
 * database, no model.
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

const { CoachReviewView } = await import("./components/CoachReviewView");
const { DecisionWorkflow } = await import("@/features/decision/components/DecisionWorkflow");

/** LTC/USDT 1h, as stored on the local database: TP3 below TP2. */
function facts(overrides: Partial<TrackedSetupFacts> = {}): TrackedSetupFacts {
  return {
    setupId: "910cfbdc-53be-4ea2-93a2-87ea85a38ae8",
    symbol: "LTCUSDT",
    timeframe: "H1",
    lifecycleStatus: "WAITING_CONFIRMATION",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    score: 70,
    scoreGrade: "MODERATE",
    entryLow: 58.6,
    entryHigh: 58.86,
    stopLoss: 56.4592687,
    takeProfit1: 59.09,
    takeProfit2: 71.76,
    takeProfit3: 67.8129,
    riskReward: 5.74,
    riskRewardIsSynthetic: false,
    invalidationReason: null,
    createdAt: 1_700_000_100_000,
    snapshot: {},
    confirmationPayload: null,
    ...overrides,
  };
}

function serve(f: TrackedSetupFacts) {
  const context = contextFromTrackedSetup(f, "run-1");
  fetchApi.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/coach")) {
      return {
        context,
        review: buildDeterministicReview(context),
        degraded: false,
        source: "DETERMINISTIC",
      };
    }
    return { context, prefill: null, journal: null };
  });
}

const PROPS = {
  symbol: "LTCUSDT",
  timeframe: "H1",
  runId: "run-1",
  setupId: "910cfbdc-53be-4ea2-93a2-87ea85a38ae8",
} as const;

function renderWithClient(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  fetchApi.mockReset();
});

describe.each([
  ["Coach", () => <CoachReviewView {...PROPS} />],
  ["Decision", () => <DecisionWorkflow {...PROPS} />],
])("%s page — stored levels that fail the order check", (_name, page) => {
  it("shows the levels as recorded and flags them as invalid", async () => {
    serve(facts());
    renderWithClient(page());

    const warning = await screen.findByText(/Invalid stored levels/);
    expect(warning.textContent).toMatch(/TP3 sits below TP2/);
    expect(warning.textContent).toMatch(/Do not read them as a target ladder or a trade plan/);
    // Never rewritten: the stored TP3 is still the one shown.
    expect(screen.getAllByText("67.8129").length).toBeGreaterThan(0);
  });

  it("shows no warning when the stored levels are in order", async () => {
    serve(facts({ takeProfit3: 75 }));
    renderWithClient(page());

    await screen.findAllByText("75");
    expect(screen.queryByText(/Invalid stored levels/)).toBeNull();
  });
});
