import { expect, test, type Page } from "@playwright/test";
import { existsSync, statSync } from "node:fs";
import {
  assertInsideHarnessTemp,
  assertNoUnexpectedAppErrors,
  declareInjectedFault,
  harnessFixture,
  installMockCollabHost,
  login,
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

/** Bunched so a failure names the viewport it happened at. */
const VIEWPORTS = [
  { name: "mobile 390x844", size: { width: 390, height: 844 } },
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
