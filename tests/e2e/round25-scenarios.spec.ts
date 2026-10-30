import { expect, test, type Page } from "@playwright/test";
import {
  E2E_PASSWORD,
  assertNoUnexpectedAppErrors,
  declareInjectedFault,
  harnessFixture,
  login,
  mockConversationLink,
  openSeededConversation,
  readProjects,
  requireAppServer,
} from "./fixture.js";

/**
 * Round-25 browser verification: the fixes in commits 7fcf566/88ed31cc have unit
 * coverage, and this file proves the same behaviour through the real bundle
 * against the real server. Nothing here launches an agent (the launcher pins
 * CAW_OMP_BINARY_PATH to its recorder stub), and every race is created the way
 * the product creates it: a request is held open at the HTTP layer while the
 * user keeps working, then released, and the DOM is read after the dust settles.
 *
 * The gates are hand-rolled (this repo targets Node 20, which has no
 * `Promise.withResolvers`; see the same note in round17-flows.spec.ts) and
 * `route.continue()`/`route.fetch()` is used wherever the real server's answer is
 * the evidence — only the password change is answered from the harness, because
 * applying it would rotate the harness credential out from under every other spec.
 */

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

const RUN = Date.now().toString(36).slice(-5);

/** A manually opened gate: `open()` releases whatever awaits `promise`. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** The project card holding `label`'s heading and its Rename/Delete actions. */
function projectCard(page: Page, label: string) {
  return page
    .getByRole("heading", { name: label, exact: true })
    .locator("xpath=ancestor::div[.//button[normalize-space(.)='Rename']][1]");
}

/** The one paragraph that reports the persisted model preference. */
function preferenceLine(page: Page) {
  return page.locator("p", { hasText: "Preferred for next launch:" });
}

async function pageWidth(page: Page) {
  return page.evaluate(() => ({ scrollWidth: document.scrollingElement!.scrollWidth, innerWidth: window.innerWidth }));
}

// ─────────────────────────────────────────────────────────────────────────────
// a. V25-01 — a rename that outlives its view must not land after a newer one.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * V25-01 fix, verified end to end. Two things have to hold after the older write
 * is released: the server converges on the last intent (asserted through a fresh
 * page read) and the LIVE view shows it — the dialog the user just submitted on
 * closes and the card repaints, with no reload. The follow-up PATCH is issued from
 * the closure of a ProjectsView that has since unmounted, so the feedback path
 * routes through the mounted view's own refs and setters (see
 * `liveProjectsFeedback` in ProjectsView.tsx); before that, the card kept the
 * stale label and the dialog stayed open with no visible failure, and only a
 * reload rendered the stored value.
 */
