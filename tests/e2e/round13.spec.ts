import { expect, test } from "@playwright/test";
import {
  assertNoUnexpectedAppErrors,
  harnessFixture,
  login,
  openFolderRow,
  openSeededConversation,
  projectByLabel,
  readBrowse,
  requireAppServer,
} from "./fixture.js";

const RUN = Date.now().toString(36).slice(-6);

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("V13-03 late folder create cannot replace currently displayed directory", async ({ page }) => {
  const fixture = harnessFixture();
  const folderName = `r13-race-${RUN}`;
  // The directory the browser is inside when the late create response lands. It must
  // be one no other spec claims as a project path: a workspace directory can back only
  // one project per server (a second POST /api/projects for the same path is refused),
  // so borrowing a shared fixture directory like p-alpha only works until another spec
  // has created its project there.
  const targetName = `r13-race-target-${RUN}`;
  const projectLabel = `R13 race project ${RUN}`;
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  expect((await readBrowse(page)).path).toBe(fixture.rootsDir);

  // Created before the latency mock is installed, so it settles like any other folder.
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await page.getByLabel(/New folder in/).fill(targetName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.getByText("Selected")).toBeVisible();

  // Mocked latency; POST /api/directories reaches real backend before delayed response is returned.
  let createdPath = "";
  await page.route("**/api/directories", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const body = await response.json() as { data?: { path?: string } };
    createdPath = body.data?.path ?? "";
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response, body: JSON.stringify(body) });
  });
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await page.getByLabel(/New folder in/).fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();
  await openFolderRow(page, targetName);
  const currentlyDisplayedPath = `${fixture.rootsDir}/${targetName}`;
  // The browser's own DOM is the evidence for what the user sees; readBrowse()
  // without a path always reports rootsDir, so it cannot observe this at all.
  const breadcrumbs = page.locator(".breadcrumbs");
  await expect(breadcrumbs.getByRole("button", { name: targetName, exact: true })).toBeVisible();
  await expect(breadcrumbs).toContainText(targetName);
  await expect.poll(() => createdPath).not.toBe("");
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByPlaceholder("Display label (e.g. My Backend)").fill(projectLabel);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectLabel, exact: true })).toBeVisible();
  expect((await projectByLabel(page, projectLabel)).path).toBe(currentlyDisplayedPath);
  expect(createdPath).toBe(`${fixture.rootsDir}/${folderName}`);
  expect((await readBrowse(page, fixture.rootsDir)).entries.some((entry) => entry.path === createdPath && entry.isDirectory)).toBe(true);
  await assertNoUnexpectedAppErrors(page);
});

test("V13-07 conversation and activity failures render errors, not empty states", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  // Mocked failure: project conversations endpoint returns HTTP 500.
  await page.route(`**/api/projects/${fixture.seededProjectId}/conversations`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "internal_error", message: "Injected conversations failure" } }) }));
  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("No conversations yet.")).toHaveCount(0);
  await page.unroute(`**/api/projects/${fixture.seededProjectId}/conversations`);

  // Mocked failure: seeded conversation event endpoint returns HTTP 500.
  await page.route(`**/api/conversations/${fixture.seededConversationId}/events**`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "internal_error", message: "Injected activity failure" } }) }));
  await page.getByRole("button", { name: "←" }).click();
  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("No activity recorded for this conversation yet.")).toHaveCount(0);
  // Both 500s were injected; what must not appear is an error the app did not ask for.
  await assertNoUnexpectedAppErrors(page);
});

