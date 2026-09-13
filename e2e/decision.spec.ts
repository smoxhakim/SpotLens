import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";

import { signIn } from "./support/session";

/**
 * The decision workflow, end to end.
 *
 * Opportunities → analysis → Coach → risk calculator → decision → journal, as a
 * person actually walks it. Seeded as scanner rows rather than produced by
 * running the engine against whatever the market is doing today: this spec is
 * about the workflow, and it must fail for the right reason.
 *
 * Two paths, because they are genuinely different records. A *tracked* setup
 * has an immutable snapshot with levels; an *untracked* candidate has a verdict
 * and a score and nothing else, and the journal has to say so rather than
 * inventing the difference away.
 *
 * No real OpenAI call happens here. Playwright's web server runs with an empty
 * OPENAI_API_KEY, so the Coach resolves to SpotLens's own deterministic reading
 * — which is what the Coach page says on its face, and what this asserts.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const email = `e2e-decision-${Date.now()}@spotlens.test`;
const password = "a-long-enough-password";

const prisma = new PrismaClient();

let runId = "";
let setupId = "";
let userId = "";

/** The immutable snapshot a tracked setup carries. */
const SNAPSHOT = {
  entryReason: "Price is returning to the support zone it last bounced from.",
  stopLossReason: "Below the zone, past the wick that defined it.",
  riskRewardReason: "Risking 4 to make 12 at TP2 — a ratio of 1:3.",
  statusReason: "The level is there; the buyers have not shown up yet.",
  takeProfits: [
    { label: "TP1", level: 2600, rr: 0.5, kind: "STRUCTURAL", reason: "nearest resistance" },
    { label: "TP2", level: 2640, rr: 3, kind: "STRUCTURAL", reason: "prior swing high" },
  ],
  scoreBreakdown: {
    trend: { score: 20, max: 25, reason: "Higher lows since the reclaim." },
    structure: { score: 18, max: 25, reason: "The zone has held twice." },
  },
  trend: "BULLISH",
  mtfAgreement: "ALIGNED",
  createdFromCandleTime: 1_700_000_000_000,
  regime: { direction: "TRENDING_UP", volatility: "NORMAL", evidence: 2 },
};

