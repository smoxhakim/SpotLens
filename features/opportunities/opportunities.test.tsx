import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { ShortlistCandidate } from "@/lib/scanner";

import { OpportunityCard } from "./components/OpportunityCard";
import { qualityLabel, riskRewardLabel } from "./labels";
import { visibleCandidates, type ShortlistResponse } from "./types";

/**
 * The review surface.
 *
 * What these protect is that the page stays *presentation*: it renders the
 * order Phase L produced, it never produces one of its own, and nothing on it
 * can be mistaken for an instruction to trade.
 */

const fetchApi = vi.fn();
vi.mock("@/features/market/hooks/fetch-api", () => ({
  fetchApi: (url: string) => fetchApi(url),
  ApiError: class extends Error {},
}));

const useSession = vi.fn();
vi.mock("next-auth/react", () => ({ useSession: () => useSession() }));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { OpportunitiesView } = await import("./components/OpportunitiesView");
const { CoachHandoff } = await import("./components/CoachHandoff");

function candidate(overrides: Partial<ShortlistCandidate> = {}): ShortlistCandidate {
  return {
    symbol: "ETHUSDT",
    timeframe: "H4",
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    rank: 1,
    score: 81,
    grade: "STRONG",
    riskReward: 2.9,
    riskRewardIsMeasured: true,
    lifecycleStatus: null,
    trackedSetupId: "11111111-1111-4111-8111-111111111111",
    analysedAtCandle: 1_700_000_000_000,
    trend: "BULLISH",
    mtfAgreement: "MIXED",
    regimeDirection: "TRENDING_UP",
    reasons: [
      "Waiting on confirmation — the engine has not promoted it.",
      "Quality 81/100 (strong).",
      "Reward measured against structure at 1:2.9.",
      "Trend is bullish.",
    ],
    ...overrides,
  };
}

/** A canonical list of `count` candidates, already in rank order. */
function manyCandidates(count: number): ShortlistCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    candidate({
      symbol: `S${String(i).padStart(2, "0")}USDT`,
      timeframe: i % 2 === 0 ? "H1" : "H4",
      rank: i + 1,
      score: 90 - i,
    }),
  );
}

function response(candidates: ShortlistCandidate[]): ShortlistResponse {
  return {
    run: {
      id: "run-1",
      startedAt: "2026-09-12T18:42:32.026Z",
      completedAt: "2026-09-12T18:42:54.224Z",
      status: "COMPLETED",
      timeframes: ["H1", "H4"],
      triggeredBy: "MANUAL",
      marketCount: 45,
    },
    totalAnalysed: 90,
    totalEligible: candidates.length,
    excluded: { FAILED: 0, AVOID: 36, HIGH_RISK: 16, BELOW_QUALITY_BAR: 8, REWARD_NOT_MEASURED: 0 },
    rankingVersion: 1,
    candidates,
  };
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <OpportunitiesView />
    </QueryClientProvider>,
  );
}

/** The symbols currently on screen, in the order they appear. */
/** The view-size toggle, scoped so a same-named control cannot be hit instead. */
function viewButton(name: string): HTMLElement {
  return within(screen.getByRole("group", { name: "How many to show" })).getByRole("button", {
    name,
  });
}

function filterButton(name: string): HTMLElement {
  return within(screen.getByRole("group", { name: "Filter by timeframe" })).getByRole("button", {
    name,
  });
}

function renderedSymbols(): string[] {
  return screen
    .getAllByRole("heading", { level: 3 })
    .map((h) => h.textContent?.split(" ")[0] ?? "")
    .filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSession.mockReturnValue({ status: "authenticated" });
});

