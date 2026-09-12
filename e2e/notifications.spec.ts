import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

import { hashPassword } from "@/lib/auth/password";

import { signIn } from "./support/session";

/**
 * Notification settings end to end.
 *
 * What this is for: the preference switches are the only place a person can see
 * what SpotLens will and will not send them, and the audit found all three of
 * the interesting hints describing the opposite of what actually happens. A
 * page that lies about its own behaviour is worse than one with no copy at all,
 * so the wording is asserted here alongside the persistence.
 *
 * The Telegram connection flow is deliberately *not* driven: completing it
 * would mean this suite talking to Telegram's API and binding a real chat. What
 * is checked instead is the state a machine with no bot token reaches, which is
 * the one a fresh clone sees, and that no token ever reaches the page.
 */
const DATABASE_URL = process.env.DATABASE_URL;

const email = `e2e-notifications-${Date.now()}@spotlens.test`;
const password = "a-long-enough-password";

const prisma = new PrismaClient();

test.describe("notification settings", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL");
  test.describe.configure({ mode: "serial" });

  test.afterAll(async () => {
    try {
      // Every account this spec has ever created, so a run that fails partway
      // does not silt up the database one row at a time.
      await prisma.user.deleteMany({ where: { email: { startsWith: "e2e-notifications-" } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("describes what it sends, remembers a change, and leaks no secret", async ({ page }) => {
    test.setTimeout(120_000);

    // Written straight to the table rather than registered: signup is rate
    // limited to five an hour for the whole suite, and this spec needs a
    // session rather than a signup.
    await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
    });

    await signIn(page, email, password);
    await page.goto("/settings");

    // --- the defaults a new account actually gets -------------------------
    const potentialSetup = page.getByRole("checkbox", { name: /Potential setup/ });
    await expect(potentialSetup).toBeVisible({ timeout: 30_000 });

    // The rarest and most useful event, on by default since Phase K.
    await expect(potentialSetup).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /Structure signal/ })).not.toBeChecked();

    // --- the copy tells the truth about the channels ----------------------
    await expect(page.getByText(/Structure signal \(in-app only\)/)).toBeVisible();
    await expect(page.getByText(/Telegram receives a deliberate subset/)).toBeVisible();
    await expect(page.getByText(/shown here as 're-anchored' and never pushed/)).toBeVisible();

    // The event whose title changed: evidence, not a detection.
    await expect(page.getByRole("checkbox", { name: /Confirmation evidence/ })).toBeVisible();

    // --- a change survives a reload ---------------------------------------
    await page.getByRole("checkbox", { name: /Daily scanner summary/ }).click();
    await expect
      .poll(
        async () => {
          const row = await prisma.notificationPreference.findFirst({
            where: { user: { email } },
            select: { dailySummary: true },
          });
          return row?.dailySummary ?? null;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    await page.reload();
    await expect(page.getByRole("checkbox", { name: /Daily scanner summary/ })).toBeChecked({
      timeout: 30_000,
    });

    // --- Telegram, without ever binding a chat ----------------------------
    // Telegram cannot be switched on until a chat is actually bound, whether or
    // not a bot token is configured on this machine.
    // The accessible name is the label plus its hint, because the whole row is
    // one <label>, so this anchors on the start of it.
    await expect(page.getByRole("checkbox", { name: /^Telegram/ })).toBeDisabled();

    // --- nothing about the token reaches the browser ----------------------
    const html = await page.content();
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (token) expect(html).not.toContain(token);
    // The bot-token URL shape, in case a value ever arrives by another route.
    expect(html).not.toMatch(/bot\d{6,}:[A-Za-z0-9_-]{20,}/);
  });
});
