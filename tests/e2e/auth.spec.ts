import { expect, test, type BrowserContext } from "@playwright/test";
import { E2E_PASSWORD, gotoApp, login, requireAppServer } from "./fixture.js";

/**
 * Auth: the doorway. Every assertion here is a security claim the product makes
 * in docs/architecture/mobile-client.md and docs/operations/iphone-setup.md.
 */

const COOKIE_NAME = "__Host-caw_session";
/**
 * WebKit refuses `__Host-` over plain HTTP (the prefix REQUIRES `Secure`, and WebKit
 * does not exempt loopback), so a run that includes the WebKit project starts the
 * harness server in its documented, loopback-only insecure-cookie mode and the session
 * cookie is `caw_session` without `Secure`. A Chromium-only run gets the production
 * `__Host-caw_session`.
 *
 * The spec does not guess which mode it is in — guessing is how a cookie assertion
 * passes for the wrong reason. It finds whichever of the two names the browser
 * actually stored, and asserts the invariants that hold for it:
 * `HttpOnly`, `SameSite=Lax`, path `/`, a real token, and **`Secure` exactly when the
 * name is the `__Host-` one** — the only combination a browser will honour.
 */
const DEV_COOKIE = "caw_session";
type StoredCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
const storedSession = (cookies: StoredCookie[]): StoredCookie | undefined =>
  cookies.find((cookie) => cookie.name === COOKIE_NAME) ?? cookies.find((cookie) => cookie.name === DEV_COOKIE);

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("wrong password shows the specific error and does not let us in", async ({ page }) => {
  await gotoApp(page);
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  // The server answers 401 with "Invalid password"; the UI must surface that
  // reason rather than a generic failure.
  await expect(alert).toContainText(/invalid password/i);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Coding Agent Web" })).toBeVisible();
});

test("correct password lands on the projects screen", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("button", { name: "+ New Project" })).toBeVisible();
});

test("session cookie is HttpOnly, SameSite=Lax, path /, and Secure exactly when its name requires it", async ({ page, context }) => {
  await login(page);

  const cookies = await context.cookies();
  const session = storedSession(cookies);
  expect(session, `expected a session cookie after login; stored: ${cookies.map((cookie) => cookie.name).join(", ") || "(none)"}`).toBeDefined();
  expect(session!.httpOnly).toBe(true);
  /**
   * The security claim comes from the RUN'S CONFIGURATION, not from the cookie observed.
   *
   * The previous form was `secure === (name === COOKIE_NAME)`, which derives the rule
   * from the fact it is testing: in a Chromium-only run the name is always
   * `__Host-caw_session`, so it happened to be equivalent — but a regression that
   * silently fell back to `caw_session` + `secure: false` (which is precisely what the
   * insecure-cookie dev path does) would produce a cookie that satisfies that identity
   * and pass. What the run is configured to do is knowable independently:
   * `playwright.config.ts` sets `CAW_INSECURE_COOKIES=1` for the web server exactly when
   * the WebKit project is in the run, and the server picks the cookie name from it
   * (`apps/server/src/auth.ts:50`).
   */
  const configuredInsecure = process.env.CAW_INSECURE_COOKIES === "1";
  if (configuredInsecure) {
    // Loopback dev mode: the cookie must be named honestly and must NOT claim Secure,
    // because `Secure` on a plain-HTTP loopback origin is what makes WebKit discard it.
    expect(session!.name, "an insecure-cookie run must use the dev cookie name").toBe(DEV_COOKIE);
    expect(session!.secure, "the loopback dev cookie must not claim Secure").toBe(false);
  } else {
    // Production mode: `__Host-` is only honoured when Secure + Path=/ + no Domain, so
    // both halves are required, not either.
    expect(session!.name, "a production run must use the __Host- cookie").toBe(COOKIE_NAME);
    expect(session!.secure, "the production cookie must be Secure").toBe(true);
  }
  expect(session!.sameSite).toBe("Lax");
  expect(session!.path).toBe("/");
  expect(session!.value.length).toBeGreaterThan(20);
});

test("logout clears the cookie and protected API calls return 401", async ({ page, context }) => {
  await login(page);

  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  // Back to the login screen...
  await expect(page.getByRole("heading", { name: "Coding Agent Web" })).toBeVisible();

  // ...the cookie is gone or emptied by the clear-cookie response...
  const session = storedSession(await context.cookies());
  expect(session === undefined || session.value === "").toBe(true);

  // ...and the API no longer accepts us. Fetched from inside the page so the
  // browser, not the test runner, decides which cookies are sent.
  const status = await page.evaluate(async () => (await fetch("/api/projects", { credentials: "include" })).status);
  expect(status).toBe(401);

  // A fresh visit cannot get back in without the password either.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Coding Agent Web" })).toBeVisible();
});
