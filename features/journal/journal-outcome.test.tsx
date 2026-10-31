import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toLocalInput } from "@/features/decision/components/LateEntryForm";
import type { JournalDecision } from "@/lib/journal";

import type { RecordedTrade } from "./outcome-form";

/**
 * The trade form on a journal entry, against a stubbed API that stores what it
 * is sent and returns it on the next read — as the server does.
 *
 * The save replaces the whole trade, so these follow a trade through several
 * saves: recorded new, a partial fill topped up, still open, closed. At each
 * step nothing the user did not change may be cleared, and nothing left blank
 * may be filled in.
 */

const fetchApi = vi.fn();
vi.mock("@/features/market/hooks/fetch-api", () => ({
  fetchApi: (url: string, init?: RequestInit) => fetchApi(url, init),
  ApiError: class extends Error {},
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { JournalDetail } = await import("./components/JournalDetail");

const FILL = Date.parse("2026-10-31T10:00:42Z");
const CLOSE = Date.parse("2026-10-31T16:20:05Z");

/** The server's side: the stored trade, written as `recordOutcome` writes it. */
let stored: { decision: JournalDecision; trade: RecordedTrade | null };
let posts: Record<string, unknown>[];

function store(body: Record<string, unknown>) {
  const value = (key: string) => (body[key] === undefined ? null : (body[key] as number));
  const time = (key: string) =>
    body[key] === undefined ? null : new Date(body[key] as number).toISOString();
  stored = {
    decision: body.close ? "CLOSED" : stored.decision,
    trade: {
      actualEntry: body.actualEntry as number,
      actualStopLoss: value("actualStopLoss"),
      actualTakeProfit: value("actualTakeProfit"),
      actualExit: value("actualExit"),
      quantity: body.quantity as number,
      fees: value("fees"),
      slippage: value("slippage"),
      exitReason: (body.exitReason as string | undefined) ?? null,
      openedAt: time("openedAt"),
      closedAt: time("closedAt"),
    },
  };
}

function entry() {
  return {
    id: "entry-1",
    decision: stored.decision,
    skipReason: null,
    notes: null,
    setupStatusAtDecision: "POTENTIAL_SETUP",
    decidedAt: "2026-10-31T10:05:00.000Z",
    source: "TRACKED_SETUP",
    symbol: "AAAUSDT",
    timeframe: "H4",
    coachReviewed: false,
    opportunity: null,
    setup: {
      id: "setup-1",
      symbol: "AAAUSDT",
      timeframe: "H4",
      currentStatus: "POTENTIAL_SETUP",
      entryLow: 100,
      entryHigh: 102,
      stopLoss: 97,
      riskReward: 2.6,
      riskRewardIsSynthetic: false,
      score: 82,
      scoreGrade: "STRONG",
      analysisStatus: "POTENTIAL_SETUP",
      createdAt: "2026-10-31T08:02:00.000Z",
      invalidatedAt: null,
    },
    trade: stored.trade && {
      ...stored.trade,
      realizedR: null,
      netPnl: null,
      riskAmount: null,
      holdingMs: null,
    },
    setupEvents: [],
    journalEvents: [],
  };
}

function renderEntry() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <JournalDetail id="entry-1" />
    </QueryClientProvider>,
  );
}

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: RegExp, value: string) =>
  fireEvent.change(field(label), { target: { value } });

async function save(button: "Save details" | "Record result and close" = "Save details") {
  const before = posts.length;
  fireEvent.click(screen.getByRole("button", { name: button }));
  await vi.waitFor(() => expect(posts).toHaveLength(before + 1));
  return posts.at(-1)!;
}

