import { expect, test } from "@playwright/test";
import {
  assertNoUnexpectedAppErrors,
  collectedAppErrors,
  gotoApp,
  login,
  requireAppServer,
  unexpectedAppErrors,
} from "./fixture.js";

/**
 * Self-check for the error collectors in `fixture.ts`.
 *
 * The specs that call `assertNoUnexpectedAppErrors` are only meaningful if the
 * collectors actually see what the page emits, and if the injected-fault filter
 * is narrow. This drives both ends against a real page: one deliberate fault of
 * each kind, and one deliberate mock that must not be reported.
 */

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("collectors report page errors and console errors, and filter injected faults", async ({
  page,
}) => {
  await login(page);

  // Nothing unexpected yet: a green app on a clean load is the baseline.
  await assertNoUnexpectedAppErrors(page);

  // A router the page never calls; its 500 is what an injected-fault spec looks
  // like, and it must not be reported.
  await page.route("**/api/e2e-injected-failure", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: '{"ok":false}',
    }),
  );
  await page.evaluate(async () => {
    await fetch("/api/e2e-injected-failure").catch(() => {});
  });
  await expect
    .poll(async () => (await collectedAppErrors(page)).consoleErrors.length)
    .toBeGreaterThan(0);
  expect(unexpectedAppErrors(page)).toEqual([]);

  // A real uncaught exception and a real console.error, neither injected by a
  // route: both must surface.
  await page.evaluate(() => {
    console.error("e2e-capture-console-error");
    setTimeout(() => {
      throw new Error("e2e-capture-page-error");
    }, 0);
  });
  await expect
    .poll(() => unexpectedAppErrors(page).length)
    .toBeGreaterThanOrEqual(2);
  const reported = unexpectedAppErrors(page).join("\n");
  expect(reported).toContain("e2e-capture-page-error");
  expect(reported).toContain("e2e-capture-console-error");
});

test("an app that renders cleanly passes the assertion", async ({ page }) => {
  await gotoApp(page);
  await page.getByLabel("Password").fill("wrong-password-on-purpose");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The failed sign-in is a handled 401 the app renders; it is an error status,
  // so it is filtered, and the login screen must still be fault-free.
  await expect(page.getByRole("alert")).toBeVisible();
  await assertNoUnexpectedAppErrors(page);
});
