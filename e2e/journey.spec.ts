import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

/**
 * The full signed-in journey: sign up, analyze, save to the watchlist, and run
 * a backtest.
 *
 * Needs a database, so it is skipped when DATABASE_URL is unset. The account it
 * creates is deleted afterwards, cascading its watchlist rows, saved analyses
 * and backtests, so repeated runs do not silt up the database.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const email = `e2e-${Date.now()}@spotlens.test`;
const password = "a-long-enough-password";

test.describe("signed-in journey", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL");
  test.describe.configure({ mode: "serial" });

  test.afterAll(async () => {
    if (!DATABASE_URL) return;
    const prisma = new PrismaClient();
    try {
      const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (user) await prisma.user.delete({ where: { id: user.id } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("sign up, analyze, watchlist, backtest", async ({ page }) => {
    // Four features end to end, two of which hit the exchange and one of which
    // replays hundreds of bars — comfortably past the default per-test budget.
    test.setTimeout(180_000);

    // --- sign up ---------------------------------------------------------
    await page.goto("/register");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(email)).toBeVisible();

    // --- analyze ---------------------------------------------------------
    await page.goto("/market-analysis?pair=BTCUSDT&tf=H4");
    const analyze = page.getByRole("button", { name: /Analyze Market/ });
    await expect(analyze).toBeEnabled({ timeout: 30_000 });
    await analyze.click();

    await expect(
      page.getByText(/Potential setup|Wait for confirmation|High risk|Avoid for now/).first(),
    ).toBeVisible({ timeout: 30_000 });

    // --- watchlist -------------------------------------------------------
    const watch = page.getByRole("button", { name: "Add to watchlist" });
    await expect(watch).toBeVisible();
    await watch.click();
    await expect(page.getByRole("button", { name: "Remove from watchlist" })).toBeVisible();

    await page.goto("/watchlist");
    await expect(page.getByText("BTC/USDT")).toBeVisible({ timeout: 30_000 });

    // --- the analysis was recorded ---------------------------------------
    await page.goto("/");
    await expect(page.getByText("Recent analyses")).toBeVisible({ timeout: 30_000 });

    // --- backtest --------------------------------------------------------
    await page.goto("/backtest");

    // A range wider than the candle ceiling is still refused with a usable
    // message rather than a timeout or a truncated result. Phase G paginates
    // history, so that ceiling moved from 740 evaluated candles to tens of
    // thousands — six months of 4h candles now runs rather than being
    // rejected. Reaching the limit takes a much finer timeframe.
    await page.selectOption("#tf", "M1");
    await page.getByLabel("From").fill("2025-01-01");
    await page.getByLabel("To").fill("2025-06-30");
    await page.getByRole("button", { name: /Run backtest/ }).click();
    await expect(page.getByText(/needs about \d+ candles to evaluate/i)).toBeVisible({
      timeout: 30_000,
    });

    // ~120 days of 4h candles is comfortably inside it.
    await page.selectOption("#tf", "H4");
    await page.getByLabel("To").fill("2025-05-01");
    await page.getByRole("button", { name: /Run backtest/ }).click();

    // --- the API contract itself ------------------------------------------
    //
    // `page.request` carries the session cookie, so unlike the anonymous smoke
    // test these reach schema validation instead of stopping at the auth guard.
    // That is what makes them a test of the contract rather than of the ordering.

    // The pre-Phase-G singular shape is gone, and `.strict()` rejects it.
    const stale = await page.request.post("/api/backtest/run", {
      data: {
        tradingPairId: "00000000-0000-4000-8000-000000000000",
        timeframe: "H4",
        startDate: "2025-01-01",
        endDate: "2025-03-01",
      },
    });
    expect(stale.status()).toBe(400);
    expect(await stale.text()).toMatch(/tradingPairIds/i);

    // The current plural shape parses, and the request then reaches the range
    // check beyond it — which is only possible if the body validated.
    const current = await page.request.post("/api/backtest/run", {
      data: {
        tradingPairIds: ["00000000-0000-4000-8000-000000000000"],
        timeframes: ["M1"],
        startDate: "2025-01-01",
        endDate: "2025-06-30",
      },
    });
    expect(current.status()).toBe(400);
    expect(await current.text()).toMatch(/needs about \d+ candles to evaluate/i);

    // Either a report or an honest "no setups" — both are valid outcomes, and
    // an engine that passes on most conditions will often produce the latter.
    await expect(
      page.getByTestId("bt-setups").or(page.getByText(/No setups triggered/)),
    ).toBeVisible({ timeout: 60_000 });
  });

  test("settings persist across a reload", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });

    await page.goto("/settings");
    await page.getByLabel("Default risk per trade (%)").fill("2.5");
    await page.getByRole("button", { name: /Save settings/ }).click();
    await expect(page.getByText("Settings saved.")).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByLabel("Default risk per trade (%)")).toHaveValue("2.5");
  });
});
