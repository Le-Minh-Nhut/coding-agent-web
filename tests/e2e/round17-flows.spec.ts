import { expect, test, type Page } from "@playwright/test";
import { existsSync, statSync } from "node:fs";
import {
  assertInsideHarnessTemp,
  assertNoUnexpectedAppErrors,
  declareInjectedFault,
  harnessFixture,
  installMockCollabHost,
  login,
  openFolderRow,
  openSeededConversation,
  projectByLabel,
  readProjects,
  requireAppServer,
  welcomeFrame,
} from "./fixture.js";

/**
 * Round-17 browser flows: the three fixes whose defect only shows with a real
 * page and a real server.
 *
 *  - sign-out must not present the user as signed out while the session still
 *    authenticates (SettingsView probes /me after a failed revoke);
 *  - a refused prompt must survive a newer draft behind an explicit Recover
 *    strip instead of being silently dropped;
 *  - deleting a project must ask the server, and the server's refusal must be
 *    shown rather than swallowed.
 *
 * No agent is launched: the conversation screens are driven against the mock
 * Collab host, and the delete that must succeed uses a project with no
 * conversations at all.
 */

const COMPOSER = /Send instructions to agent|Turn in flight/;
const REFUSAL = "prompting is unavailable until the host finishes starting up";

/** Bunched so a failure names the viewport it happened at: the three phone widths the ticket names, plus a desktop. */
const VIEWPORTS = [
  { name: "mobile 375x812", size: { width: 375, height: 812 } },
  { name: "mobile 390x844", size: { width: 390, height: 844 } },
  { name: "mobile 430x932", size: { width: 430, height: 932 } },
  { name: "desktop 1280x800", size: { width: 1280, height: 800 } },
] as const;

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

async function openSettings(page: Page): Promise<void> {
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();
}

