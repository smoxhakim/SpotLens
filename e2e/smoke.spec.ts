import { expect, test } from "@playwright/test";

/**
 * Phase 1 smoke test: load the app, pick a pair, see a chart.
 * Hits the real provider through the app's own API routes.
 */
test("dashboard lists curated markets", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: /BTC\/USDT/ }).first()).toBeVisible();

  // The curated promise is visible on the surface, not buried in a policy page.
  await expect(page.getByText(/no futures, margin, or leverage/i).first()).toBeVisible();
});

test("opening a market renders a live candlestick chart", async ({ page }) => {
  await page.goto("/market-analysis?pair=BTCUSDT&tf=H1");

  await expect(page.getByRole("heading", { name: "BTC/USDT" })).toBeVisible();

  const chart = page.getByTestId("candlestick-chart");
  await expect(chart).toBeVisible({ timeout: 30_000 });
  // Lightweight Charts renders into canvases; their presence means data drew.
  await expect(chart.locator("canvas").first()).toBeVisible();

  // A real price replaced the placeholder.
  await expect(page.getByTestId("last-price")).toHaveText(/\d/, { timeout: 30_000 });
});

test("switching pair and timeframe updates the workspace", async ({ page }) => {
  await page.goto("/market-analysis?pair=BTCUSDT&tf=H1");
  await expect(page.getByRole("heading", { name: "BTC/USDT" })).toBeVisible();

  await page.getByRole("button", { name: "Select trading pair" }).click();
  await page.getByRole("textbox", { name: "Search assets" }).fill("ethereum");
  await page.getByRole("option", { name: /ETH\/USDT/ }).click();

  await expect(page.getByRole("heading", { name: "ETH/USDT" })).toBeVisible();
  await expect(page).toHaveURL(/pair=ETHUSDT/);

  await page.getByRole("button", { name: "4h", exact: true }).click();
  await expect(page).toHaveURL(/tf=H4/);
});

test("the analysis disclaimer is present on every page", async ({ page }) => {
  for (const path of ["/", "/market-analysis", "/learn"]) {
    await page.goto(path);
    await expect(
      page.getByText(/This analysis is educational and informational only/).first(),
    ).toBeVisible();
  }
});

test("health endpoint responds", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  expect((await res.json()).status).toBe("ok");
});

test("the market read panel explains its verdict", async ({ page }) => {
  await page.goto("/market-analysis?pair=BTCUSDT&tf=H4");

  const panel = page.getByText("Market Read");
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // A trend verdict is shown, and the reasoning is one click away.
  await expect(page.getByText(/^(Bullish|Bearish|Sideways)$/).first()).toBeVisible({
    timeout: 30_000,
  });

  const why = page.getByRole("button", { name: "Why?" }).first();
  await expect(why).toBeVisible();
  await why.click();
  await expect(page.getByText(/moving averages|swing|structure/i).first()).toBeVisible();
});

test("chart overlays can be toggled", async ({ page }) => {
  await page.goto("/market-analysis?pair=BTCUSDT&tf=H4");

  const toggle = page.getByRole("button", { name: "EMA 200" });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("Analyze Market returns a full setup with reasoning", async ({ page }) => {
  await page.goto("/market-analysis?pair=BTCUSDT&tf=H4");

  const analyze = page.getByRole("button", { name: /Analyze Market/ });
  await expect(analyze).toBeEnabled({ timeout: 30_000 });
  await analyze.click();

  // Every run ends on one of the four statuses — never a bare "buy".
  await expect(
    page.getByText(/Potential setup|Wait for confirmation|High risk|Avoid for now/).first(),
  ).toBeVisible({ timeout: 30_000 });

  // The disclaimer travels with the result.
  await expect(
    page.getByText(/This analysis is educational and informational only/).first(),
  ).toBeVisible();

  // No page in this product may tell the user to buy.
  await expect(page.getByText(/^BUY NOW$/i)).toHaveCount(0);
});

test("the analysis API validates its input", async ({ request }) => {
  const bad = await request.post("/api/analysis/run", { data: { tradingPairId: "nope" } });
  expect(bad.status()).toBe(400);

  const missing = await request.post("/api/analysis/run", {
    data: { tradingPairId: "00000000-0000-4000-8000-000000000000", timeframe: "H1" },
  });
  expect(missing.status()).toBe(404);
});

test("the risk calculator sizes a position from the stop distance", async ({ page }) => {
  await page.goto("/risk-calculator");

  await page.getByLabel("Portfolio balance").fill("10000");
  await page.getByLabel("Risk per trade (%)").fill("1");
  await page.getByLabel("Entry price").fill("100");
  await page.getByLabel("Stop loss price").fill("90");

  // Risking 1% of 10,000 = 100, with a 10-wide stop, is exactly 10 units.
  await expect(page.getByTestId("position-size")).toContainText("10");
  await expect(page.getByTestId("risk-amount")).toContainText("100");
  await expect(page.getByTestId("position-value")).toContainText("1,000");
  await expect(page.getByText(/never risk money that you cannot afford to lose/i)).toBeVisible();
});

test("the risk calculator refuses a stop above the entry", async ({ page }) => {
  await page.goto("/risk-calculator");

  await page.getByLabel("Portfolio balance").fill("10000");
  await page.getByLabel("Risk per trade (%)").fill("1");
  await page.getByLabel("Entry price").fill("100");
  await page.getByLabel("Stop loss price").fill("110");

  await expect(page.getByText(/stop loss must be below the entry price/i)).toBeVisible();
});

test("user-scoped pages ask for sign-in rather than failing", async ({ page }) => {
  for (const path of ["/watchlist", "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible({
      timeout: 15_000,
    });
  }
});

test("user-scoped API routes reject anonymous callers", async ({ request }) => {
  expect((await request.get("/api/watchlist")).status()).toBe(401);
  expect((await request.get("/api/user/me")).status()).toBe(401);
  expect((await request.get("/api/analysis/history")).status()).toBe(401);
});

test("position size API validates and computes", async ({ request }) => {
  const ok = await request.post("/api/risk/position-size", {
    data: { balance: 10000, riskPercent: 1, entry: 100, stopLoss: 90 },
  });
  expect(ok.ok()).toBeTruthy();
  expect((await ok.json()).positionSize).toBe(10);

  const bad = await request.post("/api/risk/position-size", {
    data: { balance: 10000, riskPercent: 1, entry: 100, stopLoss: 110 },
  });
  expect(bad.status()).toBe(400);
});
