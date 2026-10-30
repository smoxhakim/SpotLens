import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { contextFromTrackedSetup, type TrackedSetupFacts } from "@/lib/coach";
import {
  checkSetupDecision,
  LATE_ENTRY_OUTSIDE_WINDOW_MESSAGE,
  type DecisionSetup,
  type JournalDecision,
} from "@/lib/journal";

/**
 * Taking a closed setup, on the two surfaces that record decisions — the
 * decision page and a journal entry — against the same rule the server runs.
 *
 * Neither surface offers a watch on a closed setup. Both route Take through a
 * statement: an acknowledgement and the user's own entry time, inside the
 * window SpotLens recorded the setup open. Nothing is sent until the rule
 * accepts it, and what is sent is exactly the statement. The API is stubbed.
 */

const fetchApi = vi.fn();
vi.mock("@/features/market/hooks/fetch-api", () => ({
  fetchApi: (url: string, init?: RequestInit) => fetchApi(url, init),
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
const { JournalDetail } = await import("@/features/journal/components/JournalDetail");

const FIRST_SEEN = Date.parse("2026-10-26T15:50:29Z");
const CLOSED_AT = Date.parse("2026-10-28T18:07:12Z");
const WINDOW: DecisionSetup = {
  status: "INVALIDATED",
  firstSeenAt: FIRST_SEEN,
  closedAt: CLOSED_AT,
};
// Local wall-clock times, as a datetime-local input gives them. Inside and
// after the window in every time zone.
const INSIDE_LOCAL = "2026-10-27T09:30:00";
const AFTER_LOCAL = "2026-10-29T12:00:00";

function facts(lifecycleStatus: string): TrackedSetupFacts {
  return {
    setupId: "setup-1",
    symbol: "TRXUSDT",
    timeframe: "H4",
    lifecycleStatus,
    analysisStatus: "WAIT_FOR_CONFIRMATION",
    score: 70,
    scoreGrade: "MODERATE",
    entryLow: 0.33,
    entryHigh: 0.335,
    stopLoss: 0.32,
    takeProfit1: 0.35,
    takeProfit2: null,
    takeProfit3: null,
    riskReward: 2,
    riskRewardIsSynthetic: false,
    invalidationReason: null,
    createdAt: FIRST_SEEN,
    snapshot: {},
    confirmationPayload: null,
  };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The decision page for one setup, with the API answering as the server would. */
function renderDecision(setup: DecisionSetup | null, lifecycle = "INVALIDATED") {
  fetchApi.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/decision/context")) {
      return {
        context: contextFromTrackedSetup(facts(lifecycle), "run-1"),
        lastScan: null,
        setup,
        prefill: null,
        journal: null,
      };
    }
    if (url === "/api/journal") return { id: "entry-1", created: true };
    return {};
  });

  return render(
    <QueryClientProvider client={client()}>
      <DecisionWorkflow symbol="TRXUSDT" timeframe="H4" runId="run-1" setupId="setup-1" />
    </QueryClientProvider>,
  );
}

const choice = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLButtonElement;
/** The late-entry form's own verdict line, when it shows one. */
const lateError = () => document.querySelector("[data-late-entry-error]");
const recordButton = () =>
  screen.getByRole("button", { name: "Record decision" }) as HTMLButtonElement;
/** Every write the page sent: method and parsed body. */
const writes = () =>
  fetchApi.mock.calls
    .filter(([, init]) => init?.method === "POST" || init?.method === "PATCH")
    .map(([url, init]) => ({ url, method: init.method, body: JSON.parse(init.body as string) }));

beforeEach(() => {
  fetchApi.mockReset();
});

describe("DecisionWorkflow — taking a closed setup", () => {
  it("asks for the statement before Take can be recorded", async () => {
    renderDecision(WINDOW);
    await screen.findByRole("radiogroup", { name: "Your decision" });

    fireEvent.click(choice(/^Take/));
    expect(screen.getByText(/It is not a way to enter a new one/)).toBeTruthy();
    expect(recordButton().disabled).toBe(true);

    // Ticked but no time: still nothing to record.
    fireEvent.click(screen.getByRole("checkbox"));
    expect(recordButton().disabled).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("refuses a time after the setup closed, in the rule's own words", async () => {
    renderDecision(WINDOW);
    await screen.findByRole("radiogroup", { name: "Your decision" });

    fireEvent.click(choice(/^Take/));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/When you entered/), { target: { value: AFTER_LOCAL } });

    expect(lateError()?.textContent).toBe(LATE_ENTRY_OUTSIDE_WINDOW_MESSAGE);
    expect(recordButton().disabled).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("sends exactly the statement once it is acknowledged and inside the window", async () => {
    renderDecision(WINDOW);
    await screen.findByRole("radiogroup", { name: "Your decision" });

    fireEvent.click(choice(/^Take/));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/When you entered/), {
      target: { value: INSIDE_LOCAL },
    });
    expect(lateError()).toBeNull();

    fireEvent.click(recordButton());
    // Take still asks again, and says it is the user's statement.
    expect(screen.getByText(/a trade you state you entered at/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: "/api/journal",
      method: "POST",
      body: {
        trackedSetupId: "setup-1",
        decision: "TAKEN",
        lateEntry: { acknowledged: true, enteredAt: new Date(INSIDE_LOCAL).getTime() },
      },
    });
  });

  it("refuses rather than guesses when the setup's window is unknown", async () => {
    // Closed by its lifecycle, but no window supplied.
    renderDecision(null);
    await screen.findByRole("radiogroup", { name: "Your decision" });

    fireEvent.click(choice(/^Take/));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/When you entered/), {
      target: { value: INSIDE_LOCAL },
    });

    expect(lateError()?.textContent).toMatch(/no reliable record/);
    expect(recordButton().disabled).toBe(true);
  });

  it("records a skip on a closed setup with no statement attached", async () => {
    renderDecision(WINDOW);
    await screen.findByRole("radiogroup", { name: "Your decision" });

    fireEvent.click(choice(/^Skip/));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(recordButton());

    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ trackedSetupId: "setup-1", decision: "SKIPPED" });
  });

  it("offers on an open setup exactly what it did before, with no statement", async () => {
    renderDecision(
      { status: "WAITING_CONFIRMATION", firstSeenAt: FIRST_SEEN, closedAt: null },
      "WAITING_CONFIRMATION",
    );
    await screen.findByRole("radiogroup", { name: "Your decision" });

    for (const name of [/^Watch/, /^Skip/, /^Take/]) expect(choice(name).disabled).toBe(false);
    fireEvent.click(choice(/^Take/));
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(recordButton());
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ trackedSetupId: "setup-1", decision: "TAKEN" });
  });

  it("agrees with the server's rule on every choice it offers", async () => {
    renderDecision(WINDOW);
    await screen.findByRole("radiogroup", { name: "Your decision" });

    const offered: [RegExp, JournalDecision][] = [
      [/^Watch/, "WATCHING"],
      [/^Skip/, "SKIPPED"],
      [/^Take/, "TAKEN"],
    ];
    for (const [name, decision] of offered) {
      const rule = checkSetupDecision({ setup: WINDOW, from: null, to: decision });
      expect(choice(name).disabled, decision).toBe(rule?.code === "SETUP_CLOSED");
    }
  });
});