for (const viewport of VIEWPORTS) {
  test(`a failed sign-out keeps the session and offers Retry (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize(viewport.size);
    await login(page);
    await openSettings(page);

    // The revoke never reaches the server: the browser aborts the request. The
    // `aborted` code (not `failed`) is what the fixture's collector forgives as a
    // harness-cancelled request rather than an app defect.
    await page.route("**/api/auth/logout", (route) => route.abort("aborted"));
    await page.getByRole("button", { name: "Sign out" }).click();

    // A failed revoke is not a sign-out: the error is stated and the user stays in.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry sign out" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Coding Agent Web" })).toBeHidden();

    // Retry with the network restored confirms the revoke and ends the session.
    await page.unroute("**/api/auth/logout");
    await page.getByRole("button", { name: "Retry sign out" }).click();
    await expect(page.getByRole("heading", { name: "Coding Agent Web" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeHidden();

    await assertNoUnexpectedAppErrors(page);
  });

  test(`a refused prompt keeps the newer draft and Recover restores it (${viewport.name})`, async ({ page }) => {
    const fixture = harnessFixture();
    await page.setViewportSize(viewport.size);
    const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
    await openSeededConversation(page);
    await host.send(welcomeFrame(false));

    const composer = page.getByRole("textbox", { name: COMPOSER });
    await expect(composer).toBeEnabled();
    await composer.fill("PROMPT_B_MUST_BE_RECOVERABLE");
    await page.getByRole("button", { name: "Send" }).click();
    await expect.poll(() => host.prompts.length, "the prompt must reach the host").toBe(1);

    // The user keeps typing before the host's refusal lands.
    await composer.fill("DRAFT_C_STILL_TYPING");

    await host.send({ t: "error", message: REFUSAL });

    // Neither draft is destroyed: the newer draft stays in the composer and the
    // refused text lives behind an explicit strip.
    const strip = page.locator(".refused-prompt");
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("PROMPT_B_MUST_BE_RECOVERABLE");
    await expect(composer).toHaveValue("DRAFT_C_STILL_TYPING");

    // Recover is the only path back, and it is explicit.
    await strip.getByRole("button", { name: "Recover" }).click();
    await expect(composer).toHaveValue("PROMPT_B_MUST_BE_RECOVERABLE");
    await expect(strip).toBeHidden();

    await assertNoUnexpectedAppErrors(page);
  });
}

test("a rename whose intent changes while a write is pending settles on the last label", async ({ page }) => {
  const RUN = Date.now().toString(36).slice(-5);
  const folderName = `r17-rename-${RUN}`;
  const createdLabel = `Round17 Rename ${RUN}`;
  const firstIntent = `${createdLabel} First`;
  const finalIntent = `${createdLabel} Final`;
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await page.getByLabel(/New folder in/).fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByPlaceholder("Display label (e.g. My Backend)").fill(createdLabel);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: createdLabel, exact: true })).toBeVisible();

  const project = await projectByLabel(page, createdLabel);
  assertInsideHarnessTemp(project.path);

  // The first PATCH is held open until the user has saved a second label: that
  // pending window *is* the race. Nothing is mocked — both writes still reach the
  // real server through `continue()`, so the end state is the server's own.
  // (Hand-rolled gate: this repo targets Node 20, which lacks Promise.withResolvers.)
  let releaseFirstWrite!: () => void;
  const firstWriteHeld = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
  const renameBodies: Array<{ label?: string }> = [];
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    renameBodies.push(route.request().postDataJSON() as { label?: string });
    if (renameBodies.length === 1) await firstWriteHeld;
    await route.continue();
  });

  const card = page
    .getByRole("heading", { name: createdLabel, exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space(.)='Rename']][1]");
  await card.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("heading", { name: "Rename Project Label" })).toBeVisible();
  const input = page.getByRole("textbox");
  await input.fill(firstIntent);
  await page.getByRole("button", { name: "Save" }).click();

  // The write is in flight and unanswered, so the dialog is still open.
  await expect.poll(() => renameBodies.length).toBe(1);
  await expect(page.getByRole("heading", { name: "Rename Project Label" })).toBeVisible();

  // The user changes their mind before the write settles: the second Save records
  // the newest label instead of racing a second PATCH the server would order.
  await input.fill(finalIntent);
  await page.getByRole("button", { name: "Save" }).click();
  expect(renameBodies, "a Save while a write is open must coalesce, not race").toHaveLength(1);

  releaseFirstWrite();

  // Exactly one follow-up carries the last label; the dialog closes on the write
  // that belongs to it and the list shows the label the user asked for last.
  await expect.poll(() => renameBodies.length).toBe(2);
  expect(renameBodies[1]).toEqual({ label: finalIntent });
  await expect(page.getByRole("heading", { name: "Rename Project Label" })).toBeHidden();
  await expect(page.getByRole("heading", { name: finalIntent, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: firstIntent, exact: true })).toHaveCount(0);

  // Persisted truth, re-fetched and re-rendered: no residual "First" write can
  // still win, because both writes were applied in the order the user asked.
  await page.reload();
  await expect(page.getByRole("heading", { name: finalIntent, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: firstIntent, exact: true })).toHaveCount(0);
  expect((await readProjects(page)).find((item) => item.id === project.id)?.label).toBe(finalIntent);

  await assertNoUnexpectedAppErrors(page);
});

test("clicking Roots while the first listing is in flight does not strand the browser", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  // Hold the browser's very first listing open: the Roots click lands while the
  // only in-flight loader is unanswered, which is the state a stray generation
  // bump would strand (`loading` never cleared, every button left disabled).
  let releaseFirstListing!: () => void;
  const firstListingHeld = new Promise<void>((resolve) => { releaseFirstListing = resolve; });
  let listings = 0;
  await page.route("**/api/browse*", async (route) => {
    listings += 1;
    if (listings === 1) await firstListingHeld;
    await route.continue();
  });

  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await expect(page.getByText("Loading…")).toBeVisible();

  // Re-asserting Roots starts no replacement load, so the pending listing must
  // survive the click and still be the one that clears the loading state.
  await page.getByRole("button", { name: "Roots", exact: true }).click();
  releaseFirstListing();

  await expect(page.getByText("Loading…")).toBeHidden();
  await expect(page.locator(".folder-item").first()).toBeVisible();

  // Rows are actionable: selecting one navigates, which the breadcrumbs prove.
  await openFolderRow(page, "p-alpha");
  const breadcrumbs = page.locator(".breadcrumbs");
  await expect(breadcrumbs.getByRole("button", { name: "p-alpha", exact: true })).toBeVisible();

  // And the roots strip is usable too: switching root loads its listing to completion.
  await page.getByRole("button", { name: "Roots", exact: true }).click();
  await page.getByRole("button", { name: `${fixture.tempRoot}/roots-secondary`, exact: true }).click();
  await expect(breadcrumbs.getByRole("button", { name: "roots-secondary", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use this folder" })).toBeEnabled();
  await expect(page.getByText("Loading…")).toBeHidden();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await assertNoUnexpectedAppErrors(page);
});

test("cancelling the new-folder form while the created folder pages in does not strand the listing", async ({ page }) => {
  const fixture = harnessFixture();
  const RUN = Date.now().toString(36).slice(-5);
  const folderName = `r17-cancel-${RUN}`;
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  // Hold the first cursor'd page open: the auto-pagination that follows a create
  // is then the only in-flight loader when the form is cancelled.
  let releaseCursorPage!: () => void;
  const cursorPageHeld = new Promise<void>((resolve) => { releaseCursorPage = resolve; });
  let cursorPages = 0;
  await page.route("**/api/browse*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      cursorPages += 1;
      if (cursorPages === 1) await cursorPageHeld;
    }
    await route.continue();
  });

  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await openFolderRow(page, "paged");
  await expect(page.locator(".folder-item").first()).toBeVisible();

  // The created folder sorts after entry-205, so it lands on the last page and the
  // browser pages forward to find it — through the held page. The row itself cannot
  // be on screen yet (the listing renders only once `loading` clears), so the held
  // cursor request is the observable that the pagination is in flight.
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await page.getByLabel(/New folder in/).fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect.poll(() => cursorPages).toBe(1);
  await expect(page.getByText("Loading…")).toBeVisible();

  // Cancel a reopened form while the pagination is still unanswered.
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await expect(page.getByLabel(/New folder in/)).toBeVisible();
  await page.locator("form").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByLabel(/New folder in/)).toBeHidden();

  releaseCursorPage();

  // The pagination finishes, the created folder is on screen and still selected,
  // and the controls are live again — no stuck loading state.
  await expect(page.getByText(new RegExp(`^📁 ${folderName}$`, "u"))).toBeVisible();
  await expect(page.getByText("Selected")).toBeVisible();
  await expect(page.getByText("Loading…")).toBeHidden();
  await expect(page.getByRole("button", { name: "+ New Folder" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Use this folder" })).toBeEnabled();

  // And the rows are actionable: the created folder can be opened.
  await openFolderRow(page, folderName);
  await expect(page.locator(".breadcrumbs").getByRole("button", { name: folderName, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await assertNoUnexpectedAppErrors(page);
});

test("deleting a project with no agents removes it and leaves its directory", async ({ page }) => {
  const fixture = harnessFixture();
  // A fresh folder and label per run: the harness server keeps its state for the
  // whole Playwright process, and a project path may only be claimed once.
  const RUN = Date.now().toString(36).slice(-5);
  const folderName = `r17-delete-${RUN}`;
  const label = `Round17 Delete ${RUN}`;
  await login(page);
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await page.getByLabel(/New folder in/).fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByPlaceholder("Display label (e.g. My Backend)").fill(label);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();

  const project = await projectByLabel(page, label);
  expect(project.path).toBe(`${fixture.rootsDir}/${folderName}`);
  assertInsideHarnessTemp(project.path);
  expect(statSync(project.path).isDirectory()).toBe(true);

  const card = page
    .getByRole("heading", { name: label, exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space(.)='Delete']][1]");
  await card.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Delete Project" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm Delete" }).click();

  await expect(page.getByRole("heading", { name: label, exact: true })).toBeHidden();
  // Metadata gone, files untouched — the product's single hardest rule.
  expect(existsSync(project.path), `deleting a project must never remove ${project.path}`).toBe(true);
  expect(statSync(project.path).isDirectory()).toBe(true);
  expect((await readProjects(page)).some((item) => item.label === label)).toBe(false);

  await assertNoUnexpectedAppErrors(page);
});

test("a refused delete reports the server reason and keeps the project", async ({ page }) => {
  const fixture = harnessFixture();
  await login(page);

  // The server's own refusal (a project whose agents it cannot verify as stopped).
  // Real UI, mocked endpoint: the harness has no agent to observe, so the
  // observation itself is covered by tests/server/round17-delete-observed-auditor.test.ts.
  const CONFLICT = "This project still has agents that are running or cannot be verified as stopped (Seeded conversation). Stop them before deleting the project.";
  declareInjectedFault(page, { urlPattern: /\/api\/projects\/[^/]+$/, status: 409 });
  await page.route("**/api/projects/*", (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "conflict_owner", message: CONFLICT } }) });
  });

  const card = page
    .getByRole("heading", { name: "Seeded Fixture", exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space(.)='Delete']][1]");
  await card.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Confirm Delete" }).click();

  // The reason is shown; the dialog stays open; the project is still listed.
  await expect(page.getByRole("alert")).toContainText("cannot be verified as stopped");
  await expect(page.getByRole("heading", { name: "Delete Project" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Delete Project" })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Seeded Fixture", exact: true })).toBeVisible();

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await assertNoUnexpectedAppErrors(page);
});
