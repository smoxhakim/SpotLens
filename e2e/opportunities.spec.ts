import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";

import { signIn } from "./support/session";

/**
 * Top Opportunities, end to end.
 *
 * The shortlist is seeded as scanner rows rather than produced by running the
 * engine against whatever the market is doing today: this spec is about the
 * review surface, and it must fail for the right reason. Phase L already proves
 * the ranking against real passes.
 *
 * What it checks is the property the page exists to keep — that the order on
 * screen is the order the scanner produced, whichever view or filter is chosen,
 * and that nothing on it can be mistaken for placing a trade.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const email = `e2e-opportunities-${Date.now()}@spotlens.test`;
const password = "a-long-enough-password";

const prisma = new PrismaClient();

let runId = "";

/**
 * Eight eligible results, alternating timeframe, with scores descending so the
 * canonical order is unambiguous and the expected ranking can be written down.
 */
const SEEDED = [
  { symbol: "BTCUSDT", timeframe: "H1" as const, score: 90 },
  { symbol: "ETHUSDT", timeframe: "H4" as const, score: 88 },
  { symbol: "SOLUSDT", timeframe: "H1" as const, score: 86 },
  { symbol: "LINKUSDT", timeframe: "H4" as const, score: 84 },
  { symbol: "AVAXUSDT", timeframe: "H1" as const, score: 82 },
  { symbol: "DOTUSDT", timeframe: "H4" as const, score: 80 },
  { symbol: "ATOMUSDT", timeframe: "H1" as const, score: 78 },
  { symbol: "NEARUSDT", timeframe: "H4" as const, score: 76 },
];

/** The symbols currently rendered, top to bottom. */
async function visibleSymbols(page: Page): Promise<string[]> {
  const text = await page.locator("main h3").allTextContents();
  return text.map((t) => t.trim().split(" ")[0]);
}