/** A journal entry on a setup that has since closed. */
function entry(decision: JournalDecision, setup: { invalidatedAt: string | null; status: string }) {
  return {
    id: "entry-1",
    decision,
    skipReason: null,
    notes: null,
    setupStatusAtDecision: "WAITING_CONFIRMATION",
    decidedAt: "2026-10-26T16:00:00.000Z",
    source: "TRACKED_SETUP",
    symbol: "TRXUSDT",
    timeframe: "H4",
    coachReviewed: false,
    opportunity: null,
    setup: {
      id: "setup-1",
      symbol: "TRXUSDT",
      timeframe: "H4",
      currentStatus: setup.status,
      entryLow: 0.33,
      entryHigh: 0.335,
      stopLoss: 0.32,
      riskReward: 2,
      riskRewardIsSynthetic: false,
      score: 70,
      scoreGrade: "MODERATE",
      analysisStatus: "WAIT_FOR_CONFIRMATION",
      createdAt: new Date(FIRST_SEEN).toISOString(),
      invalidatedAt: setup.invalidatedAt,
    },
    trade: null,
    setupEvents: [],
    journalEvents: [],
  };
}

function renderJournal(decision: JournalDecision, status = "INVALIDATED") {
  const invalidatedAt = status === "INVALIDATED" ? new Date(CLOSED_AT).toISOString() : null;
  // The entry as the server holds it: a recorded decision is what the next read returns.
  let stored = decision;
  fetchApi.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === "/api/journal/entry-1") return { entry: entry(stored, { status, invalidatedAt }) };
    if (init?.method === "PATCH") stored = JSON.parse(init.body as string).decision;
    return { changed: true };
  });
  return render(
    <QueryClientProvider client={client()}>
      <JournalDetail id="entry-1" />
    </QueryClientProvider>,
  );
}

