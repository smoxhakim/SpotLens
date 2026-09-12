import { defineConfig, devices } from "@playwright/test";

// Not 3000: that port is commonly already taken by another local project, and
// reusing a stranger's server silently tests the wrong app.
const PORT = Number(process.env.PORT ?? 3100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: process.env.CI ? `npm run start -- -p ${PORT}` : `npm run dev -- -p ${PORT}`,
    url: baseURL,
    // Derived rather than documented. Auth.js only trusts the host named in
    // NEXTAUTH_URL, and a production build refuses one it was not told about —
    // so a suite on 3100 against a `.env` pointing at 3000 renders "There is a
    // problem with the server configuration" on sign-in, and every spec that
    // signs in fails for a reason that looks nothing like the cause. These
    // follow the port the config already chose, so there is no second place to
    // keep in step. Only applied to a server Playwright starts: a reused one is
    // already running on the port its own environment names.
    env: {
      // The Coach answers with its deterministic reading for the suite, never
      // ChatGPT. A key in `.env` would otherwise make every run billable, slow
      // and dependent on a third party being up — and the review's wording
      // would change between runs, which no assertion could survive. Live
      // provider testing is done deliberately and by hand.
      OPENAI_API_KEY: "",
      NEXTAUTH_URL: baseURL,
      AUTH_URL: baseURL,
      AUTH_TRUST_HOST: "true",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
