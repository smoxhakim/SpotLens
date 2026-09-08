import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson } from "./http";
import { MarketDataError } from "./provider";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

/** Resolves with the MarketDataError a rejected call threw. */
async function captureError(promise: Promise<unknown>): Promise<MarketDataError> {
  try {
    await promise;
    throw new Error("expected the call to reject");
  } catch (err) {
    expect(err).toBeInstanceOf(MarketDataError);
    return err as MarketDataError;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchJson", () => {
  it("returns parsed JSON on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
    await expect(fetchJson<{ ok: boolean }>("https://example.test/x")).resolves.toEqual({
      ok: true,
    });
  });

  it("retries transient 5xx failures and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJson("https://example.test/x", { baseDelayMs: 1 })).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after the configured attempts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchJson("https://example.test/x", { attempts: 3, baseDelayMs: 1 }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maps 429 to a retryable RATE_LIMITED error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("slow down", { status: 429 })));

    const err = await captureError(
      fetchJson("https://example.test/x", { attempts: 1, baseDelayMs: 1 }),
    );

    expect(err).toBeInstanceOf(MarketDataError);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(429);
  });

  it("does not retry an unknown symbol", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: -1121, msg: "Invalid symbol." }), { status: 400 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const err = await captureError(fetchJson("https://example.test/x", { baseDelayMs: 1 }));

    expect(err.code).toBe("UNKNOWN_SYMBOL");
    expect(err.httpStatus).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports malformed JSON without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const err = await captureError(fetchJson("https://example.test/x", { baseDelayMs: 1 }));

    expect(err.code).toBe("BAD_RESPONSE");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
