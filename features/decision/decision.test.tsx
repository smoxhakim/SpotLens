import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The decision surface.
 *
 * What these protect is the line the whole journal rests on: SpotLens says
 * things, the reader decides, and the trade is a third event entirely. Nothing
 * on this page may decide on the reader's behalf, and nothing on it places an
 * order — there is no order path in the application to place one through.
 */

const fetchApi = vi.fn();
vi.mock("@/features/market/hooks/fetch-api", () => ({
  fetchApi: (url: string, init?: RequestInit) => fetchApi(url, init),
  ApiError: class extends Error {},
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { DecisionPanel } = await import("./components/DecisionPanel");

const target = {
  symbol: "ETHUSDT",
  timeframe: "H4",
  runId: "33333333-3333-4333-8333-333333333333",
  setupId: "44444444-4444-4444-8444-444444444444",
};

function renderPanel(props: Partial<React.ComponentProps<typeof DecisionPanel>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <DecisionPanel target={target} existing={null} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchApi.mockReset();
  fetchApi.mockResolvedValue({ id: "entry-1", created: true });
});

describe("nothing decides for the reader", () => {
  it("records nothing merely by being rendered", async () => {
    renderPanel();

    // Opening a page, asking the Coach, sizing a position — none of them is a
    // decision, and the only thing that writes one is the button below.
    await waitFor(() => expect(screen.getByText("Your decision")).toBeTruthy());
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("records nothing when a choice is selected but not submitted", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Watch/ }));

    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("offers no option that is preselected", () => {
    renderPanel();

    for (const option of screen.getAllByRole("radio")) {
      expect(option.getAttribute("aria-checked")).toBe("false");
    }
  });

  it("never writes the reader's reasoning for them", () => {
    renderPanel();

    // The note is the user's own words. A generated one would be SpotLens's
    // opinion wearing the reader's name.
    const note = screen.getByLabelText(/Your reasoning/) as HTMLTextAreaElement;
    expect(note.value).toBe("");
  });
});

describe("take asks again, and still places nothing", () => {
  it("does not record on the first press", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Take/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    expect(fetchApi).not.toHaveBeenCalled();
    expect(screen.getByText(/SpotLens will not place an order/)).toBeTruthy();
  });

  it("says plainly that no order is placed", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Take/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    expect(screen.getByText(/Nothing is sent to an exchange/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("records nothing when the confirmation is cancelled", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Take/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("records the decision, and only the decision, once confirmed", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Take/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Record decision" }).at(-1)!);

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));

    const [url, init] = fetchApi.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);

    expect(url).toBe("/api/journal");
    expect(body.decision).toBe("TAKEN");
    expect(body.trackedSetupId).toBe(target.setupId);

    // "I decided to take this setup" is not "an order was executed". No trade
    // fields travel with a decision, and no timestamp either — the server
    // stamps that, because a moment the browser chose records nothing.
    for (const field of ["actualEntry", "quantity", "openedAt", "decidedAt", "timestamp"]) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it("says no trade was executed once recorded", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Take/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Record decision" }).at(-1)!);

    await waitFor(() => expect(screen.getByText(/No trade was executed by SpotLens/)).toBeTruthy());
    expect(screen.getByRole("link", { name: /View journal entry/ }).getAttribute("href")).toBe(
      "/journal/entry-1",
    );
  });
});

describe("watch and skip record straight away", () => {
  it("records a watch without a confirmation step", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Watch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchApi.mock.calls[0][1].body).decision).toBe("WATCHING");
  });

  it("sends the reader's own note and reason", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Skip/ }));
    fireEvent.change(screen.getByLabelText(/Your reasoning/), {
      target: { value: "Waiting for stronger volume confirmation." },
    });
    fireEvent.change(screen.getByLabelText(/Why are you skipping it/), {
      target: { value: "NO_CONFIRMATION" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchApi.mock.calls[0][1].body);
    expect(body.notes).toBe("Waiting for stronger volume confirmation.");
    expect(body.skipReason).toBe("NO_CONFIRMATION");
  });
});

