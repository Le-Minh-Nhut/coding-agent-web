import { expect, test } from "@playwright/test";
import {
  assertNoUnexpectedAppErrors,
  createAssistantMessageEntry,
  createUserMessageEntry,
  declareInjectedFault,
  harnessFixture,
  installMockCollabHost,
  login,
  mockNativeSessions,
  openFolderRow,
  openSeededConversation,
  projectByLabel,
  readBrowse,
  requireAppServer,
  welcomeFrame,
} from "./fixture.js";

const COMPOSER = /Send instructions to agent|Turn in flight/;
const RUN = Date.now().toString(36).slice(-6);

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("folder created in browser becomes usable project directory", async ({ page }) => {
  const fixture = harnessFixture();
  const folderName = `regression-folder-${RUN}`;
  const projectLabel = `Regression project ${RUN}`;
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  expect((await readBrowse(page)).path).toBe(fixture.rootsDir);
  await page.getByRole("button", { name: "+ New Folder" }).click();
  await page.getByLabel(/New folder in/).fill(folderName);
  await page.getByRole("button", { name: "Create folder" }).click();

  const createdPath = `${fixture.rootsDir}/${folderName}`;
  await expect(page.getByText("Selected")).toBeVisible();
  expect((await readBrowse(page, fixture.rootsDir)).entries.some((entry) => entry.path === createdPath && entry.isDirectory)).toBe(true);
  await openFolderRow(page, folderName);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByPlaceholder("Display label (e.g. My Backend)").fill(projectLabel);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectLabel, exact: true })).toBeVisible();
  expect((await projectByLabel(page, projectLabel)).path).toBe(createdPath);
  await assertNoUnexpectedAppErrors(page);
});

test("invalid folder names show errors or cannot be submitted and create nothing", async ({ page }) => {
  const fixture = harnessFixture();
  await login(page);
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  const namesBefore = (await readBrowse(page, fixture.rootsDir)).entries.map((entry) => entry.name).sort();

  // This test deliberately submits names the backend must reject, so the 400 it
  // answers with is the asserted behavior (the alert below), not an app failure.
  declareInjectedFault(page, { urlPattern: /\/api\/directories$/, status: 400 });

  for (const name of [".", "..", "a/b", "", "   "]) {
    await page.getByRole("button", { name: "+ New Folder" }).click();
    const input = page.getByLabel(/New folder in/);
    await input.fill(name);
    const submit = page.getByRole("button", { name: "Create folder" });
    if (!name.trim()) {
      await expect(submit).toBeDisabled();
    } else {
      await input.evaluate((element) => element.closest("form")!.requestSubmit());
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("alert")).not.toHaveText("");
    }
    expect((await readBrowse(page, fixture.rootsDir)).entries.map((entry) => entry.name).sort()).toEqual(namesBefore);
    await page.getByRole("button", { name: "Cancel", exact: true }).first().click();
  }
  await assertNoUnexpectedAppErrors(page);
});

test("free untracked native session resumes without retry after conflict_owner", async ({ page }) => {
  const fixture = harnessFixture();
  await mockNativeSessions(page, [{
    sessionId: "resume-session-regression",
    path: `${fixture.rootsDir}/seeded/resume-session-regression`,
    cwd: `${fixture.rootsDir}/seeded`,
    title: "Resume regression session",
    updatedAt: "2026-10-25T08:30:00.000Z",
    live: false,
    tracked: false,
  }]);
  let launchRequests = 0;
  let launchBody: Record<string, unknown> | null = null;
  // Injected 409; declared here so the error filter forgives only this URL+status.
  declareInjectedFault(page, { urlPattern: /\/api\/projects\/[^/]+\/conversations$/, status: 409 });
  await page.route(`**/api/projects/${fixture.seededProjectId}/conversations`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    launchRequests += 1;
    launchBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: { code: "conflict_owner", message: "Agent launch failed" } }),
    });
  });
  await login(page);
  await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
  await expect(page.getByText("Resume regression session", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume in app" }).click();
  await expect(page.getByRole("alert")).toContainText("already has a writer or its lease cannot be verified");
  await expect(page.getByRole("alert")).toContainText("no second agent was started");
  expect(launchBody?.resumeSessionId).toBe("resume-session-regression");
  expect(launchRequests).toBe(1);
  await page.waitForTimeout(150);
  expect(launchRequests).toBe(1);
  // The 409 is injected too, and it still must not smuggle a console error in.
  await assertNoUnexpectedAppErrors(page);
});

test("long transcript stays inside viewport, detached reading stays put, and Latest follows tail", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  const scroller = page.locator(".messages-scroll");
  for (let index = 0; index < 28; index++) {
    await host.send({ t: "entry", entry: createUserMessageEntry(`reg-long-${index}`, `Transcript line ${index}: ${"older content ".repeat(24)}`, index + 1) });
  }
  await expect(page.locator(".message-card.user")).toHaveCount(28);

  for (const viewport of [{ width: 375, height: 812 }, { width: 430, height: 932 }]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const element = document.querySelector(".messages-scroll")!;
      return { transcriptHeight: element.scrollHeight, clientHeight: element.clientHeight, documentHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
    });
    expect(geometry.transcriptHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.documentHeight).toBeLessThanOrEqual(geometry.viewportHeight);
    await scroller.evaluate((element: HTMLElement) => { element.scrollTop = 120; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await expect(page.getByRole("button", { name: /Latest/ })).toBeVisible();
    const detachedTop = await scroller.evaluate((element: HTMLElement) => element.scrollTop);
    await host.send({ t: "entry", entry: createUserMessageEntry(`reg-detached-${viewport.width}`, `Appended while detached ${"new content ".repeat(100)}`, 10_000 + viewport.width) });
    await expect(page.getByText(/Appended while detached/).first()).toBeVisible();
    expect(await scroller.evaluate((element: HTMLElement) => element.scrollTop)).toBe(detachedTop);
    await page.getByRole("button", { name: /Latest/ }).click();
    const afterLatest = await scroller.evaluate((element: HTMLElement) => ({ scrollTop: element.scrollTop, bottom: element.scrollHeight - element.clientHeight }));
    expect(afterLatest.scrollTop).toBe(afterLatest.bottom);
  }
  await assertNoUnexpectedAppErrors(page);
});

