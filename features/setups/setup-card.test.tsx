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

const { OpenSetupsFreshness, SetupCard } = await import("./components/SetupHistoryView");
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
    analysedAtCandle: Date.parse("2026-10-20T12:00:00.000Z"),
    createdAt: "2026-10-20T13:09:21.000Z",
    confirmedAt: null,
    invalidatedAt: null,
    invalidationReason: null,
    eventCount: 1,
    lastScan: null,
    ...overrides,
  };
}

function renderCard(s: TrackedSetup) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SetupCard setup={s} now={Date.parse("2026-10-20T13:30:00.000Z")} />
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

/**
 * Whether an open setup's market has been read since the latest close — judged
 * by the latest pass that found it still open, else by its creation — and kept
 * apart from its lifecycle. A closed setup has no freshness: it is a record.
 */
describe("SetupCard — freshness and lifecycle", () => {
  const NOW = Date.parse("2026-10-29T10:00:00.000Z");
  const h4 = (overrides: Partial<TrackedSetup> = {}) =>
    setup({
      timeframe: "H4",
      takeProfit3: 75,
      analysedAtCandle: Date.parse("2026-10-28T12:00:00.000Z"),
      createdAt: "2026-10-28T18:07:09.000Z",
      ...overrides,
    });
  // The pass that read the 04:00 candle, which closed at 08:00.
  const reconfirmed = {
    analysedAtCandle: Date.parse("2026-10-29T04:00:00.000Z"),
    recordedAt: Date.parse("2026-10-29T08:01:40.000Z"),
  };

  function renderAt(s: TrackedSetup) {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <SetupCard setup={s} now={NOW} />
      </QueryClientProvider>,
    );
  }

  it("is unmarked when a pass found it open after the latest close, and says when", () => {
    renderAt(h4({ lastScan: reconfirmed }));
    expect(screen.queryByText("Out of date")).toBeNull();
    expect(screen.queryByText("Freshness unknown")).toBeNull();
    expect(screen.getByText(/Last found open by a scan/)).toBeTruthy();
    expect(screen.getByText("Journal as watching")).toBeTruthy();
  });

  it("is marked out of date when no pass has read it since a newer candle closed", () => {
    renderAt(h4());
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(screen.getByText(/Not read by a scan since/)).toBeTruthy();
    // The lifecycle is still its own fact, beside the freshness.
    expect(screen.getByText("Waiting for confirmation")).toBeTruthy();
  });

  it("is marked freshness unknown when its read cannot be judged", () => {
    renderAt(h4({ analysedAtCandle: null, createdAt: "not a time" }));
    expect(screen.getByText("Freshness unknown")).toBeTruthy();
  });

  it("is a record when closed: no freshness verdict, nothing to watch", () => {
    renderAt(
      h4({
        status: "INVALIDATED",
        invalidatedAt: "2026-10-28T20:02:00.000Z",
        invalidationReason:
          "The entry no longer rests on this level — the engine has anchored to a different support zone, so this setup's premise is gone.",
      }),
    );
    expect(screen.getByText("Invalidated")).toBeTruthy();
    expect(screen.getByText(/This setup is closed/)).toBeTruthy();
    expect(screen.queryByText("Out of date")).toBeNull();
    expect(screen.queryByText(/Last found open by a scan|Not read by a scan since/)).toBeNull();
    expect(screen.queryByText("Journal as watching")).toBeNull();
    expect(screen.getByText("Journal as skipped")).toBeTruthy();
  });
});

describe("OpenSetupsFreshness", () => {
  const NOW = Date.parse("2026-10-29T10:00:00.000Z");
  const stale = setup({
    id: "a",
    timeframe: "H4",
    analysedAtCandle: Date.parse("2026-10-28T12:00:00.000Z"),
  });
  const fresh = setup({
    id: "b",
    timeframe: "H1",
    lastScan: {
      analysedAtCandle: Date.parse("2026-10-29T08:00:00.000Z"),
      recordedAt: Date.parse("2026-10-29T09:01:40.000Z"),
    },
  });
  const closed = setup({ id: "c", status: "INVALIDATED" });

  it("counts open setups only, and names the timeframe behind them", () => {
    render(<OpenSetupsFreshness setups={[stale, fresh, closed]} now={NOW} />);
    expect(screen.getByText(/1 of 2 open setups/)).toBeTruthy();
    expect(screen.getByText(/newest 4h candle closed/)).toBeTruthy();
  });

  it("says nothing when every open setup is fresh, however old the closed ones are", () => {
    const { container } = render(<OpenSetupsFreshness setups={[fresh, closed]} now={NOW} />);
    expect(container.textContent).toBe("");
  });

  it("says freshness is unknown rather than staying silent", () => {
    const unknown = setup({ id: "d", analysedAtCandle: null, createdAt: "not a time" });
    render(<OpenSetupsFreshness setups={[unknown, fresh]} now={NOW} />);
    expect(screen.getByText(/Freshness unknown\./)).toBeTruthy();
    expect(screen.getByText(/For 1 of 2/)).toBeTruthy();
  });
});
