import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import bcrypt from "bcryptjs";

/**
 * Notification settings and the Telegram connection, end to end.
 *
 * Nothing here sends a Telegram message. What it proves is everything around
 * the send: that a preference survives a round trip, that the connection panel
 * is owner-scoped, that an unauthenticated caller is refused, that the panel's
 * own polling does not burn the connection code it is waiting on, and that the
 * page describes its own behaviour accurately.
 *
 * Real delivery is verified by hand against the live bot, because a test that
 * asserts a message arrived in someone's phone cannot run in CI.
 */
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * The accounts are written straight to the table rather than registered.
 *
 * Signup is limited to five an hour per address, deliberately, and it is a
 * limit the whole suite shares. A spec that spends two of them to reach a
 * settings panel makes every other spec flakier for no coverage in return —
 * registration already has its own test.
 */
async function account(prisma: PrismaClient, email: string, password: string) {
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash(password, 10) },
    select: { id: true },
  });
  return user.id;
}

const email = `e2e-notify-${Date.now()}@spotlens.test`;
const strangerEmail = `e2e-notify-stranger-${Date.now()}@spotlens.test`;
const password = "a-long-enough-password";

let userId = "";
let strangerId = "";

const prisma = new PrismaClient();

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });
}

test.describe("notification settings", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL");
  test.describe.configure({ mode: "serial" });

  test.afterAll(async () => {
    try {
      await prisma.user.deleteMany({ where: { email: { startsWith: "e2e-notify-" } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("refuses every Telegram route to a caller with no session", async ({ request }) => {
    for (const path of [
      "/api/notifications/telegram",
      "/api/notifications/telegram/connect",
      "/api/notifications/telegram/claim",
      "/api/notifications/telegram/test",
      "/api/notifications/preferences",
    ]) {
      const response =
        path === "/api/notifications/telegram" || path === "/api/notifications/preferences"
          ? await request.get(path)
          : await request.post(path);

      expect(response.status(), path).toBe(401);
    }
  });

  test("saves a preference and keeps the connection panel owner-scoped", async ({ page }) => {
    test.setTimeout(120_000);

    userId = await account(prisma, email, password);

    await signIn(page);

    // Somebody else's bound chat. If the panel ever read a connection by
    // anything other than the session's own user, this is the row that would
    // show up in it.
    strangerId = await account(prisma, strangerEmail, password);
    await prisma.telegramConnection.create({
      data: {
        userId: strangerId,
        chatId: "999999",
        chatLabel: "@stranger",
        connectedAt: new Date(),
      },
    });

    await page.goto("/settings");
    await expect(page.getByText("What to send")).toBeVisible();

    // --- the panel shows this account's state, not the stranger's ----------
    const status = await (await page.request.get("/api/notifications/telegram")).json();
    expect(status.telegram.connected).toBe(false);
    expect(status.telegram.chatLabel).toBeNull();
    expect(JSON.stringify(status)).not.toContain("999999");
    expect(JSON.stringify(status)).not.toContain("@stranger");

    // --- and refuses to send through a connection it does not own ----------
    const test1 = await (await page.request.post("/api/notifications/telegram/test")).json();
    expect(test1.ok).toBe(false);
    expect(test1.error).toMatch(/not connected/i);

    // --- a preference survives the round trip ------------------------------
    // Clicked rather than checked: the box is controlled by the server's copy
    // of the preferences, so it only flips once the write has come back — which
    // is the thing worth asserting anyway.
    //
    // It starts *on*. A potential setup is the rarest event the engine produces
    // and the only one that says every deterministic condition now holds, so it
    // is what a fresh account gets by default; the round trip here is therefore
    // off and back on rather than on and back off.
    const potentialSetup = page.getByRole("checkbox", { name: /Potential setup/i });
    await expect(potentialSetup).toBeChecked();
    await potentialSetup.click();

    await expect
      .poll(async () => {
        const row = await prisma.notificationPreference.findUnique({ where: { userId } });
        return row?.setupDetected ?? null;
      })
      .toBe(false);

    await expect(potentialSetup).not.toBeChecked();
    await potentialSetup.click();
    await expect
      .poll(async () => {
        const row = await prisma.notificationPreference.findUnique({ where: { userId } });
        return row?.setupDetected ?? null;
      })
      .toBe(true);

    // --- Telegram cannot be switched on before a chat is bound -------------
    await expect(page.getByRole("checkbox", { name: /^Telegram/ })).toBeDisabled();
  });

  test("polling for the code does not burn the code", async ({ page }) => {
    test.setTimeout(120_000);

    await signIn(page);

    const issued = await page.request.post("/api/notifications/telegram/connect");

    // Without a bot token there is no code to poll for, and the panel says so
    // rather than offering a button that cannot work.
    if (issued.status() === 503) {
      await page.goto("/settings");
      await expect(page.getByText(/No bot token is set on this machine/i)).toBeVisible();
      await expect(page.getByRole("button", { name: "Connect Telegram" })).toBeDisabled();
      return;
    }

    expect(issued.ok()).toBe(true);
    const before = await prisma.telegramConnection.findUnique({ where: { userId } });
    expect(before?.pendingCodeHash).toBeTruthy();

    async function poll(times: number) {
      for (let i = 0; i < times; i += 1) {
        const response = await page.request.post("/api/notifications/telegram/claim");
        // Twelve polls in a minute is what the panel does. The rate limit has
        // to survive that, or the flow dies on a 429 with nothing on screen.
        expect(response.status(), `poll ${i}`).not.toBe(429);
        const { result } = await response.json();
        expect(["PENDING", "UNAVAILABLE"], `poll ${i}`).toContain(result.status);
      }
      return (await prisma.telegramConnection.findUnique({ where: { userId } }))!;
    }

    // Not "attempts stay at zero": one bot serves every account, so a message
    // another account sent it is a code-shaped string that does not match this
    // one, and counting it is the intended behaviour. What must never happen is
    // the count growing with the polling — which is what burned the code in
    // thirty seconds.
    const halfway = await poll(6);
    const end = await poll(6);

    expect(end.claimAttempts).toBe(halfway.claimAttempts);
    expect(end.claimAttempts).toBeLessThan(10);
    expect(end.pendingCodeHash).toBe(before?.pendingCodeHash);
  });

  /**
   * The switches are the only place a person can see what will and will not
   * reach their phone, and an earlier version of this copy described the rarest
   * event as a firehose and the noisiest as routine. A page that lies about its
   * own behaviour is worse than one carrying no copy at all, so the wording is
   * asserted rather than left to drift.
   */
  test("describes what it sends, and leaks no secret", async ({ page }) => {
    test.setTimeout(120_000);

    await signIn(page);
    await page.goto("/settings");
    await expect(page.getByText("What to send")).toBeVisible({ timeout: 30_000 });

    // "Evidence", not "detected": reaching that state means the evidence was
    // found *and* the analysis was not promoted, and a label that says only the
    // first half reads as an approval the engine never gave.
    await expect(page.getByRole("checkbox", { name: /Confirmation evidence/ })).toBeVisible();

    // Marked in-app only, because the routing rules never push it — a switch
    // promising a message that cannot arrive is worse than no switch.
    await expect(page.getByText(/Structure signal \(in-app only\)/)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Structure signal/ })).not.toBeChecked();

    // --- the copy tells the truth about the two channels -------------------
    await expect(page.getByText(/Telegram receives a deliberate subset/)).toBeVisible();
    await expect(page.getByText(/shown here as 're-anchored' and never pushed/)).toBeVisible();

    // --- nothing about the token reaches the browser -----------------------
    const html = await page.content();
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (token) expect(html).not.toContain(token);
    // The bot-token URL shape, in case a value ever arrives by another route.
    expect(html).not.toMatch(/bot\d{6,}:[A-Za-z0-9_-]{20,}/);
  });
});
