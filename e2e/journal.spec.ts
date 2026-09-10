import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

/**
 * Journal, replay and research end to end.
 *
 * The setup being journaled is seeded directly rather than produced by running
 * the engine against whatever the market is doing today: this test is about the
 * decision workflow, and it must fail for the right reason. Its candles are
 * seeded too, so replay has something to reconstruct without ever fetching.
 *
 * Everything is cleaned up afterwards, including the seeded candles.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const email = `e2e-journal-${Date.now()}@spotlens.test`;
const password = "a-long-enough-password";

const HOUR = 3_600_000;
/** Fixed, so the replay window is the same on every run. */
const CREATED_AT = new Date("2026-03-01T00:00:00.000Z");

let setupId = "";
let pairId = "";
let userId = "";

const prisma = new PrismaClient();

test.describe("journal, replay and research", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    if (!DATABASE_URL) return;

    const pair = await prisma.tradingPair.findFirst({
      where: { exchangeSymbol: "BTCUSDT" },
      select: { id: true },
    });
    if (!pair) throw new Error("Seed the trading pairs first: npm run prisma:seed");
    pairId = pair.id;
  });

  test.afterAll(async () => {
    try {
      // Every account this spec has ever created, not just this run's: a test
      // that fails partway leaves one behind, and retries would otherwise silt
      // up the database one row at a time.
      await prisma.user.deleteMany({
        where: { email: { startsWith: "e2e-journal-" } },
      });
      if (pairId) {
        await prisma.candle.deleteMany({
          where: {
            tradingPairId: pairId,
            timeframe: "H1",
            openTime: {
              gte: new Date(CREATED_AT.getTime() - 60 * HOUR),
              lte: CREATED_AT,
            },
          },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test("records a decision, replays it, and reports on it", async ({ page }) => {
    test.setTimeout(180_000);

    // --- an account -------------------------------------------------------
    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
      timeout: 30_000,
    });

    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    userId = user!.id;

    // --- a setup, and the history to replay it against --------------------
    const setup = await prisma.trackedSetup.create({
      data: {
        userId,
        tradingPairId: pairId,
        timeframe: "H1",
        status: "WAITING_CONFIRMATION",
        entryLow: 60000,
        entryHigh: 60500,
        stopLoss: 58000,
        takeProfit1: 65000,
        takeProfit2: 68000,
        riskReward: 2,
        riskRewardIsSynthetic: false,
        score: 72,
        scoreGrade: "B",
        analysisStatus: "WAIT_FOR_CONFIRMATION",
        originZoneLow: 60000,
        originZoneHigh: 60500,
        snapshot: { regime: { direction: "TRENDING_UP", volatility: "NORMAL" } },
        createdAt: CREATED_AT,
        events: {
          create: {
            type: "CREATED",
            fromStatus: null,
            toStatus: "WAITING_CONFIRMATION",
            detail: "Seeded for the end-to-end journal test.",
            createdAt: CREATED_AT,
          },
        },
      },
      select: { id: true },
    });
    setupId = setup.id;

    await prisma.candle.createMany({
      data: Array.from({ length: 40 }, (_, i) => {
        const openTime = CREATED_AT.getTime() - (40 - i) * HOUR;
        const close = 60000 + i * 10;
        return {
          tradingPairId: pairId,
          timeframe: "H1" as const,
          openTime: new Date(openTime),
          closeTime: new Date(openTime + HOUR - 1),
          open: close - 5,
          high: close + 40,
          low: close - 40,
          close,
          volume: 100,
        };
      }),
      skipDuplicates: true,
    });

    // --- journaling it ----------------------------------------------------
    const created = await page.request.post("/api/journal", {
      data: { trackedSetupId: setupId, decision: "WATCHING", notes: "waiting on the 4h close" },
    });
    expect(created.status()).toBe(201);
    const entryId = (await created.json()).id as string;

    // Journaling the same setup again returns the entry that exists rather
    // than minting a second opinion on the same decision.
    const again = await page.request.post("/api/journal", {
      data: { trackedSetupId: setupId },
    });
    expect(again.status()).toBe(200);
    expect((await again.json()).id).toBe(entryId);

    // --- it shows up ------------------------------------------------------
    await page.goto("/journal");
    await expect(page.getByRole("heading", { name: "Journal" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("journal-entries")).toContainText("BTCUSDT", {
      timeout: 30_000,
    });
    await expect(page.getByText("waiting on the 4h close")).toBeVisible();

    // --- the decision moves, and the history keeps both -------------------
    const taken = await page.request.patch(`/api/journal/${entryId}/decision`, {
      data: { decision: "TAKEN", notes: "took the retest" },
    });
    expect(taken.ok()).toBeTruthy();

    // A position cannot retroactively become one that was passed over.
    const unwind = await page.request.patch(`/api/journal/${entryId}/decision`, {
      data: { decision: "SKIPPED" },
    });
    expect(unwind.status()).toBe(400);
    expect(await unwind.text()).toMatch(/cannot become skipped/i);

    // --- the result, in the user's own numbers ----------------------------
    const outcome = await page.request.post(`/api/journal/${entryId}/outcome`, {
      data: {
        actualEntry: 60200,
        actualStopLoss: 58000,
        actualExit: 64600,
        quantity: 0.1,
        fees: 5,
        close: true,
      },
    });
    expect(outcome.ok()).toBeTruthy();
    // Risked 220, made 440 less 5 in fees.
    expect((await outcome.json()).realizedR).toBeCloseTo(1.98, 1);

    // A closed entry is terminal as a decision.
    const reopen = await page.request.patch(`/api/journal/${entryId}/decision`, {
      data: { decision: "TAKEN" },
    });
    expect(reopen.status()).toBe(400);

    // --- correcting a mistyped fill keeps the version it replaced ---------
    const amended = await page.request.post(`/api/journal/${entryId}/outcome`, {
      data: {
        actualEntry: 60250,
        actualStopLoss: 58000,
        actualExit: 64600,
        quantity: 0.1,
        fees: 5,
        close: true,
      },
    });
    expect(amended.ok()).toBeTruthy();

    const { entry: detail } = await (await page.request.get(`/api/journal/${entryId}`)).json();

    // The entry holds the corrected numbers...
    expect(detail.trade.actualEntry).toBe(60250);
    // ...and the original is recoverable in full, not summarised into prose.
    expect(detail.supersededVersions).toHaveLength(1);
    expect(detail.supersededVersions[0]).toMatchObject({
      actualEntry: 60200,
      actualStopLoss: 58000,
      actualExit: 64600,
      quantity: 0.1,
      fees: 5,
    });

    // The amendment is an added event, not an edited one.
    const recordings = detail.journalEvents.filter(
      (e: { type: string }) => e.type === "OUTCOME_RECORDED",
    );
    expect(recordings).toHaveLength(2);
    expect(recordings[0].supersededOutcome).toBeNull();
    expect(recordings[1].supersededOutcome.actualEntry).toBe(60200);
    expect(recordings[1].detail).toMatch(/^Amended\./);

    // And the decision is still closed.
    expect(detail.decision).toBe("CLOSED");

    // --- the entry, with both records side by side ------------------------
    await page.goto(`/journal/${entryId}`);
    // Both records, labelled as whose they are.
    await expect(page.getByText("SpotLens plan").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Your decision").first()).toBeVisible();
    await expect(page.getByText("Your trade").first()).toBeVisible();
    await expect(page.getByText("took the retest")).toBeVisible();

    // --- replay -----------------------------------------------------------
    const replay = await page.request.get(`/api/replay/${setupId}?at=${CREATED_AT.getTime()}`);
    expect(replay.ok()).toBeTruthy();
    const frame = (await replay.json()).frame;

    expect(frame.snapshot.source).toBe("HISTORICAL_SNAPSHOT");
    expect(frame.snapshot.score).toBe(72);
    expect(frame.candles.length).toBeGreaterThan(0);
    // Nothing after the moment being reconstructed.
    for (const candle of frame.candles) {
      expect(candle.closeTime).toBeLessThanOrEqual(CREATED_AT.getTime());
    }
    // The decision came later, so it is not visible from this point.
    expect(frame.decision).toBeNull();

    await page.goto(`/replay/${setupId}`);
    await expect(page.getByText("historical snapshot").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("What SpotLens said").first()).toBeVisible();

    // --- research ---------------------------------------------------------
    const research = await page.request.get("/api/research");
    expect(research.ok()).toBeTruthy();
    const report = (await research.json()).report;

    // One setup detected by the engine; one trade taken and closed by the user.
    expect(report.engine.setupsDetected).toBe(1);
    expect(report.human.journaled).toBe(1);
    expect(report.human.closed).toBe(1);
    expect(report.outcomes.totalSetups).toBe(1);
    expect(report.smallSample).toBe(true);

    await page.goto("/research");
    await expect(page.getByRole("heading", { name: "Research" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/small sample|too few/i).first()).toBeVisible({ timeout: 30_000 });
  });

  test("another account cannot reach the entry", async ({ page }) => {
    const other = `e2e-journal-b-${Date.now()}@spotlens.test`;

    await page.goto("/register");
    await page.getByLabel("Email").fill(other);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
      timeout: 30_000,
    });

    try {
      // 404 rather than 403 throughout: the endpoints must not double as a way
      // of asking which ids exist.
      expect((await page.request.get(`/api/replay/${setupId}`)).status()).toBe(404);
      expect(
        (await page.request.post("/api/journal", { data: { trackedSetupId: setupId } })).status(),
      ).toBe(404);

      // And the research report sees none of it.
      const report = (await (await page.request.get("/api/research")).json()).report;
      expect(report.engine.setupsDetected).toBe(0);
      expect(report.human.journaled).toBe(0);
    } finally {
      const row = await prisma.user.findUnique({ where: { email: other }, select: { id: true } });
      if (row) await prisma.user.delete({ where: { id: row.id } }).catch(() => {});
    }
  });
});

test("the journal and research pages require an account", async ({ page }) => {
  for (const path of ["/journal", "/research"]) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible({
      timeout: 30_000,
    });
  }
});
