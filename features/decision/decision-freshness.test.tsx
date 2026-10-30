import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  contextFromScannerCandidate,
  contextFromTrackedSetup,
  type CoachContext,
  type TrackedSetupFacts,
} from "@/lib/coach";
import type { AnalysisRead } from "@/lib/scanner/freshness";

/**
 * The decision page says whether the setup still stands before anything is
 * recorded — at the top, and again beside the choices.
 *
 * A tracked setup is judged by the latest pass that found it still open, not by
 * when it was created: its levels are the creation's and never change, so the
 * creation time would call every setup older than one candle out of date for
 * ever. A closed setup is a record: it cannot be watched, and is taken only as
 * a trade already entered while it was open (`decision-late-entry.test.tsx`).
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

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-10-29T10:00:00Z");

/** A 4h setup first seen on the 12:00 candle of 28 Oct, recorded by the 18:07 pass. */
function facts(overrides: Partial<TrackedSetupFacts> = {}): TrackedSetupFacts {
  return {
    setupId: "setup-1",
    symbol: "BNBUSDT",
    timeframe: "H4",
    lifecycleStatus: "WAITING_CONFIRMATION",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    score: 78,
    scoreGrade: "STRONG",
    entryLow: 747,
    entryHigh: 751.86,
    stopLoss: 737.73188287,
    takeProfit1: 753.81,
    takeProfit2: 766.82,
    takeProfit3: 809.99,
    riskReward: 5.2,
    riskRewardIsSynthetic: false,
    invalidationReason: null,
    createdAt: at("2026-10-28T18:07:09Z"),
    snapshot: { createdFromCandleTime: at("2026-10-28T12:00:00Z") },
    confirmationPayload: null,
    ...overrides,
  };
}

/** The pass that read the 04:00 candle (closed 08:00) and found the setup still open. */
const RECONFIRMED: AnalysisRead = {
  analysedAtCandle: at("2026-10-29T04:00:00Z"),
  recordedAt: at("2026-10-29T08:01:40Z"),
};

function renderWith(
  context: CoachContext,
  lastScan: AnalysisRead | null,
  journal: Record<string, unknown> | null = null,
) {
  fetchApi.mockResolvedValue({ context, lastScan, prefill: null, journal });

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DecisionWorkflow
        symbol={context.identity.symbol}
        timeframe="H4"
        runId="run-1"
        setupId={context.identity.setupId}
      />
    </QueryClientProvider>,
  );
}

const tracked = (overrides: Partial<TrackedSetupFacts> = {}) =>
  contextFromTrackedSetup(facts(overrides), "run-1");

/** The card holding the choices, found from the choices themselves. */
async function decisionPanel() {
  const group = await screen.findByRole("radiogroup", { name: "Your decision" });
  return group.parentElement as HTMLElement;
}

const choice = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLButtonElement;

