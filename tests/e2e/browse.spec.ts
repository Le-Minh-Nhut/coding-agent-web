import { expect, test, type Page } from "@playwright/test";
import { assertInsideHarnessTemp, harnessFixture, login, openFolderRow, projectByLabel, readBrowse, requireAppServer } from "./fixture.js";
const RUN = Date.now().toString(36).slice(-5);

/**
 * The folder browser exposes only configured roots and descendants, while the
 * API independently refuses arbitrary paths outside that allowlist.
 */

async function openBrowser(page: Page) {
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("API refuses paths outside the configured roots and the UI hides their breadcrumbs", async ({ page }) => {
  const fixture = harnessFixture();
  await login(page);

  const refused = await page.request.get("/api/browse?path=/etc");
  expect(refused.status(), "browsing outside the allowlist must be refused").toBe(403);
  const body = (await refused.json()) as { ok?: boolean; error?: { code?: string; message?: string } };
  expect(body.ok).toBe(false);
  expect(body.error?.code).toBe("path_forbidden");
  expect(body.error?.message ?? "").not.toContain("Error:");

  await openBrowser(page);
  const ancestor = fixture.rootsDir.split("/").filter(Boolean)[0]!;
  await expect(page.getByRole("button", { name: ancestor, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Roots", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
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

test("a newly created folder is selected and can be used for a project", async ({ page }) => {
  const fixture = harnessFixture();
  const folderName = `created-from-phone-${RUN}`;
  const projectLabel = `Created Folder Project ${RUN}`;
  await login(page);
  await openBrowser(page);
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await page.getByLabel(/New folder in/).fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();

  const createdPath = `${fixture.rootsDir}/${folderName}`;
  await expect(page.getByText("Selected")).toBeVisible();
  const created = await page.request.get(`/api/browse?path=${encodeURIComponent(fixture.rootsDir)}`);
  expect(created.status()).toBe(200);
  expect((await created.json()).data.entries.some((entry: { name: string }) => entry.name === folderName)).toBe(true);

  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByPlaceholder("Display label (e.g. My Backend)").fill(projectLabel);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectLabel, exact: true })).toBeVisible();
  const project = await projectByLabel(page, projectLabel);
  expect(project.path).toBe(createdPath);
  assertInsideHarnessTemp(project.path);
});

test("folder browser can switch to each configured root", async ({ page }) => {
  const fixture = harnessFixture();
  await login(page);
  await openBrowser(page);
  const listing = await readBrowse(page);
  expect(listing.roots).toEqual([fixture.rootsDir, `${fixture.tempRoot}/roots-secondary`]);
  for (const root of listing.roots) {
    await page.getByRole("button", { name: "Roots", exact: true }).click();
    await page.getByRole("button", { name: root, exact: true }).click();
    const response = await page.request.get(`/api/browse?path=${encodeURIComponent(root)}`);
    expect(response.status()).toBe(200);
    expect((await response.json()).data.path).toBe(root);
    const rootName = root.split("/").filter(Boolean).pop()!;
    await expect(page.getByRole("button", { name: rootName, exact: true })).toBeVisible();
  }
});