async function renameAcrossSettings(page: Page, suffix: string): Promise<void> {
  const folderName = `r25-rename-${RUN}-${suffix}`;
  const createdLabel = `R25 Rename ${RUN} ${suffix}`;
  const firstLabel = `${createdLabel} First`;
  const finalLabel = `${createdLabel} Final`;

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

  const project = (await readProjects(page)).find((item) => item.label === createdLabel);
  expect(project, "the project just created must be listed").toBeDefined();

  // The first PATCH is held open across the whole Settings round-trip: that pending
  // write is the race. Both writes still reach the real server through `continue()`,
  // so the end state is the server's own.
  const firstWrite = gate();
  const bodies: Array<{ label?: string }> = [];
  await page.route(`**/api/projects/${project!.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    bodies.push(route.request().postDataJSON() as { label?: string });
    if (bodies.length === 1) await firstWrite.promise;
    await route.continue();
  });

  await projectCard(page, createdLabel).getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("heading", { name: "Rename Project Label" })).toBeVisible();
  await page.getByRole("textbox").fill(firstLabel);
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => bodies.length).toBe(1);
  await expect(page.getByRole("heading", { name: "Rename Project Label" })).toBeVisible();

  // Leave for Settings and back: this unmounts ProjectsView while the "First"
  // PATCH is still unanswered, which is exactly the lifetime the fix covers.
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();
  await page.getByRole("button", { name: "← Back" }).click();
  await expect(page.getByRole("heading", { name: createdLabel, exact: true })).toBeVisible();

  // The reopened dialog saves the last intent while the older write is still open.
  await projectCard(page, createdLabel).getByRole("button", { name: "Rename" }).click();
  await page.getByRole("textbox").fill(finalLabel);
  await page.getByRole("button", { name: "Save" }).click();
  expect(bodies, "a Save while the project's write is open must not race a second PATCH").toHaveLength(1);

  firstWrite.open();

  // Submission order became arrival order: exactly one follow-up, carrying "Final".
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual({ label: finalLabel });

  // The live view must show it without a reload: the dialog the user submitted on
  // closes and the card repaints with the label the server now holds.
  await expect(page.getByRole("heading", { name: "Rename Project Label" })).toBeHidden();
  await expect(page.getByRole("heading", { name: finalLabel, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: firstLabel, exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Persisted truth. Read by a fresh page so nothing the old mount did can be
  // mistaken for the stored value: no late "First" write can still win.
  await page.reload();
  await expect(page.getByRole("heading", { name: finalLabel, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: firstLabel, exact: true })).toHaveCount(0);
  expect((await readProjects(page)).find((item) => item.id === project!.id)?.label).toBe(finalLabel);

  await assertNoUnexpectedAppErrors(page);
}

test("V25-01 a rename pending across Settings settles on the label submitted last", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await renameAcrossSettings(page, "base");
});

for (const viewport of [{ name: "375x667", size: { width: 375, height: 667 } }, { name: "393x852", size: { width: 393, height: 852 } }]) {
  test.describe(`V25-01 at ${viewport.name}`, () => {
    test.use({ viewport: viewport.size });
    test(`a rename pending across Settings settles on the last label (${viewport.name})`, async ({ page }) => {
      await renameAcrossSettings(page, viewport.name.replace("x", "m"));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// b. V25-02 — a model save that outlives its view must not land after a newer one.
// ─────────────────────────────────────────────────────────────────────────────

test("V25-02 a model save pending across Back/reopen settles on the model saved last", async ({ page }) => {
  const fixture = harnessFixture();
  const id = fixture.seededConversationId;
  const firstModel = `R25_MODEL_FIRST_${RUN}`;
  const finalModel = `R25_MODEL_FINAL_${RUN}`;

  // No live writer in the harness: the screen settles in its saved/unavailable
  // mode, which is also the state the model controls are reachable from.
  await mockConversationLink(page, { ok: false, error: { code: "link_unavailable", message: "No live agent is sharing this conversation right now." } }, 409);
  await openSeededConversation(page);

  const firstWrite = gate();
  const bodies: Array<{ model?: string }> = [];
  await page.route(`**/api/conversations/${id}/model`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    bodies.push(route.request().postDataJSON() as { model?: string });
    if (bodies.length === 1) await firstWrite.promise;
    await route.continue();
  });

  await page.getByText("Conversation model settings").click();
  // The async hydration commit lands between fill()'s selectText and insertText
  // halves and clobbers the typed value; wait for it before filling.
  await expect(page.locator("#custom-model")).toHaveValue("preferred/model");
  await page.locator("#custom-model").fill(firstModel);
  await page.getByRole("button", { name: "Save model" }).click();
  await expect.poll(() => bodies.length).toBe(1);

  // Back to the project, then reopen the conversation: the "FIRST" save is still
  // in flight while the reopened view submits "FINAL".
  await page.getByRole("button", { name: "←" }).click();
  await expect(page.getByRole("heading", { name: "Conversations" })).toBeVisible();
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Seeded conversation", exact: true })).toBeVisible();

  await page.getByText("Conversation model settings").click();
  // First PATCH still route-gated, so the server still holds the seeded value.
  await expect(page.locator("#custom-model")).toHaveValue("preferred/model");
  await page.locator("#custom-model").fill(finalModel);
  await page.getByRole("button", { name: "Save model" }).click();

  firstWrite.open();

  // Both writes reached the server, in submission order: FIRST then FINAL.
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies).toEqual([{ model: firstModel }, { model: finalModel }]);

  // Reopen once more: the screen must render what the server stored.
  await page.getByRole("button", { name: "←" }).click();
  await expect(page.getByRole("heading", { name: "Conversations" })).toBeVisible();
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  await expect(preferenceLine(page)).toContainText(finalModel);
  await expect(preferenceLine(page)).not.toContainText(firstModel);

  // One server, one seeded conversation: put the preference back the way the
  // screen-inventory spec expects it, through the same UI path a user would take
  // (a request from the test context is refused by the Origin/CSRF guards).
  await page.getByText("Conversation model settings").click();
  await expect(page.locator("#custom-model")).toHaveValue(finalModel);
  await page.locator("#custom-model").fill("preferred/model");
  await page.getByRole("button", { name: "Save model" }).click();
  await expect(preferenceLine(page)).toContainText("preferred/model");

  await assertNoUnexpectedAppErrors(page);
});

// ─────────────────────────────────────────────────────────────────────────────
// c. V25-04 — two overlapping Retries: the newer read must win, whenever it lands.
// ─────────────────────────────────────────────────────────────────────────────

test("V25-04 an older Retry response cannot rewind a newer one", async ({ page }) => {
  const fixture = harnessFixture();
  const id = fixture.seededConversationId;
  const olderModel = `R25_OLDER_READ_${RUN}`;
  const newerModel = `R25_NEWER_READ_${RUN}`;

  await mockConversationLink(page, { ok: false, error: { code: "link_unavailable", message: "No live agent is sharing this conversation right now." } }, 409);
  await openSeededConversation(page);

  // Installed after the screen is up, so only the Retry reads are gated. Each read
  // is answered with the real server's own body and the preference swapped, so the
  // client path under test is the real one.
  const olderGate = gate();
  const newerGate = gate();
  let reads = 0;
  const released: string[] = [];
  await page.route(`**/api/conversations/${id}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const mine = ++reads;
    const model = mine === 1 ? olderModel : newerModel;
    const response = await route.fetch();
    const json = (await response.json()) as { data: Record<string, unknown> };
    if (mine === 1) await olderGate.promise;
    else await newerGate.promise;
    released.push(model);
    await route.fulfill({ response, body: JSON.stringify({ ...json, data: { ...json.data, modelPreference: model } }) });
  });

  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => reads).toBe(1);
  await retry.click();
  await expect.poll(() => reads).toBe(2);

  // Response completion order is NEWER first, then the OLDER one.
  newerGate.open();
  await expect.poll(() => released.length).toBe(1);
  expect(released).toEqual([newerModel]);
  olderGate.open();
  await expect.poll(() => released.length).toBe(2);
  expect(released).toEqual([newerModel, olderModel]);

  // The late older response must not repaint the newer result.
  await expect(preferenceLine(page)).toContainText(newerModel);
  await expect(preferenceLine(page)).not.toContainText(olderModel);

  await assertNoUnexpectedAppErrors(page);
});