/** Waits for the entry to load. */
const loaded = () => screen.findByText(/Your decision/);

describe("JournalDetail — changing a decision on a closed setup", () => {
  it("does not offer watching, and says why", async () => {
    renderJournal("SKIPPED");
    await loaded();

    expect((screen.getByRole("button", { name: "Watching" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/This setup has closed, so watching is not available/)).toBeTruthy();
  });

  it("routes taken through the same statement, and sends it only once accepted", async () => {
    renderJournal("WATCHING");
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Taken" }));
    const record = screen.getByRole("button", { name: "Record as taken" }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    expect(writes()).toHaveLength(0);

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/When you entered/), { target: { value: AFTER_LOCAL } });
    expect(record.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/When you entered/), {
      target: { value: INSIDE_LOCAL },
    });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);

    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({
      url: "/api/journal/entry-1/decision",
      method: "PATCH",
      body: {
        decision: "TAKEN",
        lateEntry: { acknowledged: true, enteredAt: new Date(INSIDE_LOCAL).getTime() },
      },
    });
  });

  it("closes the statement once the late take is recorded, leaving no stale refusal", async () => {
    renderJournal("WATCHING");
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Taken" }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/When you entered/), {
      target: { value: INSIDE_LOCAL },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record as taken" }));

    // The entry is read again as taken — only a taken entry offers Closed — so
    // the recorded decision stands …
    await screen.findByRole("button", { name: "Closed" });
    expect(writes()).toHaveLength(1);
    // … and the spent statement is gone: no form, and no refusal of a move that
    // already succeeded.
    expect(screen.queryByRole("button", { name: "Record as taken" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(lateError()).toBeNull();
    expect(screen.queryByText(/recorded only when the decision becomes taken/)).toBeNull();
  });

  it("still changes to skipped directly, with no statement", async () => {
    renderJournal("WATCHING");
    await loaded();

    fireEvent.click(screen.getByRole("button", { name: "Skipped" }));
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body.decision).toBe("SKIPPED");
    expect(writes()[0].body).not.toHaveProperty("lateEntry");
  });

  it("is unchanged on an open setup: every allowed move, no statement", async () => {
    renderJournal("SKIPPED", "WAITING_CONFIRMATION");
    await loaded();

    for (const name of ["Watching", "Taken"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(screen.queryByText(/This setup has closed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Taken" }));
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).not.toHaveProperty("lateEntry");
    expect(within(document.body).queryByRole("checkbox")).toBeNull();
  });
});