test.describe("the decision workflow", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    if (!DATABASE_URL) return;

    const user = await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 10) },
      select: { id: true },
    });
    userId = user.id;

    const run = await prisma.scannerRun.create({
      data: {
        status: "COMPLETED",
        timeframes: ["H4"],
        triggeredBy: "MANUAL",
        marketCount: 45,
        analysed: 45,
        succeeded: 45,
        completedAt: new Date(),
      },
      select: { id: true },
    });
    runId = run.id;

    const eth = await prisma.tradingPair.findFirst({
      where: { exchangeSymbol: "ETHUSDT" },
      select: { id: true },
    });
    const sol = await prisma.tradingPair.findFirst({
      where: { exchangeSymbol: "SOLUSDT" },
      select: { id: true },
    });
    if (!eth || !sol) throw new Error("Seed the trading pairs first: npm run prisma:seed");

    // --- the tracked one: a setup the scanner began following ---------------
    const setup = await prisma.trackedSetup.create({
      data: {
        userId,
        tradingPairId: eth.id,
        timeframe: "H4",
        status: "WAITING_CONFIRMATION",
        entryLow: 2500,
        entryHigh: 2508,
        stopLoss: 2480,
        takeProfit1: 2600,
        takeProfit2: 2640,
        riskReward: 3,
        riskRewardIsSynthetic: false,
        score: 81,
        scoreGrade: "STRONG",
        analysisStatus: "WAIT_FOR_CONFIRMATION",
        snapshot: SNAPSHOT,
        originZoneLow: 2490,
        originZoneHigh: 2510,
        events: {
          create: {
            type: "CREATED",
            fromStatus: null,
            toStatus: "WAITING_CONFIRMATION",
            detail: "Setup first seen.",
          },
        },
      },
      select: { id: true },
    });
    setupId = setup.id;

    await prisma.scannerResult.create({
      data: {
        scannerRunId: runId,
        tradingPairId: eth.id,
        timeframe: "H4",
        status: "OK",
        analysisStatus: "WAIT_FOR_CONFIRMATION",
        score: 81,
        riskReward: 3,
        riskRewardIsSynthetic: false,
        analysedAtCandle: BigInt(1_700_000_000_000),
        trackedSetupId: setupId,
        lifecycleStatus: "WAITING_CONFIRMATION",
        trend: "BULLISH",
        mtfAgreement: "ALIGNED",
        regimeDirection: "TRENDING_UP",
      },
    });

    // --- the untracked one: scored, never followed --------------------------
    await prisma.scannerResult.create({
      data: {
        scannerRunId: runId,
        tradingPairId: sol.id,
        timeframe: "H4",
        status: "OK",
        analysisStatus: "AVOID",
        score: 41,
        analysedAtCandle: BigInt(1_700_000_000_000),
        trend: "BEARISH",
        regimeDirection: "TRENDING_DOWN",
      },
    });
  });

  test.afterAll(async () => {
    try {
      await prisma.user.deleteMany({ where: { email: { startsWith: "e2e-decision-" } } });
      if (runId) await prisma.scannerRun.deleteMany({ where: { id: runId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("walks a tracked setup from the shortlist to a recorded decision", async ({ page }) => {
    test.setTimeout(180_000);

    await signIn(page, email, password);

    // --- opportunities -------------------------------------------------------
    await page.getByRole("link", { name: "Opportunities" }).first().click();
    await expect(page.getByRole("heading", { name: /Top opportunities to review/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("ETHUSDT").first()).toBeVisible();

    // --- ask the Coach about it ---------------------------------------------
    await page.getByRole("link", { name: /Ask Coach about ETHUSDT/ }).click();
    await expect(page.getByRole("heading", { name: "Coach", exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // No key is configured for the test server, so this is the deterministic
    // reading — and the page says which it is rather than letting a reader guess.
    await expect(page.getByText(/deterministic reading|AI Coach/).first()).toBeVisible({
      timeout: 60_000,
    });

    // --- the canonical numbers, on the Coach's own page ----------------------
    await expect(page.getByText("2480").first()).toBeVisible();
    await expect(page.getByText(/81\/100/).first()).toBeVisible();

    // --- the decision sits below the review, in its own section --------------
    await expect(page.getByRole("heading", { name: "Your decision" })).toBeVisible({
      timeout: 30_000,
    });
    // Never this. The Coach reads the same analysis the reader does.
    await expect(page.getByText(/Coach approved|Coach rejected/)).toHaveCount(0);

    // --- size a position on the way ------------------------------------------
    await page.getByRole("link", { name: "Size a position" }).click();
    await expect(page.getByRole("heading", { name: "Risk Calculator" })).toBeVisible({
      timeout: 30_000,
    });

    // Prefilled from the stored setup: the entry midpoint, the stop, and the
    // target the ratio was measured to.
    await expect(page.getByLabel("Entry price")).toHaveValue("2504");
    await expect(page.getByLabel("Stop loss")).toHaveValue("2480");
    await expect(page.getByLabel("Take profit (optional)")).toHaveValue("2640");

    // Capital is not risk: 1% of 1000 over a 24-wide stop is a 104-unit
    // position risking 10, not a 1000-unit one.
    await page.getByLabel("Account balance").fill("1000");
    await page.getByLabel("Risk per trade (%)").fill("1");
    await expect(page.getByTestId("risk-amount")).toContainText("10");
    await expect(page.getByTestId("position-size")).toBeVisible();

    // --- back to the decision -------------------------------------------------
    await page.getByRole("link", { name: "Your decision" }).click();
    await expect(page.getByRole("heading", { name: "Your decision" }).first()).toBeVisible({
      timeout: 30_000,
    });

    // --- record it ------------------------------------------------------------
    await page.getByRole("radio", { name: /Take/ }).click();
    await page
      .getByLabel(/Your reasoning/)
      .fill("Higher timeframe is aligned and the zone has held twice.");
    await page.getByRole("button", { name: "Record decision" }).click();

    // Take asks again, and says what it is and is not doing.
    await expect(page.getByText(/SpotLens will not place an order/)).toBeVisible();
    await page.getByRole("button", { name: "Record decision" }).last().click();

    await expect(page.getByText(/No trade was executed by SpotLens/)).toBeVisible({
      timeout: 30_000,
    });

    // --- the journal has it ---------------------------------------------------
    await page.getByRole("link", { name: /View journal entry/ }).click();
    await expect(page.getByText("ETHUSDT").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Higher timeframe is aligned/)).toBeVisible();
    await expect(page.getByText("SpotLens plan")).toBeVisible();
    // The setup's own frozen numbers, beside the decision and not merged with it.
    //
    // Formatted, because the journal renders prices through `formatPrice` — the
    // Coach page above shows the same stop as a raw `2480`, and asserting that
    // spelling here is what failed first. The *value* is identical either way;
    // only the presentation differs, and the assertion has to name the one this
    // page actually produces rather than the one the previous page did.
    await expect(page.getByText("2,480.00").first()).toBeVisible();

    // A decision is not an outcome. Nothing here may imply the trade happened.
    await expect(page.getByText(/realized|realised/i)).toHaveCount(0);

    // --- and the stored setup is untouched ------------------------------------
    const after = await prisma.trackedSetup.findUnique({ where: { id: setupId } });
    expect(Number(after!.entryLow)).toBe(2500);
    expect(Number(after!.stopLoss)).toBe(2480);
    expect(after!.score).toBe(81);

    const entry = await prisma.journalEntry.findFirst({
      where: { userId, trackedSetupId: setupId },
    });
    expect(entry!.decision).toBe("TAKEN");
    // The lifecycle state frozen at the decision, not wherever the setup goes.
    expect(entry!.setupStatusAtDecision).toBe("WAITING_CONFIRMATION");
    // A decision, not a trade: every trade column is still empty.
    expect(entry!.actualEntry).toBeNull();
    expect(entry!.quantity).toBeNull();
    expect(entry!.openedAt).toBeNull();
  });

  test("records a decision about a market that was never tracked", async ({ page }) => {
    test.setTimeout(180_000);

    await signIn(page, email, password);

    await page.goto(`/decision?symbol=SOLUSDT&tf=H4&runId=${runId}`);
    await expect(page.getByRole("heading", { name: "Your decision" }).first()).toBeVisible({
      timeout: 30_000,
    });

    // The absence is stated, not papered over.
    await expect(page.getByText(/never tracked a setup for it/).first()).toBeVisible();
    // And no levels are shown, because none exist.
    await expect(page.getByText("Entry", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Size a position")).toHaveCount(0);
    // The verdict and the score the scanner did record.
    await expect(page.getByText(/41\/100/).first()).toBeVisible();

    await page.getByRole("radio", { name: /Skip/ }).click();
    await page.getByLabel(/Your reasoning/).fill("Engine says avoid and I agree.");
    await page.getByRole("button", { name: "Record decision" }).click();

    await expect(page.getByText(/Decision recorded/)).toBeVisible({ timeout: 30_000 });

    // --- the journal shows it as what it is -----------------------------------
    await page.getByRole("link", { name: "Journal" }).first().click();
    await expect(page.getByTestId("journal-entries")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Untracked opportunity/).first()).toBeVisible();

    const entry = await prisma.journalEntry.findFirst({
      where: {
        userId,
        scannerRunId: runId,
        timeframe: "H4",
        tradingPair: { exchangeSymbol: "SOLUSDT" },
      },
    });
    expect(entry!.decision).toBe("SKIPPED");
    expect(entry!.trackedSetupId).toBeNull();
    // No lifecycle state, because there was no lifecycle.
    expect(entry!.setupStatusAtDecision).toBeNull();
    expect(entry!.notes).toBe("Engine says avoid and I agree.");
  });
});