test("V13-09 rapid star clicks express the desired value and follow server result", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  const project = await projectByLabel(page, "Seeded Fixture");
  expect(project.favorite).toBe(false);
  // Scope to the card: other cards carry their own star controls.
  const card = page.locator(".card").filter({ hasText: "Seeded Fixture" });
  const star = card.getByRole("button", { name: "☆", exact: true });
  const favoriteBodies: unknown[] = [];
  // Mocked latency around real backend PATCH responses. One write per project is
  // in flight at a time, so the invariant is the end state — the desired value
  // reaches the server and the UI follows — not a request per activation.
  await page.route(`**/api/projects/${project.id}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    favoriteBodies.push(route.request().postDataJSON());
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ response });
  });
  // A real double-tap activates twice before React commits: the first click
  // disables the button, so `locator.click()` twice would auto-wait for
  // re-enable and send a *later* deliberate toggle instead of a repeat.
  // Driving both activations in one task is what the race actually is.
  await star.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect(card.getByRole("button", { name: "★", exact: true })).toBeVisible();
  // The repeat activation coalesced into the write already in flight; it must not
  // have raced a second PATCH whose arrival order the server would decide.
  expect(favoriteBodies).toEqual([{ favorite: true }]);
  expect((await projectByLabel(page, "Seeded Fixture")).favorite).toBe(true);
  // One server, one fixture: put the seeded project back the way the next test
  // expects it, through the same path the user would take (an API request from
  // the test context is refused by the Origin/CSRF guards).
  await card.getByRole("button", { name: "★", exact: true }).click();
  await expect(card.getByRole("button", { name: "☆", exact: true })).toBeVisible();
  expect((await projectByLabel(page, "Seeded Fixture")).favorite).toBe(false);
  await assertNoUnexpectedAppErrors(page);
});

test("V13-09 failed star update does not claim success", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  const project = await projectByLabel(page, "Seeded Fixture");
  // Mocked failure: reject PATCH without mutating the real project.
  await page.route(`**/api/projects/${project.id}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "internal_error", message: "Injected favorite failure" } }) })
      : route.continue());
  // Scope to the card: other cards carry their own star controls.
  const card = page.locator(".card").filter({ hasText: "Seeded Fixture" });
  await card.getByRole("button", { name: "☆", exact: true }).click();
  await expect(card.getByRole("button", { name: "☆", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "★", exact: true })).toHaveCount(0);
  expect((await projectByLabel(page, "Seeded Fixture")).favorite).toBe(false);
  await assertNoUnexpectedAppErrors(page);
});

test("V12-03 retry rechecks host link without launching a conversation", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 375, height: 812 });
  let linkRequests = 0;
  // Mocked initial unavailable link; retry then uses the real endpoint.
  await page.route(`**/api/conversations/${fixture.seededConversationId}/link**`, async (route) => {
    linkRequests++;
    if (linkRequests === 1) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "link_unavailable", message: "No process yet" } }) });
    } else await route.continue();
  });
  let launches = 0;
  await page.route(`**/api/projects/${fixture.seededProjectId}/conversations`, (route) => {
    if (route.request().method() === "POST") launches++;
    return route.continue();
  });
  await openSeededConversation(page);
  await expect(page.getByText(/Host presence is not yet verified|No saved transcript is available/)).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  // The seeded fixture has no nativeSessionId, so the real endpoint can only ever
  // return the unavailable state: what Retry guarantees is a recheck that leaves
  // the affordance in place for another attempt, and never a conversation launch.
  await expect.poll(() => linkRequests).toBe(2);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText(/Host presence is not yet verified|No saved transcript is available/)).toBeVisible();
  expect(launches).toBe(0);
  // The 404 link response is injected (and the real endpoint answers the same way
  // for a seeded conversation with no writer); nothing else may error.
  await assertNoUnexpectedAppErrors(page);
});

test("V13-04 late new chat response leaves current project selected", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);

  // The evidence that the backend kept the chat is the store's own list, not the
  // delayed response: the POST may outlive the test's own window (the launch behind
  // it is refused by the harness), so reading the response would race the assertion
  // instead of proving it. Snapshot the list before, look for a new id after.
  const conversationIds = async (): Promise<string[]> => {
    const response = await page.request.get(`/api/projects/${fixture.seededProjectId}/conversations`);
    expect(response.status()).toBe(200);
    const body = await response.json() as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((conversation) => conversation.id);
  };

  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  const existingConversationIds = await conversationIds();

  // Mocked latency around real conversation creation; POST commits before its response is delayed.
  await page.route(`**/api/projects/${fixture.seededProjectId}/conversations`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "+ New chat" }).click();
  await page.getByRole("button", { name: "←" }).click();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  const seededProjectDetail = page.getByRole("heading", { name: "Conversations", exact: true });
  await expect(seededProjectDetail).toBeVisible();
  // Select another project while the create response remains in flight.
  await page.getByRole("button", { name: "←" }).click();
  const otherProject = page.getByRole("heading").filter({ hasText: /^(?!Seeded Fixture$).+/ }).first();
  const otherLabel = await otherProject.innerText();
  await otherProject.click();
  await expect(page.getByRole("heading", { name: otherLabel, exact: true })).toBeVisible();

  await expect.poll(async () => (await conversationIds()).some((id) => !existingConversationIds.includes(id))).toBe(true);
  expect((await conversationIds()).filter((id) => !existingConversationIds.includes(id))).toHaveLength(1);
  await expect(page.getByRole("heading", { name: otherLabel, exact: true })).toBeVisible();
  // The route is still holding the delayed response; do not wait for it, the test's
  // claim is about the app's state, not about that response arriving.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await assertNoUnexpectedAppErrors(page);
});
