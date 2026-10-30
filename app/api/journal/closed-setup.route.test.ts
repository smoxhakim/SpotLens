import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The journal routes' answers when a closed setup refuses a decision.
 *
 * A refusal is a conflict with the setup's state — 409 under its own code — and
 * is only reachable after the owner-scoped lookup found the setup, so it says
 * nothing about anyone else's. Every other failure keeps the answer it always
 * had: a missing or foreign setup is still 404 SETUP_NOT_FOUND on create, and a
 * missing entry still 404 JOURNAL_NOT_FOUND on a change. The service is stubbed;
 * what is under test is the mapping and the request contract.
 */

const createEntry = vi.fn();
const updateDecision = vi.fn();

vi.mock("@/lib/db/prisma", () => ({ isDatabaseConfigured: true, prisma: {} }));
vi.mock("@/lib/api/auth-guard", () => ({
  requireUser: async () => ({ userId: "user-1" }),
  isDenied: () => false,
}));
vi.mock("@/services/journal", () => ({
  createEntry: (a: unknown) => createEntry(a),
  updateDecision: (a: unknown) => updateDecision(a),
  listEntries: vi.fn(),
}));

const { POST } = await import("./route");
const { PATCH } = await import("./[id]/decision/route");

const SETUP_ID = "7bb94bbb-bbb2-4768-9c62-2082070f16e8";
const ENTRY_ID = "1d6f8a39-6c0e-4f55-9d2a-0c3f1b8e2a11";
const INSIDE = Date.parse("2026-10-27T09:30:00Z");

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/journal", { method: "POST", body: JSON.stringify(body) }),
  );
const patch = (body: unknown) =>
  PATCH(
    new NextRequest(`http://localhost/api/journal/${ENTRY_ID}/decision`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ENTRY_ID }) },
  );

const refusal = (code: string, field = "decision") => ({
  ok: false,
  errors: [{ code, field, message: `refused: ${code}` }],
});

beforeEach(() => {
  createEntry.mockReset();
  updateDecision.mockReset();
});

describe("POST /api/journal", () => {
  it("answers 409 with the rule's own code for each closed-setup refusal", async () => {
    for (const code of ["SETUP_CLOSED", "LATE_ENTRY_REQUIRED", "LATE_ENTRY_INVALID"]) {
      createEntry.mockResolvedValue(refusal(code));
      const res = await post({ trackedSetupId: SETUP_ID, decision: "WATCHING" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toEqual({ code, message: `refused: ${code}` });
    }
  });

  it("still answers a missing or foreign setup with the same 404 as before", async () => {
    createEntry.mockResolvedValue(refusal("INVALID_TRANSITION", "trackedSetupId"));
    const res = await post({ trackedSetupId: SETUP_ID, decision: "SKIPPED" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SETUP_NOT_FOUND");
  });

  it("passes an acknowledged late entry through to the service, unchanged", async () => {
    createEntry.mockResolvedValue({ ok: true, value: { id: ENTRY_ID, created: true } });
    const res = await post({
      trackedSetupId: SETUP_ID,
      decision: "TAKEN",
      lateEntry: { acknowledged: true, enteredAt: INSIDE },
    });
    expect(res.status).toBe(201);
    expect(createEntry.mock.calls[0][0].lateEntry).toEqual({
      acknowledged: true,
      enteredAt: INSIDE,
    });
  });

  it("sends no late entry when none was given", async () => {
    createEntry.mockResolvedValue({ ok: true, value: { id: ENTRY_ID, created: true } });
    await post({ trackedSetupId: SETUP_ID, decision: "SKIPPED" });
    expect(createEntry.mock.calls[0][0].lateEntry).toBeNull();
  });

  it("refuses a malformed late entry before the service sees it", async () => {
    for (const lateEntry of [
      { acknowledged: false, enteredAt: INSIDE },
      { enteredAt: INSIDE },
      { acknowledged: true },
      { acknowledged: true, enteredAt: "2026-10-27" },
      { acknowledged: true, enteredAt: -5 },
      { acknowledged: true, enteredAt: INSIDE, verified: true },
    ]) {
      const res = await post({ trackedSetupId: SETUP_ID, decision: "TAKEN", lateEntry });
      expect(res.status, JSON.stringify(lateEntry)).toBe(400);
    }
    expect(createEntry).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/journal/:id/decision", () => {
  it("answers 409 with the rule's own code for each closed-setup refusal", async () => {
    for (const code of ["SETUP_CLOSED", "LATE_ENTRY_REQUIRED", "LATE_ENTRY_INVALID"]) {
      updateDecision.mockResolvedValue(refusal(code));
      const res = await patch({ decision: "TAKEN" });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it("keeps 404 for a missing entry and 400 for the journal's own transition rule", async () => {
    updateDecision.mockResolvedValue(refusal("INVALID_TRANSITION", "id"));
    const missing = await patch({ decision: "TAKEN" });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("JOURNAL_NOT_FOUND");

    updateDecision.mockResolvedValue(refusal("INVALID_TRANSITION"));
    const illegal = await patch({ decision: "SKIPPED" });
    expect(illegal.status).toBe(400);
    expect((await illegal.json()).error.code).toBe("INVALID_TRANSITION");
  });

  it("passes an acknowledged late entry through, and refuses a malformed one with 400", async () => {
    updateDecision.mockResolvedValue({ ok: true, value: { changed: true } });
    const ok = await patch({
      decision: "TAKEN",
      lateEntry: { acknowledged: true, enteredAt: INSIDE },
    });
    expect(ok.status).toBe(200);
    expect(updateDecision.mock.calls[0][0].lateEntry).toEqual({
      acknowledged: true,
      enteredAt: INSIDE,
    });

    updateDecision.mockClear();
    const bad = await patch({ decision: "TAKEN", lateEntry: { acknowledged: true } });
    expect(bad.status).toBe(400);
    expect(updateDecision).not.toHaveBeenCalled();
  });
});