beforeEach(() => {
  fetchApi.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DecisionWorkflow — freshness", () => {
  it("says nothing extra when a pass re-read the setup after the latest close", async () => {
    // Created on a candle long closed, re-confirmed by this morning's pass.
    renderWith(tracked(), RECONFIRMED);

    const panel = await decisionPanel();
    expect(screen.queryByText(/Out of date/)).toBeNull();
    expect(screen.queryByText(/Freshness unknown/)).toBeNull();
    expect(within(panel).queryByText(/out of date/i)).toBeNull();
    expect(choice(/^Take/).disabled).toBe(false);
    // The two facts are both stated: the levels are the creation's, and when a
    // pass last found the setup open.
    expect(screen.getByText(/as recorded when the setup was first seen/)).toBeTruthy();
    expect(screen.getByText(/A scan last found it still open/)).toBeTruthy();
  });

  it("warns at the top and beside the choices when a newer candle has closed since", async () => {
    renderWith(tracked(), null);

    const panel = await decisionPanel();
    const notices = screen.getAllByText(/a scan last read this setup/);
    expect(notices).toHaveLength(2);
    expect(within(panel).getByText(/Out of date\./)).toBeTruthy();
    expect(within(panel).getByText(/historical, not the market now/)).toBeTruthy();
    expect(screen.getByText(/No scan has found it open since/)).toBeTruthy();
    // The warning sits in the same card as the choices, above them.
    const warning = panel.querySelector('[data-freshness="STALE"]');
    const group = within(panel).getByRole("radiogroup");
    expect(warning).not.toBeNull();
    expect(warning!.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still lets the reader decide, and says so again when they press Take", async () => {
    renderWith(tracked(), null);
    await decisionPanel();

    expect(choice(/^Take/).disabled).toBe(false);
    fireEvent.click(choice(/^Take/));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    expect(screen.getByText(/The analysis behind it is out of date/)).toBeTruthy();
    // Nothing was sent: Take asks again before recording.
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it("is stale for a re-confirmation that is itself behind the latest close", async () => {
    const yesterday = {
      analysedAtCandle: at("2026-10-28T16:00:00Z"),
      recordedAt: at("2026-10-28T20:02:00Z"),
    };
    renderWith(tracked(), yesterday);
    await decisionPanel();
    expect(screen.getAllByText(/Out of date\./).length).toBe(2);
  });

  it("says freshness is unknown when nothing about the read can be judged", async () => {
    renderWith(tracked({ snapshot: {}, createdAt: Number.NaN }), null);

    const panel = await decisionPanel();
    expect(screen.getAllByText(/Freshness unknown\./)).toHaveLength(2);
    expect(within(panel).getByText(/Freshness unknown\./)).toBeTruthy();
    expect(choice(/^Take/).disabled).toBe(false);
  });

  it("does not let a read from the future pass for a fresh one", async () => {
    const future = { analysedAtCandle: NOW + 48 * 3_600_000, recordedAt: NOW + 48 * 3_600_000 };
    renderWith(tracked({ snapshot: {}, createdAt: Number.NaN }), future);

    await decisionPanel();
    expect(screen.getAllByText(/Freshness unknown\./)).toHaveLength(2);
  });

  it("judges an untracked opportunity by its own scan", async () => {
    const context = contextFromScannerCandidate(
      {
        symbol: "ALGOUSDT",
        timeframe: "H4",
        analysisStatus: "WAIT_FOR_CONFIRMATION",
        score: 66,
        scoreGrade: "MODERATE",
        riskReward: 2.4,
        riskRewardIsSynthetic: false,
        trend: "BULLISH",
        mtfAgreement: null,
        regimeDirection: null,
        analysedAtCandle: at("2026-10-28T12:00:00Z"),
        recordedAt: at("2026-10-28T18:07:12Z"),
      },
      "run-1",
    );
    renderWith(context, null);

    await decisionPanel();
    expect(screen.getAllByText(/since this scan/)).toHaveLength(2);
  });
});

describe("DecisionWorkflow — a closed setup", () => {
  const closed = () =>
    tracked({
      lifecycleStatus: "INVALIDATED",
      invalidationReason: "The entry no longer rests on this level.",
    });

  it("is marked closed at the top and beside the choices, with no freshness verdict", async () => {
    // Even a fresh read does not make a closed setup live.
    renderWith(closed(), RECONFIRMED);

    const panel = await decisionPanel();
    expect(screen.getAllByText(/This setup is closed/)).toHaveLength(2);
    expect(within(panel).getByText(/This setup is closed/)).toBeTruthy();
    expect(screen.queryByText(/Out of date/)).toBeNull();
    expect(screen.queryByText(/A scan last found it still open/)).toBeNull();
  });

  it("cannot be watched, can be skipped, and offers Take only as an earlier trade", async () => {
    renderWith(closed(), null);
    await decisionPanel();

    expect(choice(/^Watch/).disabled).toBe(true);
    expect(choice(/^Skip/).disabled).toBe(false);
    expect(screen.getAllByText("Not available — this setup is closed.")).toHaveLength(1);
    // Take stays reachable, but says what it is for: a trade already entered.
    expect(choice(/^Take/).disabled).toBe(false);
    expect(choice(/^Take/).textContent).toMatch(/already entered while this setup was open/);
  });

  it("leaves a decision already on record exactly as it was", async () => {
    renderWith(closed(), null, {
      id: "entry-1",
      decision: "TAKEN",
      notes: "Took it at the zone top.",
      skipReason: null,
      decidedAt: "2026-10-28T19:00:00.000Z",
      coachReviewed: false,
    });
    await decisionPanel();

    expect(screen.getByText(/Currently recorded as/)).toBeTruthy();
    expect(screen.getByText("taken")).toBeTruthy();
    expect((screen.getByLabelText(/Your reasoning/) as HTMLTextAreaElement).value).toBe(
      "Took it at the zone top.",
    );
    // Only the initial read: opening a closed setup writes nothing.
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });
});
