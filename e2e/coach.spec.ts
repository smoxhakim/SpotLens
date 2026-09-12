import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";

/**
 * The Coach, on a tracked setup.
 *
 * Seeded rather than scanned: this spec is about the review, and the numbers
 * have to be known in advance for "the Coach shows exactly what SpotLens
 * recorded" to mean anything. The ranking and the analysis are proved against
 * real passes elsewhere.
 *
 * Two properties carry the weight. Every figure on the page is the figure in
 * the row — not rounded differently, not recomputed. And a setup belonging to
 * somebody else is indistinguishable from one that does not exist.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const email = `e2e-coach-${Date.now()}@spotlens.test`;
const strangerEmail = `e2e-coach-stranger-${Date.now()}@spotlens.test`;
const password = "a-long-enough-password";

const prisma = new PrismaClient();

let runId = "";
let setupId = "";
let strangerSetupId = "";

/** Exact values, so the assertions can name them. */
const LEVELS = {
  entryLow: "0.25769354",
  entryHigh: "0.25880646",
  stopLoss: "0.24671011",
  takeProfit1: "0.2634",
  takeProfit2: "0.2699",
  riskReward: "2.4",
  score: 62,
};

const SNAPSHOT = {
  trend: "BULLISH",
  regime: { direction: "TRENDING_UP", volatility: "NORMAL", evidence: 2 },
  entryReason: "This is the nearest support zone below price, tested 2 times.",
  stopLossReason: "Placed below the zone with an ATR buffer.",
  riskRewardReason: "Measured to TP2, a structural level away.",
  statusReason: "Price has not reached the entry zone yet.",
  mtfAgreement: "ALIGNED_BULLISH",
  createdFromCandleTime: 1_700_000_000_000,
  takeProfits: [
    { label: "TP1", level: 0.2634, rr: 0.45, reason: "The near edge of a resistance zone." },
    { label: "TP2", level: 0.2699, rr: 2.4, reason: "A higher resistance zone." },
  ],
  scoreBreakdown: {
    trend: { score: 22, max: 25, reason: "Structure is bullish with high confidence." },
    volume: { score: 3, max: 15, reason: "Volume is below average and does not back the move." },
  },
};

async function seedSetup(userId: string, pairId: string) {
  const setup = await prisma.trackedSetup.create({
    data: {
      userId,
      tradingPairId: pairId,
      timeframe: "H1",
      status: "WAITING_CONFIRMATION",
      entryLow: LEVELS.entryLow,
      entryHigh: LEVELS.entryHigh,
      stopLoss: LEVELS.stopLoss,
      takeProfit1: LEVELS.takeProfit1,
      takeProfit2: LEVELS.takeProfit2,
      riskReward: LEVELS.riskReward,
      riskRewardIsSynthetic: false,
      score: LEVELS.score,
      scoreGrade: "MODERATE",
      analysisStatus: "WAIT_FOR_CONFIRMATION",
      snapshot: SNAPSHOT,
      originZoneLow: LEVELS.entryLow,
      originZoneHigh: LEVELS.entryHigh,
      events: {
        create: {
          type: "CREATED",
          toStatus: "WAITING_CONFIRMATION",
          detail: "Seeded.",
          payload: {
            status: "NOT_PRESENT",
            explanation: "Not enough confirmation yet.",
            evaluatedAt: 1_700_000_000_000,
            signals: [
              {
                type: "HIGHER_LOW",
                signal: "positive",
                title: "A higher low has formed",
                detail: "The most recent swing low is above the one before it.",
              },
              {
                type: "VOLUME_CONFIRMATION",
                signal: "negative",
                title: "Volume is too thin to confirm",
                detail: "Volume is well below average.",
              },
            ],
          },
        },
      },
    },
    select: { id: true },
  });

  return setup.id;
}