describe("an opportunity that was never tracked", () => {
  it("references the scan instead of inventing a setup id", async () => {
    renderPanel({ target: { ...target, setupId: null } });

    fireEvent.click(screen.getByRole("radio", { name: /Watch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchApi.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("trackedSetupId");
    expect(body).toMatchObject({ runId: target.runId, symbol: "ETHUSDT", timeframe: "H4" });
  });
});

describe("an entry that already existed", () => {
  it("applies the decision to it rather than reporting one that was ignored", async () => {
    // Creating is idempotent: an entry journaled in another tab, or from the
    // setups page, comes back untouched. Without the follow-up the panel would
    // say "decision recorded" for a decision the service had quietly dropped.
    fetchApi.mockResolvedValue({ id: "entry-3", created: false });

    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Watch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(2));

    expect(fetchApi.mock.calls[0][0]).toBe("/api/journal");
    expect(fetchApi.mock.calls[1][0]).toBe("/api/journal/entry-3/decision");
    expect(fetchApi.mock.calls[1][1].method).toBe("PATCH");
  });
});

describe("the journal's own rules decide what is offered", () => {
  const existing = {
    id: "entry-1",
    decision: "TAKEN" as const,
    notes: null,
    skipReason: null,
    decidedAt: new Date(1_757_000_000_000).toISOString(),
    coachReviewed: false,
  };

  it("does not offer a move the journal would refuse", () => {
    // A position that was entered cannot retroactively become one passed over.
    renderPanel({ existing });

    expect(screen.getByRole("radio", { name: /Skip/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("radio", { name: /Watch/ }).hasAttribute("disabled")).toBe(true);
  });

  it("shows what is already on record and says a change appends to it", () => {
    renderPanel({ existing });

    expect(screen.getByText(/Currently recorded as/)).toBeTruthy();
    expect(screen.getByText(/appends to the history/)).toBeTruthy();
  });

  it("patches the existing entry rather than creating a second", async () => {
    renderPanel({ existing: { ...existing, decision: "WATCHING" } });

    fireEvent.click(screen.getByRole("radio", { name: /Skip/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
    expect(fetchApi.mock.calls[0][0]).toBe("/api/journal/entry-1/decision");
    expect(fetchApi.mock.calls[0][1].method).toBe("PATCH");
  });
});

describe("the Coach is recorded as read, never as an authority", () => {
  it("sends the reading that was on screen", async () => {
    renderPanel({ coach: { providerId: "openai:gpt-5.6-terra", verdict: "MIXED_EVIDENCE" } });

    fireEvent.click(screen.getByRole("radio", { name: /Skip/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchApi.mock.calls[0][1].body);
    expect(body.coach).toEqual({
      providerId: "openai:gpt-5.6-terra",
      verdict: "MIXED_EVIDENCE",
    });
    // Nothing about approval. The reader is free to decide the opposite of
    // whatever the Coach concluded, and this records only that it was read.
    expect(JSON.stringify(body)).not.toMatch(/approv/i);
  });

  it("lets the reader disagree with the Coach outright", async () => {
    // The Coach reads the evidence as contradicted; the reader takes it anyway.
    // That has to be possible, and has to record cleanly.
    renderPanel({ coach: { providerId: "deterministic", verdict: "CONTRADICTED" } });

    fireEvent.click(screen.getByRole("radio", { name: /Take/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Record decision" }).at(-1)!);

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchApi.mock.calls[0][1].body).decision).toBe("TAKEN");
  });

  it("records an ordinary decision when no Coach was consulted", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("radio", { name: /Watch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));

    await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchApi.mock.calls[0][1].body)).not.toHaveProperty("coach");
  });
});

describe("no language that pressures the reader", () => {
  it("never instructs", () => {
    renderPanel();

    const text = document.body.textContent ?? "";

    for (const phrase of [
      "buy now",
      "sell",
      "guaranteed",
      "risk-free",
      "act now",
      "don't miss",
      "sure thing",
      "easy profit",
    ]) {
      expect(text.toLowerCase()).not.toContain(phrase);
    }
  });
});