describe("states", () => {
  it("shows a skeleton rather than invented markets while loading", async () => {
    fetchApi.mockReturnValue(new Promise(() => {}));
    renderView();

    expect(await screen.findByLabelText("Loading opportunities")).toBeInTheDocument();
    // A placeholder that looks like data is worse than an obvious placeholder.
    expect(screen.queryByText(/\/100/)).not.toBeInTheDocument();
  });

  it("offers a retry when the request fails", async () => {
    fetchApi.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    renderView();

    expect(await screen.findByText(/Unable to load the latest opportunities/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
    // Nothing internal reaches the reader.
    expect(screen.queryByText(/boom/)).not.toBeInTheDocument();
  });

  it("explains a missing scanner run instead of calling it an error", async () => {
    fetchApi.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
    renderView();

    expect(await screen.findByText(/No scanner results yet/)).toBeInTheDocument();
    // Named twice — the command block and the one-shot note beneath it.
    expect(screen.getAllByText(/npm run scanner/).length).toBeGreaterThan(0);
  });

  it("says nothing cleared the bar without calling the market dead", async () => {
    fetchApi.mockResolvedValue(response([]));
    renderView();

    expect(
      await screen.findByText(/No opportunities currently meet the review threshold/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/being selective rather than the scanner finding nothing/),
    ).toBeVisible();

    const text = document.body.textContent ?? "";
    for (const banned of ["no good trades", "market is dead", "don't miss"]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it("asks an unauthenticated reader to sign in", async () => {
    useSession.mockReturnValue({ status: "unauthenticated" });
    renderView();

    expect(await screen.findByText(/kept with your account/)).toBeInTheDocument();
    expect(fetchApi).not.toHaveBeenCalled();
  });
});

describe("view sizes", () => {
  beforeEach(() => fetchApi.mockResolvedValue(response(manyCandidates(20))));

  it("defaults to the top five", async () => {
    renderView();
    expect(await screen.findAllByRole("heading", { level: 3 })).toHaveLength(5);
  });

  it("fetches the whole list once, however many views are used", async () => {
    renderView();
    await screen.findAllByRole("heading", { level: 3 });

    fireEvent.click(viewButton("Top 10"));
    fireEvent.click(viewButton("Top 15"));
    fireEvent.click(viewButton("All"));

    // One request, not one per view: four round trips to reorder nothing would
    // be four chances for two views to disagree about what is third.
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith("/api/scanner/shortlist?size=ALL");
  });

  it("keeps every larger view a prefix of the smaller one", async () => {
    renderView();
    await screen.findAllByRole("heading", { level: 3 });
    const top5 = renderedSymbols();

    fireEvent.click(viewButton("Top 10"));
    const top10 = renderedSymbols();

    fireEvent.click(viewButton("Top 15"));
    const top15 = renderedSymbols();

    fireEvent.click(viewButton("All"));
    const all = renderedSymbols();

    expect(top10).toHaveLength(10);
    expect(top15).toHaveLength(15);
    expect(all).toHaveLength(20);

    // The first five never move, whichever view is open.
    expect(top10.slice(0, 5)).toEqual(top5);
    expect(top15.slice(0, 10)).toEqual(top10);
    expect(all.slice(0, 15)).toEqual(top15);
  });

  it("shows what there is when fewer than five are eligible", async () => {
    fetchApi.mockResolvedValue(response(manyCandidates(3)));
    renderView();

    expect(await screen.findAllByRole("heading", { level: 3 })).toHaveLength(3);
  });
});

describe("filtering", () => {
  beforeEach(() => fetchApi.mockResolvedValue(response(manyCandidates(20))));

  it("removes candidates without reordering the ones that remain", async () => {
    renderView();
    await screen.findAllByRole("heading", { level: 3 });

    fireEvent.click(viewButton("All"));
    const canonical = renderedSymbols();

    fireEvent.click(filterButton("1h"));
    const filtered = renderedSymbols();

    expect(filtered.length).toBeLessThan(canonical.length);
    // A subsequence of the canonical order: removal only, never a re-sort.
    expect(filtered).toEqual(canonical.filter((s) => filtered.includes(s)));
  });

  it("keeps the canonical rank visible so a filtered list still says where it sits", async () => {
    renderView();
    await screen.findAllByRole("heading", { level: 3 });
    fireEvent.click(filterButton("4h"));

    // The H4 entries are the even ranks, and they say so.
    expect(screen.getByLabelText("Ranked 2 of the shortlist")).toBeInTheDocument();
    expect(screen.queryByLabelText("Ranked 1 of the shortlist")).not.toBeInTheDocument();
  });

  it("says so plainly when a filter matches nothing", async () => {
    fetchApi.mockResolvedValue(
      response([candidate({ timeframe: "H1", symbol: "AAAUSDT", rank: 1 })]),
    );
    renderView();
    await screen.findAllByRole("heading", { level: 3 });

    fireEvent.click(filterButton("4h"));

    expect(screen.getByText(/No opportunities match this filter/)).toBeInTheDocument();
  });
});

describe("the candidate card", () => {
  it("renders the facts Phase L supplied, and no others", () => {
    render(<OpportunityCard candidate={candidate()} />);

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("ETHUSDT");
    expect(screen.getByText("Wait for confirmation")).toBeInTheDocument();
    expect(screen.getByText("81/100 · Strong")).toBeInTheDocument();
    expect(screen.getByText("1:2.9 · Measured")).toBeInTheDocument();
    expect(screen.getByText("Bullish")).toBeInTheDocument();
    expect(screen.getByText("Trending up")).toBeInTheDocument();
  });

  it("survives a candidate whose optional context is absent, not null", () => {
    // `JSON.stringify` drops an undefined field entirely, so the same missing
    // fact reaches the page as `null` from one source and as *no key at all*
    // from another. A card that renders context must not crash when there is
    // none — this was a real failure against a running server.
    const sparse = { ...candidate() } as Record<string, unknown>;
    delete sparse.trend;
    delete sparse.mtfAgreement;
    delete sparse.regimeDirection;
    delete sparse.grade;

    render(<OpportunityCard candidate={sparse as unknown as ShortlistCandidate} />);

    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("ETHUSDT");
    // The score survives a missing grade: the number is still true.
    expect(screen.getByText("81/100")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("undefined");
  });

  it("calls an unmeasurable reward unmeasurable when the flag is absent", () => {
    const sparse = { ...candidate() } as Record<string, unknown>;
    delete sparse.riskRewardIsMeasured;

    render(<OpportunityCard candidate={sparse as unknown as ShortlistCandidate} />);

    // Erring towards "not measurable" is the only safe direction.
    expect(screen.getByText("Not measurable")).toBeInTheDocument();
  });

  it("omits context the shortlist did not carry rather than inventing it", () => {
    render(
      <OpportunityCard
        candidate={candidate({ trend: null, regimeDirection: null, mtfAgreement: null })}
      />,
    );

    expect(screen.queryByText("Trend")).not.toBeInTheDocument();
    expect(screen.queryByText("Regime")).not.toBeInTheDocument();
    expect(screen.queryByText("Higher timeframe")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("null");
  });

  it("never prints an unmeasured reward as a ratio", () => {
    render(
      <OpportunityCard candidate={candidate({ riskReward: 2.5, riskRewardIsMeasured: false })} />,
    );

    expect(screen.getByText("Not measurable")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("1:2.5");
  });

  it("keeps the longer explanation behind a disclosure", async () => {
    render(<OpportunityCard candidate={candidate()} />);

    // Two of the four reasons are shown; the rest are a click away rather than
    // a wall of text on every card.
    expect(screen.queryByText(/Trend is bullish\./)).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /Show 2 more/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByText(/Trend is bullish\./)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Show less/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("links Analyze to the existing analysis, with the market's own context", () => {
    render(<OpportunityCard candidate={candidate()} />);

    const link = screen.getByRole("link", { name: /Analyze ETHUSDT on 4h/ });
    expect(link).toHaveAttribute("href", "/market-analysis?pair=ETHUSDT&tf=H4");
  });

  it("hands the Coach the whole reference contract and nothing else", () => {
    const RUN = "22222222-2222-4222-8222-222222222222";
    render(<OpportunityCard candidate={candidate()} runId={RUN} />);

    const href =
      screen.getByRole("link", { name: /Ask Coach about ETHUSDT/ }).getAttribute("href") ?? "";
    expect(href.startsWith("/coach?")).toBe(true);

    const params = new URLSearchParams(href.split("?")[1] ?? "");

    expect(params.get("symbol")).toBe("ETHUSDT");
    expect(params.get("tf")).toBe("H4");
    expect(params.get("setupId")).toBe("11111111-1111-4111-8111-111111111111");
    // The pass that ranked it. A shortlist belongs to one scan, and reviewing a
    // candidate without naming the pass is reviewing a moving target.
    expect(params.get("runId")).toBe(RUN);

    // Exactly four keys, never a fifth. No score, grade, reward or level
    // travels — those would be a second copy of numbers that already exist,
    // stale the moment the next candle closes.
    expect([...params.keys()].sort()).toEqual(["runId", "setupId", "symbol", "tf"]);
  });

  it("omits the setup id when the market is not being tracked", () => {
    const RUN = "22222222-2222-4222-8222-222222222222";
    render(<OpportunityCard candidate={candidate({ trackedSetupId: null })} runId={RUN} />);

    const href =
      screen.getByRole("link", { name: /Ask Coach about ETHUSDT/ }).getAttribute("href") ?? "";
    const params = new URLSearchParams(href.split("?")[1] ?? "");

    // Optional, and absent rather than empty: "setupId=" would claim a setup.
    expect([...params.keys()].sort()).toEqual(["runId", "symbol", "tf"]);
    expect(params.has("setupId")).toBe(false);
  });

  it("offers nothing that could be mistaken for placing a trade", () => {
    render(<OpportunityCard candidate={candidate({ analysisStatus: "POTENTIAL_SETUP" })} />);

    const text = (document.body.textContent ?? "").toLowerCase();
    for (const banned of [
      "buy",
      "sell",
      "execute",
      "approve",
      "enter now",
      "guaranteed",
      "probability",
      "chance",
      "%",
      "don't miss",
      "winning",
    ]) {
      expect(text, `card contained "${banned}"`).not.toContain(banned);
    }
  });
});

describe("the Coach handoff", () => {
  const RUN = "22222222-2222-4222-8222-222222222222";
  const SETUP = "11111111-1111-4111-8111-111111111111";

  it("says the review is not built yet rather than implying one happened", () => {
    render(<CoachHandoff symbol="ETHUSDT" timeframe="H4" setupId={null} runId={RUN} />);

    expect(screen.getByText(/Coach review arrives in the next phase/)).toBeInTheDocument();
    expect(screen.getByText(/No analysis has been sent anywhere/)).toBeInTheDocument();

    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toContain("reviewed this");
    expect(text).not.toContain("the coach says");
  });

  it("echoes every reference it was given", () => {
    render(<CoachHandoff symbol="ETHUSDT" timeframe="H4" setupId={SETUP} runId={RUN} />);

    expect(screen.getByText("ETHUSDT")).toBeInTheDocument();
    expect(screen.getByText("4h")).toBeInTheDocument();
    expect(screen.getByText(SETUP)).toBeInTheDocument();
    // The pass that ranked it, so a review can reconstruct the same context.
    expect(screen.getByText(RUN)).toBeInTheDocument();
  });

  it("says plainly when a reference is missing rather than leaving a blank", () => {
    render(<CoachHandoff symbol="ETHUSDT" timeframe="H4" setupId={null} runId={null} />);

    expect(screen.getByText(/not being tracked yet/)).toBeInTheDocument();
    expect(screen.getByText(/opened outside a scan/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("null");
  });

  it("explains itself when no candidate was passed", () => {
    render(<CoachHandoff symbol={null} timeframe={null} setupId={null} runId={null} />);
    expect(screen.getByText(/No candidate was passed/)).toBeInTheDocument();
  });
});

describe("slicing is not ranking", () => {
  const ordered = manyCandidates(20);

  it("never reorders, whichever view and filter are combined", () => {
    for (const view of ["top5", "top10", "top15", "all"] as const) {
      for (const tf of ["all", "H1", "H4"] as const) {
        const visible = visibleCandidates(ordered, view, tf);
        const ranks = visible.map((c) => c.rank);

        // Strictly increasing: a subsequence of the canonical order.
        expect(
          [...ranks].sort((a, b) => a - b),
          `${view}/${tf}`,
        ).toEqual(ranks);
      }
    }
  });

  it("returns the same list for the same arguments", () => {
    const a = visibleCandidates(ordered, "top10", "H1");
    const b = visibleCandidates(ordered, "top10", "H1");

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate the list it was given", () => {
    const before = ordered.map((c) => c.symbol);
    visibleCandidates(ordered, "top5", "H4");

    expect(ordered.map((c) => c.symbol)).toEqual(before);
  });
});

describe("labels", () => {
  it("states quality out of 100 and never as a percentage", () => {
    expect(qualityLabel(81, "STRONG")).toBe("81/100 · Strong");
    expect(qualityLabel(72, "MODERATE")).toBe("72/100 · Moderate");
    expect(qualityLabel(81, "STRONG")).not.toContain("%");
  });

  it("distinguishes a measured reward from one that could not be measured", () => {
    expect(riskRewardLabel({ riskReward: 2.9, riskRewardIsMeasured: true })).toBe(
      "1:2.9 · Measured",
    );
    expect(riskRewardLabel({ riskReward: 2.5, riskRewardIsMeasured: false })).toBe(
      "Not measurable",
    );
    expect(riskRewardLabel({ riskReward: null, riskRewardIsMeasured: false })).toBe(
      "Not measurable",
    );
  });
});

describe("accessibility", () => {
  beforeEach(() => fetchApi.mockResolvedValue(response(manyCandidates(8))));

  it("names the view and filter groups, and marks the chosen one", async () => {
    renderView();
    await screen.findAllByRole("heading", { level: 3 });

    expect(viewButton("Top 5")).toHaveAttribute("aria-pressed", "true");
    expect(viewButton("Top 10")).toHaveAttribute("aria-pressed", "false");

    // Two groups, each with its own name, and no two controls sharing one.
    expect(screen.getByRole("group", { name: "Filter by timeframe" })).toBeInTheDocument();
    expect(filterButton("All timeframes")).toBeInTheDocument();
  });

  it("builds every control from a natively focusable element", async () => {
    renderView();
    await screen.findAllByRole("heading", { level: 3 });

    // The keyboard reaches these because they are real buttons and real links,
    // not because a handler was bolted onto a div. Asserting the element is
    // the substantive check; a simulated tab would only re-test jsdom.
    const view = viewButton("Top 5");
    expect(view.tagName).toBe("BUTTON");
    expect(view).not.toHaveAttribute("tabindex", "-1");

    const links = screen.getAllByRole("link", { name: /Analyze/ });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].tagName).toBe("A");
    expect(links[0]).toHaveAttribute("href");
  });

  it("does not rely on colour alone to convey status", async () => {
    renderView();
    await screen.findAllByRole("heading", { level: 3 });

    // The status is words first; the tone only reinforces them.
    expect(screen.getAllByText("Wait for confirmation").length).toBeGreaterThan(0);
  });
});
