import { expect, test, type Page } from "@playwright/test";
import { assertInsideHarnessTemp, harnessFixture, login, openFolderRow, readBrowse, requireAppServer } from "./fixture.js";

/**
 * The folder browser is the only place a user-supplied path reaches the server,
 * so a refusal must be a readable sentence — never a blank screen, a spinner, or
 * a stack trace. The error copy asserted here is the product's own mapping in
 * apps/web/src/components/FolderBrowser.tsx.
 *
 * The refusals below are reached for real: the allowed root is at
 * `<tmp>/caw-e2e-*\/roots`, so its ancestor directory (`tmp`) is *outside* the
 * allowlist. Clicking that breadcrumb is exactly the mistake this UI must survive.
 */

async function openBrowser(page: Page) {
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("a path outside the allowed roots is refused in the API and explained in the UI", async ({ page }) => {
  const fixture = harnessFixture();
  assertInsideHarnessTemp(fixture.rootsDir);
  await login(page);

  // API: the policy refuses, with the documented code rather than a 500.
  const refused = await page.request.get("/api/browse?path=/etc");
  expect(refused.status(), "browsing outside the allowlist must be refused").toBe(403);
  const body = (await refused.json()) as { ok?: boolean; error?: { code?: string; message?: string } };
  expect(body.ok).toBe(false);
  expect(body.error?.code).toBe("path_forbidden");
  expect(body.error?.message ?? "").not.toMatch(/at Object\.|\/home\/|Error:/);

  // UI: click the ancestor breadcrumb segment, which is outside the roots.
  await openBrowser(page);
  const ancestor = fixture.rootsDir.split("/").filter(Boolean)[0]!;
  await page.getByRole("button", { name: ancestor, exact: true }).click();

  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/access forbidden/i);
  await expect(alert).toContainText(/outside allowed workspace/i);

  // Not a blank screen and not a stack trace: the modal still shows its own
  // chrome, the listing it already had, and a way out.
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Roots", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.getByText(/Published by Playwright|at Object\.|Traceback \(most recent call last\)/)).toHaveCount(0);
});

test("a file is refused because it is not a directory", async ({ page }) => {
  const fixture = harnessFixture();
  await login(page);

  const listing = await readBrowse(page);
  const file = listing.entries.find((entry) => entry.name === "readme.txt");
  expect(file, "the harness fixture file must be listed by the API").toBeDefined();
  expect(file!.isDirectory).toBe(false);

  // API: opening a file as a workspace is refused, not silently accepted.
  const refused = await page.request.get(`/api/browse?path=${encodeURIComponent(file!.path)}`);
  expect(refused.status()).toBe(400);
  const body = (await refused.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe("not_a_directory");

  // UI: files are never offered as folders, so there is no way to descend into one.
  await openBrowser(page);
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await expect(page.getByText("readme.txt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use this folder" })).toBeEnabled();

  // And the directory the modal would hand back is still a directory.
  assertInsideHarnessTemp(listing.path);
  expect(listing.path).toBe(fixture.rootsDir);
});

test("breadcrumbs navigate back up to the configured roots", async ({ page }) => {
  await login(page);
  await openBrowser(page);

  await expect(page.getByText(/p-alpha/).first()).toBeVisible();
  await openFolderRow(page, "p-alpha");

  // Descending adds a breadcrumb for the directory we are inside.
  const alphaCrumb = page.getByRole("button", { name: "p-alpha", exact: true });
  await expect(alphaCrumb).toBeVisible();
  await expect(page.getByText(/No subdirectories/)).toBeVisible();

  // ".. (Up)" walks to the parent, which is still inside the roots.
  await page.getByText(/\.\. \(Up\)/).click();
  await expect(alphaCrumb).toBeHidden();
  await expect(page.getByText(/p-alpha/).first()).toBeVisible();

  // Descend again, then jump straight to the roots view with the breadcrumb.
  await openFolderRow(page, "p-alpha");
  await expect(alphaCrumb).toBeVisible();
  await page.getByRole("button", { name: "Roots", exact: true }).click();
  await expect(alphaCrumb).toBeHidden();

  // The roots view is the configured allowed root, and it lists the fixture dirs.
  const listing = await readBrowse(page);
  expect(listing.roots.length).toBeGreaterThan(0);
  expect(listing.entries.some((entry) => entry.name === "p-alpha" && entry.isDirectory)).toBe(true);
  assertInsideHarnessTemp(listing.path);
});
