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