test.describe("top opportunities", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL");
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    if (!DATABASE_URL) return;

    await prisma.user.create({
      data: { email, passwordHash: await bcrypt.hash(password, 10) },
    });

    const run = await prisma.scannerRun.create({
      data: {
        status: "COMPLETED",
        timeframes: ["H1", "H4"],
        triggeredBy: "MANUAL",
        marketCount: 45,
        analysed: 90,
        succeeded: 90,
        completedAt: new Date(),
      },
      select: { id: true },
    });
    runId = run.id;

    for (const seed of SEEDED) {
      const pair = await prisma.tradingPair.findFirst({
        where: { exchangeSymbol: seed.symbol },
        select: { id: true },
      });
      if (!pair) throw new Error(`Seed the trading pairs first: npm run prisma:seed`);

      await prisma.scannerResult.create({
        data: {
          scannerRunId: runId,
          tradingPairId: pair.id,
          timeframe: seed.timeframe,
          status: "OK",
          analysisStatus: "WAIT_FOR_CONFIRMATION",
          score: seed.score,
          riskReward: 2.5,
          riskRewardIsSynthetic: false,
          analysedAtCandle: BigInt(1_700_000_000_000),
          trend: "BULLISH",
          mtfAgreement: "MIXED",
          regimeDirection: "TRENDING_UP",
        },
      });
    }
  });

  test.afterAll(async () => {
    try {
      await prisma.user.deleteMany({ where: { email: { startsWith: "e2e-opportunities-" } } });
      if (runId) await prisma.scannerRun.deleteMany({ where: { id: runId } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("reviews the shortlist without ever offering a way to trade", async ({ page }) => {
    test.setTimeout(180_000);

    await signIn(page, email, password);

    // --- reachable from the navigation the product intends ------------------
    await page.getByRole("link", { name: "Opportunities" }).first().click();
    await expect(page.getByRole("heading", { name: /Top opportunities to review/ })).toBeVisible({
      timeout: 30_000,
    });

    // --- the scan's breadth, not just its survivors -------------------------
    await expect(page.getByText(/45/).first()).toBeVisible();
    await expect(page.getByText(/analyses/).first()).toBeVisible();

    // --- Top 5 is the default -----------------------------------------------
    const views = page.getByRole("group", { name: "How many to show" });
    await expect(views.getByRole("button", { name: "Top 5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const top5 = await visibleSymbols(page);
    expect(top5).toEqual(["BTCUSDT", "ETHUSDT", "SOLUSDT", "LINKUSDT", "AVAXUSDT"]);

    // --- larger views extend the same order rather than replacing it --------
    await views.getByRole("button", { name: "Top 10" }).click();
    const top10 = await visibleSymbols(page);
    expect(top10.slice(0, 5)).toEqual(top5);
    expect(top10).toHaveLength(8);

    await views.getByRole("button", { name: "Top 15" }).click();
    expect((await visibleSymbols(page)).slice(0, 5)).toEqual(top5);

    await views.getByRole("button", { name: "All" }).click();
    const all = await visibleSymbols(page);
    expect(all.slice(0, 5)).toEqual(top5);

    // --- a filter removes, and never reorders -------------------------------
    const filters = page.getByRole("group", { name: "Filter by timeframe" });
    await filters.getByRole("button", { name: "1h" }).click();

    const h1 = await visibleSymbols(page);
    expect(h1).toEqual(["BTCUSDT", "SOLUSDT", "AVAXUSDT", "ATOMUSDT"]);
    // A subsequence of the canonical order: removal only.
    expect(h1).toEqual(all.filter((s) => h1.includes(s)));

    await filters.getByRole("button", { name: "All timeframes" }).click();

    // --- quality is a score, never a probability ----------------------------
    await expect(page.getByText("90/100 · Strong").first()).toBeVisible();
    await expect(page.getByText("1:2.5 · Measured").first()).toBeVisible();

    // The sentences that legitimately *deny* these words are removed before
    // the scan, exactly as the Telegram suite does with its disclaimer: a naive
    // word list would flag the very copy that makes the page honest.
    const body = (await page.locator("body").innerText())
      .toLowerCase()
      .split("quality is a score out of 100, never a probability")
      .join(" ")
      .split("no trade outcome is guaranteed")
      .join(" ");

    for (const banned of [
      "probability",
      "chance of",
      "guaranteed",
      "high probability",
      "buy now",
      "enter now",
      "don't miss",
      "winning setup",
      "% chance",
    ]) {
      expect(body, `page contained "${banned}"`).not.toContain(banned);
    }

    // --- and no control that could place one --------------------------------
    for (const banned of ["Buy", "Sell", "Execute", "Approve", "Enter position"]) {
      await expect(page.getByRole("button", { name: banned, exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: banned, exact: true })).toHaveCount(0);
    }

    // --- Ask Coach hands over references, and admits it is not built yet ----
    const coachHref = await page
      .getByRole("link", { name: /Ask Coach about BTCUSDT/ })
      .first()
      .getAttribute("href");

    // The whole contract, and exactly the whole contract: market, timeframe,
    // the pass that ranked it, and the tracked setup when there is one. A
    // fifth key would mean a number travelling in a URL.
    const coachParams = new URLSearchParams((coachHref ?? "").split("?")[1] ?? "");
    expect(coachParams.get("symbol")).toBe("BTCUSDT");
    expect(coachParams.get("tf")).toBe("H1");
    expect(coachParams.get("runId")).toBe(runId);
    expect([...coachParams.keys()].sort()).toEqual(["runId", "symbol", "tf"]);

    await page
      .getByRole("link", { name: /Ask Coach about BTCUSDT/ })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: "Coach", exact: true })).toBeVisible({
      timeout: 30_000,
    });

    expect(page.url()).toContain("symbol=BTCUSDT");
    expect(page.url()).toContain("tf=H1");
    expect(page.url()).toContain(`runId=${runId}`);

    // --- the review reads the numbers SpotLens recorded ---------------------
    // This candidate was scored but never tracked, so the scanner recorded no
    // levels for it — and the Coach says so instead of reconstructing them.
    await expect(page.getByText("90/100 · strong")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/deterministic SpotLens score/)).toBeVisible();
    await expect(page.getByText(/Insufficient data/)).toBeVisible();
    await expect(page.getByText(/No levels were recorded/)).toBeVisible();
    await expect(page.getByText(/will not reconstruct/)).toBeVisible();

    // Provenance: a review of a past pass says which pass, and says nothing
    // later was read.
    await expect(page.getByText(/Nothing later than that was used/)).toBeVisible();

    // --- and never talks like a trade signal --------------------------------
    // The shared disclaimer legitimately contains "guaranteed", in the sentence
    // denying that anything is. It is removed before the scan for the same
    // reason the Telegram suite removes it: a naive word list would flag the
    // very copy that makes the page honest.
    const coachText = (await page.locator("main").innerText())
      .toLowerCase()
      .split("no trade outcome is guaranteed")
      .join(" ");
    for (const banned of [
      "guaranteed",
      "buy now",
      "sell now",
      "act now",
      "don't miss",
      "risk-free",
      "probability",
      "chance of success",
    ]) {
      expect(coachText, `Coach said "${banned}"`).not.toContain(banned);
    }

    for (const banned of ["Buy", "Sell", "Execute", "Approve", "Place order"]) {
      await expect(page.getByRole("button", { name: banned, exact: true })).toHaveCount(0);
      await expect(page.getByRole("link", { name: banned, exact: true })).toHaveCount(0);
    }

    // --- malformed references are refused server-side -----------------------
    await page.goto(`/coach?symbol=%3Cscript%3E&tf=NOPE&runId=not-a-uuid&setupId=../../etc`);
    await expect(page.getByText(/Nothing to review yet/)).toBeVisible({ timeout: 30_000 });
    const rejected = await page.locator("main").innerText();
    expect(rejected).not.toContain("script");
    expect(rejected).not.toContain("NOPE");
    expect(rejected).not.toContain("etc");

    // --- a run that does not exist is a miss, not a leak --------------------
    await page.goto(`/coach?symbol=BTCUSDT&tf=H1&runId=99999999-9999-4999-8999-999999999999`);
    await expect(page.getByText(/No recorded analysis matches that reference/)).toBeVisible({
      timeout: 30_000,
    });

    await page.goto("/opportunities");
    await expect(page.getByRole("heading", { name: /Top opportunities/ })).toBeVisible({
      timeout: 30_000,
    });

    // --- Analyze opens the existing analysis, with the market's context -----
    await page
      .getByRole("link", { name: /Analyze BTCUSDT on 1h/ })
      .first()
      .click();

    await page.waitForURL(/market-analysis/, { timeout: 30_000 });
    expect(page.url()).toContain("pair=BTCUSDT");
    expect(page.url()).toContain("tf=H1");
  });

  test("stacks into a phone viewport without sideways scrolling", async ({ page }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, email, password);
    await page.goto("/opportunities");

    await expect(page.getByRole("heading", { name: /Top opportunities to review/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("90/100 · Strong").first()).toBeVisible();

    // The core information fits the screen. A card the reader has to drag
    // sideways to finish reading is the failure this checks for.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // Both actions remain reachable rather than collapsing off the card.
    await expect(page.getByRole("link", { name: /Analyze BTCUSDT/ }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Ask Coach about BTCUSDT/ }).first()).toBeVisible();
  });
});
