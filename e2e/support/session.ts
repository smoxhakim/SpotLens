import { expect, type Page } from "@playwright/test";

/**
 * Signs in through Auth.js's own credentials endpoint.
 *
 * The same provider, the same callback and the same session cookie the form
 * produces — `page.request` shares the browser context's cookie jar, so every
 * guard afterwards sees exactly what it would see for a person who typed it.
 * This is the application's real credentials flow, not a fabricated session: a
 * password that should be refused is still refused here.
 *
 * What it does not depend on is the login form having hydrated. Under a
 * parallel suite against a dev server that compiles on demand, a submit can
 * land before React owns the inputs, and the test then fails at the login page
 * describing nothing about the behaviour it was written to check. Use this
 * wherever signing in is the precondition; drive the form where signing in is
 * the subject, as `journey.spec.ts` does for registration.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  const csrf = await page.request.get("/api/auth/csrf");
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };

  const response = await page.request.post("/api/auth/callback/credentials", {
    form: { email, password, csrfToken, callbackUrl: "/" },
    maxRedirects: 0,
  });

  // Auth.js answers a good credential with a redirect and a bad one with a
  // redirect to /login?error=. Asserting here means a broken session fails on
  // the sign-in rather than fifty lines later on a missing heading.
  expect(response.status(), "sign-in did not redirect").toBe(302);
  expect(response.headers()["location"] ?? "", `sign-in was rejected for ${email}`).not.toContain(
    "error=",
  );

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({ timeout: 30_000 });
}