// ─────────────────────────────────────────────────────────────────────────────
// d. V25-06 — a failed runtime read is Unknown plus a banner, never "Missing".
// ─────────────────────────────────────────────────────────────────────────────

async function runtimeFailureRecovers(page: Page): Promise<void> {
  await login(page);

  declareInjectedFault(page, { urlPattern: /\/api\/runtime$/, status: 500 });
  await page.route("**/api/runtime", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "internal", message: "Injected runtime failure" } }) }));
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();

  // A read that failed says nothing about the host: no engine may be called Missing.
  await expect(page.getByText(/^Runtime status unavailable: Injected runtime failure/)).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(3);
  await expect(page.getByText("Missing", { exact: true })).toHaveCount(0);

  // The banner must not widen the page at a phone width.
  const width = await pageWidth(page);
  expect(width.scrollWidth, "the error banner must not cause horizontal overflow").toBeLessThanOrEqual(width.innerWidth);

  await page.unroute("**/api/runtime");
  await page.getByRole("button", { name: "Retry" }).click();

  // Recovered: real capabilities render, so nothing is Unknown any more.
  await expect(page.getByText(/Available \(/).first()).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/^Runtime status unavailable:/)).toHaveCount(0);
  const recovered = await pageWidth(page);
  expect(recovered.scrollWidth).toBeLessThanOrEqual(recovered.innerWidth);

  await assertNoUnexpectedAppErrors(page);
}

test("V25-06 a failed runtime read shows Unknown and a Retry banner, then recovers", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await runtimeFailureRecovers(page);
});

for (const viewport of [{ name: "375x667", size: { width: 375, height: 667 } }, { name: "393x852", size: { width: 393, height: 852 } }]) {
  test.describe(`V25-06 at ${viewport.name}`, () => {
    test.use({ viewport: viewport.size });
    test(`a failed runtime read shows Unknown and recovers (${viewport.name})`, async ({ page }) => {
      await runtimeFailureRecovers(page);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// e. N25-01 — a failed project list must not claim the workspace is empty.
// ─────────────────────────────────────────────────────────────────────────────

test("N25-01 a failed project list shows its error and never the empty-workspace claim", async ({ page }) => {
  declareInjectedFault(page, { urlPattern: /\/api\/projects$/, status: 500 });
  await page.route("**/api/projects", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "internal", message: "Injected project list failure" } }) });
  });
  await login(page);

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Injected project list failure");
  await expect(page.getByText("No projects added yet.")).toHaveCount(0);

  // Recovered read: the list itself renders.
  await page.unroute("**/api/projects");
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();
  await page.getByRole("button", { name: "← Back" }).click();
  await expect(page.getByRole("heading", { name: "Seeded Fixture", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await assertNoUnexpectedAppErrors(page);
});

// ─────────────────────────────────────────────────────────────────────────────
// f. V25-03 — a pending password change locks both fields, then clears them.
// ─────────────────────────────────────────────────────────────────────────────

test("V25-03 both password fields lock while the change is pending, then clear", async ({ page }) => {
  await login(page);
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();

  // The response is answered from the harness: this credential is the one every
  // other spec logs in with, so a real change would rotate it out from under them.
  const pending = gate();
  await page.route("**/api/auth/change-password", async (route) => {
    await pending.promise;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { changed: true } }) });
  });

  const current = page.getByLabel("Current password");
  const updated = page.getByLabel("New password (12 characters minimum)");
  await current.fill(E2E_PASSWORD);
  await updated.fill("r25-new-password-do-not-apply");
  await page.getByRole("button", { name: "Change password" }).click();

  // Disabled (not read-only): a draft typed here could never survive the success.
  await expect(current).toBeDisabled();
  await expect(updated).toBeDisabled();
  await expect(page.getByRole("button", { name: "Changing…" })).toBeDisabled();

  pending.open();

  await expect(page.getByText("Password changed. Other sessions were signed out.")).toBeVisible();
  await expect(current).toBeEnabled();
  await expect(updated).toBeEnabled();
  await expect(current).toHaveValue("");
  await expect(updated).toHaveValue("");

  await assertNoUnexpectedAppErrors(page);
});