test("six-column markdown table scrolls inside its wrapper at 375px", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize({ width: 375, height: 812 });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send({
    t: "entry",
    entry: {
      id: "regression-wide-table",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "| Identifier | Component | Commit | Region | Runtime health | Latency |\n| --- | --- | --- | --- | --- | --- |\n| node-east-01 | Ingress Dispatcher Gateway | v2.18.4-c892a | us-east-1a (Virginia) | Healthy nominal operation | 123.4 ms p95 |" }],
      },
    },
  });
  const wrapper = page.locator(".markdown-table-scroll");
  await expect(wrapper).toBeVisible();
  const geometry = await wrapper.evaluate((element) => ({ tableWidth: element.querySelector("table")!.scrollWidth, wrapperWidth: element.clientWidth, overflowX: getComputedStyle(element).overflowX, pageWidth: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  expect(geometry.tableWidth).toBeGreaterThan(geometry.wrapperWidth);
  expect(geometry.overflowX).toBe("auto");
  expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  await wrapper.evaluate((element: HTMLElement) => { element.scrollLeft = 100; });
  expect(await wrapper.evaluate((element: HTMLElement) => element.scrollLeft)).toBeGreaterThan(0);
  await assertNoUnexpectedAppErrors(page);
});

test("code copy preserves content and reports rejected clipboard writes", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  const code = `const payload = "${"copy-me-".repeat(80)}";`;
  await host.send({ t: "entry", entry: { id: "regression-copy-code", type: "message", message: { role: "assistant", content: [{ type: "text", text: `\`\`\`js\n${code}\n\`\`\`` }] } } });
  const copy = page.getByRole("button", { name: "Copy code" });
  await expect(copy).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin });
  await copy.click();
  await expect(copy).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new Error("clipboard denied")) });
  });
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(copy).toHaveText("Copy failed");
  await assertNoUnexpectedAppErrors(page);
});

test("unsupported slash command is intercepted, explicit plain text sends once, unknown command stays prompt", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await composer.fill("/compact");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".slash-command-intercept")).toContainText("no Collab control for compact");
  expect(host.prompts).toEqual([]);
  await page.getByRole("button", { name: "Send as plain text anyway" }).click();
  await expect.poll(() => host.prompts.length).toBe(1);
  expect(host.prompts).toEqual(["/compact"]);
  await composer.fill("/not-a-command");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => host.prompts.length).toBe(2);
  expect(host.prompts).toEqual(["/compact", "/not-a-command"]);
  await assertNoUnexpectedAppErrors(page);
});

test("reconnect restores snapshot transcript without duplicate rows", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  const entries = [createUserMessageEntry("regression-snapshot-user", "snapshot user row", 101), createAssistantMessageEntry("regression-snapshot-assistant", "snapshot assistant row", 102)];
  await host.send({ ...welcomeFrame(false), entryCount: entries.length });
  await host.send({ t: "snapshot-chunk", entries, final: true });
  const rows = page.locator(".message-card");
  await expect(rows).toHaveCount(2);
  await expect(page.getByText("snapshot user row")).toBeVisible();
  await expect(page.getByText("snapshot assistant row")).toBeVisible();
  const before = await rows.count();
  const connectionsBefore = host.connections;
  await host.drop();
  await expect.poll(() => host.connections).toBeGreaterThan(connectionsBefore);
  const reconnectEntries = [createUserMessageEntry("regression-snapshot-user", "snapshot user row", 101), createAssistantMessageEntry("regression-snapshot-assistant", "snapshot assistant row", 102)];
  await host.send({ ...welcomeFrame(false), entryCount: reconnectEntries.length });
  await host.send({ t: "snapshot-chunk", entries: reconnectEntries, final: true });
  await expect(rows).toHaveCount(before);
  await expect(page.getByText("snapshot user row")).toHaveCount(1);
  await expect(page.getByText("snapshot assistant row")).toHaveCount(1);
  await assertNoUnexpectedAppErrors(page);
});

test("draft survives navigation and clears after successful send", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize({ width: 430, height: 932 });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await composer.fill("draft survives navigation");
  const connectionsBefore = host.connections;
  await page.getByRole("button", { name: "←" }).click();
  await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();
  const returnedComposer = page.getByRole("textbox", { name: COMPOSER });
  await expect(returnedComposer).toHaveValue("draft survives navigation");
  await expect.poll(() => host.connections).toBeGreaterThan(connectionsBefore);
  await host.send(welcomeFrame(false));
  await expect(page.getByText("Connected — no turn in flight")).toBeVisible();
  await returnedComposer.fill("send this and clear draft");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => host.prompts.length).toBe(1);
  expect(host.prompts).toEqual(["send this and clear draft"]);
  await expect(returnedComposer).toHaveValue("");
  await assertNoUnexpectedAppErrors(page);
});