beforeEach(() => {
  stored = { decision: "TAKEN", trade: null };
  posts = [];
  fetchApi.mockReset();
  fetchApi.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/journal/entry-1") return { entry: entry() };
    if (url === "/api/journal/entry-1/outcome" && init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      posts.push(body);
      store(body);
      return { realizedR: null };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
});

describe("JournalDetail — recording a trade", () => {
  it("records a new partial fill with its fill time and take-profit, and nothing left blank", async () => {
    renderEntry();
    await screen.findByText("Your trade");

    type(/Actual entry/, "101.5");
    type(/Actual stop/, "96.5");
    type(/Take-profit/, "110");
    type(/Quantity/, "0.095");
    type(/Fill time/, toLocalInput(FILL));

    expect(await save()).toEqual({
      actualEntry: 101.5,
      actualStopLoss: 96.5,
      actualTakeProfit: 110,
      quantity: 0.095,
      openedAt: FILL,
      close: false,
    });
  });

  it("follows one trade through every save without clearing what was recorded", async () => {
    stored = {
      decision: "TAKEN",
      trade: {
        actualEntry: 101.5,
        actualStopLoss: 96.5,
        actualTakeProfit: 110,
        actualExit: null,
        quantity: 0.095,
        fees: 0.02,
        // Recorded through the API; the form has no field for it.
        slippage: 0.01,
        exitReason: null,
        openedAt: "2026-10-31T10:00:42.250Z",
        closedAt: null,
      },
    };
    renderEntry();
    await screen.findByText("Your trade");

    // Shown as recorded — the time to the second, in whatever form the input normalises it.
    expect(field(/Take-profit/).value).toBe("110");
    expect(new Date(field(/Fill time/).value).getTime()).toBe(FILL);
    expect(field(/Close time/).value).toBe("");
    expect(field(/Exit reason/).value).toBe("");

    // Still open, saved untouched: everything back exactly, nothing invented.
    const open = await save();
    expect(open).toEqual({
      actualEntry: 101.5,
      actualStopLoss: 96.5,
      actualTakeProfit: 110,
      quantity: 0.095,
      fees: 0.02,
      slippage: 0.01,
      openedAt: Date.parse("2026-10-31T10:00:42.250Z"),
      close: false,
    });

    // The rest of the order fills: the quantity and fees change, the fill time does not.
    type(/Quantity/, "0.19");
    type(/Fees/, "0.04");
    const toppedUp = await save();
    expect(toppedUp).toEqual({ ...open, quantity: 0.19, fees: 0.04 });

    // Closed at the target.
    type(/Exit price/, "110");
    type(/Close time/, toLocalInput(CLOSE));
    type(/Exit reason/, "TAKE_PROFIT");
    const closed = await save("Record result and close");
    expect(closed).toEqual({
      ...toppedUp,
      actualExit: 110,
      exitReason: "TAKE_PROFIT",
      closedAt: CLOSE,
      close: true,
    });

    // Re-opened from the server, the closed trade still shows every field.
    expect(stored.decision).toBe("CLOSED");
    expect(stored.trade).toMatchObject({
      actualTakeProfit: 110,
      exitReason: "TAKE_PROFIT",
      openedAt: "2026-10-31T10:00:42.250Z",
      closedAt: new Date(CLOSE).toISOString(),
      slippage: 0.01,
    });
  });

  it("re-reads a saved entry into the same values, so a later save changes nothing", async () => {
    stored = {
      decision: "CLOSED",
      trade: {
        actualEntry: 101.5,
        actualStopLoss: 96.5,
        actualTakeProfit: 110,
        actualExit: 103,
        quantity: 0.19,
        fees: 0.04,
        slippage: null,
        exitReason: "MANUAL_EXIT",
        openedAt: new Date(FILL).toISOString(),
        closedAt: new Date(CLOSE).toISOString(),
      },
    };
    const before = structuredClone(stored.trade);
    renderEntry();
    await screen.findByText("Your trade");

    expect(screen.queryByRole("button", { name: "Record result and close" })).toBeNull();
    await save();
    expect(stored.trade).toEqual(before);
  });

  it("names the time zone the times are read in", async () => {
    renderEntry();
    await screen.findByText("Your trade");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(
      screen.getByText(new RegExp(`time zone \\(${zone.replace("/", "\\/")}\\)`)),
    ).toBeTruthy();
  });
});