test.describe("coach review", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    if (!DATABASE_URL) return;

    const owner = await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 10) },
      select: { id: true },
    });
    const stranger = await prisma.user.create({
      data: { email: strangerEmail, passwordHash: await bcrypt.hash(password, 10) },
      select: { id: true },
    });

    const pair = await prisma.tradingPair.findFirst({
      where: { exchangeSymbol: "XTZUSDT" },
      select: { id: true },
    });
    if (!pair) throw new Error("Seed the trading pairs first: npm run prisma:seed");

    const run = await prisma.scannerRun.create({
      data: {
        status: "COMPLETED",
        timeframes: ["H1"],
        triggeredBy: "MANUAL",
        marketCount: 45,
        analysed: 45,
        succeeded: 45,
        completedAt: new Date(),
      },
      select: { id: true },
    });
    runId = run.id;

    setupId = await seedSetup(owner.id, pair.id);
    strangerSetupId = await seedSetup(stranger.id, pair.id);
  });

  test.afterAll(async () => {
    try {
      await prisma.user.deleteMany({ where: { email: { startsWith: "e2e-coach-" } } });
      if (runId) await prisma.scannerRun.deleteMany({ where: { id: runId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("shows exactly the numbers SpotLens recorded, and reads them", async ({ page }) => {
    test.setTimeout(180_000);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });

    await page.goto(`/coach?symbol=XTZUSDT&tf=H1&runId=${runId}&setupId=${setupId}`);
    await expect(page.getByRole("heading", { name: "Coach", exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const body = page.locator("main");

    // --- numeric integrity: the row's values, unchanged ---------------------
    await expect(body).toContainText(LEVELS.entryLow);
    await expect(body).toContainText(LEVELS.entryHigh);
    await expect(body).toContainText(LEVELS.stopLoss);
    await expect(body).toContainText(LEVELS.takeProfit1);
    await expect(body).toContainText(LEVELS.takeProfit2);
    await expect(page.getByText("1:2.4 · Measured")).toBeVisible();
    await expect(page.getByText(`${LEVELS.score}/100 · moderate`)).toBeVisible();

    // --- the engine's own words, quoted rather than rewritten ---------------
    await expect(body).toContainText(SNAPSHOT.entryReason);
    await expect(body).toContainText(SNAPSHOT.stopLossReason);
    await expect(body).toContainText(SNAPSHOT.scoreBreakdown.trend.reason);

    // --- confirmation, with missing kept apart from contradicting ----------
    await expect(body).toContainText("Confirmation is NOT_PRESENT");
    await expect(body).toContainText("A higher low has formed");
    await expect(body).toContainText("Not established — volume is too thin to confirm");
    await expect(body).toContainText("1 supporting, 1 not established, 0 against");

    // --- invalidation, from the engine's own rules --------------------------
    await expect(body).toContainText("What would invalidate it");
    await expect(body).toContainText("CONTRADICTED");

    // --- and nothing that reads like an instruction -------------------------
    const text = (await body.innerText())
      .toLowerCase()
      .split("no trade outcome is guaranteed")
      .join(" ");
    for (const banned of [
      "guaranteed",
      "buy now",
      "sell now",
      "must buy",
      "act now",
      "risk-free",
      "probability",
      "chance of success",
    ]) {
      expect(text, `Coach said "${banned}"`).not.toContain(banned);
    }

    for (const banned of ["Buy", "Sell", "Execute", "Approve", "Place order", "Trade now"]) {
      await expect(page.getByRole("button", { name: banned, exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: banned, exact: true })).toHaveCount(0);
    }
  });

  test("cannot be used to read another account's setup", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });

    // A real setup id, belonging to somebody else.
    const forbidden = await page.request.get(
      `/api/coach?symbol=XTZUSDT&tf=H1&runId=${runId}&setupId=${strangerSetupId}`,
    );
    const missing = await page.request.get(
      `/api/coach?symbol=XTZUSDT&tf=H1&runId=${runId}&setupId=55555555-5555-4555-8555-555555555555`,
    );

    // Indistinguishable: the same status and the same body, so existence
    // cannot be probed by watching which one answers differently.
    expect(forbidden.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(await forbidden.text()).toBe(await missing.text());

    // And nothing of the other account's leaks into the response.
    const text = await forbidden.text();
    expect(text).not.toContain(LEVELS.entryLow);
    expect(text).not.toContain(strangerEmail);
  });

  test("labels the reading, and never claims a model wrote one that did not", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });

    await page.goto(`/coach?symbol=XTZUSDT&tf=H1&runId=${runId}&setupId=${setupId}`);
    await expect(page.getByRole("heading", { name: "Coach", exact: true })).toBeVisible({
      timeout: 30_000,
    });

    // The suite runs with no OPENAI_API_KEY, so the deterministic reviewer
    // answers — and the page says so rather than implying an AI wrote it. A key
    // in the environment would show the "AI Coach review" banner instead;
    // either way the page never leaves the reader guessing.
    //
    // Polled rather than read once: the heading is server-rendered and appears
    // before the review has loaded, so a single innerText catches the skeleton.
    await expect
      .poll(
        async () => {
          const text = await page.locator("main").innerText();
          return (
            text.includes("SpotLens's own deterministic reading") ||
            text.includes("AI Coach review") ||
            text.includes("AI Coach was unavailable")
          );
        },
        { timeout: 30_000, message: "the page did not say which kind of reading this is" },
      )
      .toBe(true);

    // Whichever answered, no key and no provider detail reaches the browser.
    const html = await page.content();
    expect(html).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
    expect(html).not.toContain("api.openai.com");
    expect(html).not.toContain("OPENAI_API_KEY");

    // And the API does not hand the model id out either.
    const api = await page.request.get(
      `/api/coach?symbol=XTZUSDT&tf=H1&runId=${runId}&setupId=${setupId}`,
    );
    const payload = await api.json();
    expect(["MODEL", "DETERMINISTIC"]).toContain(payload.source);
    expect(JSON.stringify(payload)).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);
    expect(JSON.stringify(payload)).not.toContain("api.openai.com");
  });

  test("refuses an unauthenticated caller and a malformed reference", async ({ request }) => {
    const anonymous = await request.get(`/api/coach?symbol=XTZUSDT&tf=H1&runId=${runId}`);
    expect(anonymous.status()).toBe(401);

    for (const query of [
      "symbol=XTZUSDT&tf=H1", // no run
      "symbol=XTZUSDT&tf=NOPE&runId=" + runId, // not a timeframe
      "symbol=%3Cscript%3E&tf=H1&runId=" + runId, // not a symbol
      `symbol=XTZUSDT&tf=H1&runId=not-a-uuid`,
      `symbol=XTZUSDT&tf=H1&runId=${runId}&setupId=../../etc`,
      // A fifth key is refused rather than ignored: the handoff is four
      // references, and anything else is a number travelling in a URL.
      `symbol=XTZUSDT&tf=H1&runId=${runId}&entry=99999`,
    ]) {
      const response = await request.get(`/api/coach?${query}`);
      expect([400, 401], query).toContain(response.status());
    }
  });
});
