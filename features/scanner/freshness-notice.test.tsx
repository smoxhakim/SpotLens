import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analysisFreshness, combinedFreshness } from "@/lib/scanner/freshness";

import { AnalysisFreshnessNotice } from "./components/AnalysisFreshnessNotice";
import { useNow } from "./hooks/use-now";

/**
 * The notice on an open page: it re-judges itself as candles close, without a
 * reload, a refetch or anything being started.
 */
const at = (h: number, m = 0) => Date.UTC(2026, 9, 28, h, m);

function Shown({ timeframe, candleOpen }: { timeframe: string; candleOpen: number | null }) {
  const now = useNow(60_000);
  const freshness = combinedFreshness([
    { timeframe, freshness: analysisFreshness({ timeframe, analysedCandleOpen: candleOpen, now }) },
  ]);
  return <AnalysisFreshnessNotice freshness={freshness} asOf={at(18, 7)} subject="this scan" />;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AnalysisFreshnessNotice", () => {
  it("says nothing while fresh, then turns into an out-of-date warning on its own", () => {
    vi.setSystemTime(at(18, 30));
    render(<Shown timeframe="H1" candleOpen={at(17)} />);
    expect(screen.queryByText(/Out of date/)).toBeNull();

    // An hour on: the next 1h candle has closed and settled.
    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(screen.getByText(/Out of date/)).toBeTruthy();
    expect(screen.getByText(/1h candle has closed since this scan/)).toBeTruthy();
    expect(screen.getByText(/historical, not the market now/)).toBeTruthy();
  });

  it("keeps a 4h read fresh across the same hour", () => {
    vi.setSystemTime(at(18, 30));
    render(<Shown timeframe="H4" candleOpen={at(12)} />);
    act(() => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(screen.queryByText(/Out of date/)).toBeNull();
  });

  it("says freshness is unknown rather than staying silent when it cannot be judged", () => {
    vi.setSystemTime(at(18, 30));
    render(<Shown timeframe="H1" candleOpen={null} />);
    expect(screen.getByText(/Freshness unknown/)).toBeTruthy();
  });
});
