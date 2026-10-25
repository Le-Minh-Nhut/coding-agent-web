import { expect, test } from "@playwright/test";
import { E2E_PASSWORD, gotoApp, login, requireAppServer } from "./fixture.js";

/**
 * Auth: the doorway. Every assertion here is a security claim the product makes
 * in docs/architecture/mobile-client.md and docs/operations/iphone-setup.md.
 */

const COOKIE_NAME = "__Host-caw_session";

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

test("session cookie is __Host-caw_session, HttpOnly, Secure, SameSite=Lax", async ({ page, context }) => {
  await login(page);

  const session = (await context.cookies()).find((cookie) => cookie.name === COOKIE_NAME);
  expect(session, `expected a ${COOKIE_NAME} cookie after login`).toBeDefined();
  expect(session!.httpOnly).toBe(true);
  expect(session!.secure).toBe(true);
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
  const session = (await context.cookies()).find((cookie) => cookie.name === COOKIE_NAME);
  expect(session === undefined || session.value === "").toBe(true);

  // ...and the API no longer accepts us. Fetched from inside the page so the
  // browser, not the test runner, decides which cookies are sent.
  const status = await page.evaluate(async () => (await fetch("/api/projects", { credentials: "include" })).status);
  expect(status).toBe(401);

  // A fresh visit cannot get back in without the password either.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Coding Agent Web" })).toBeVisible();
});
