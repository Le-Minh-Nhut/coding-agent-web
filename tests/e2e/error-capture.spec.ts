import { expect, test } from "@playwright/test";
import {
  assertNoUnexpectedAppErrors,
  collectedAppErrors,
  declareInjectedFault,
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
 * forgives exactly what a spec declared and nothing more. This drives both ends
 * against a real page: a declared fault that must be forgiven, an undeclared
 * error status that must not, and the two collector kinds no route can explain.
 */

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("collectors report page errors and console errors, and forgive only declared faults", async ({
  page,
}) => {
  await login(page);

  // Nothing unexpected yet: a green app on a clean load is the baseline.
  await assertNoUnexpectedAppErrors(page);

  // A DECLARED 500: the spec injected this router and declared the exact URL+status,
  // so the browser's console error for it must not be reported.
  declareInjectedFault(page, { urlPattern: /\/api\/e2e-injected-failure$/, status: 500 });
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

  // An UNDECLARED 500 on a different URL: this is the case the old blanket filter
  // hid. It must be reported, status and URL notwithstanding.
  await page.route("**/api/e2e-undeclared-failure", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: '{"ok":false}' }),
  );
  await page.evaluate(async () => {
    await fetch("/api/e2e-undeclared-failure").catch(() => {});
  });
  await expect
    .poll(() => unexpectedAppErrors(page).length)
    .toBeGreaterThanOrEqual(1);
  expect(unexpectedAppErrors(page).join("\n")).toContain("status of 500");

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
    .toBeGreaterThanOrEqual(3);
  const reported = unexpectedAppErrors(page).join("\n");
  expect(reported).toContain("e2e-capture-page-error");
  expect(reported).toContain("e2e-capture-console-error");
});

test("a wrong-password sign-in is a declared 401, and a clean app passes the assertion", async ({
  page,
}) => {
  await gotoApp(page);
  // The failed sign-in is a deliberate 401 the app renders; declare it at the point
  // of use so the collector stays strict for every other request.
  declareInjectedFault(page, { urlPattern: /\/api\/auth\/login$/, status: 401 });
  await page.getByLabel("Password").fill("wrong-password-on-purpose");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await assertNoUnexpectedAppErrors(page);
});
