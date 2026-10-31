import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  harnessFixture,
  installMockCollabHost,
  login,
  openFolderRow,
  mockNativeSessions,
  requireAppServer,
  welcomeFrame,
  createUserMessageEntry,
  createAssistantMessageEntry,
  createToolResultEntry,
  LONG_CODING_RESPONSE_TEXT,
  REALISTIC_TOOL_OUTPUT,
  MOCK_SUBAGENTS,
  MOCK_APPROVAL_REQUEST,
} from "./fixture.js";

interface GeometryRecord {
  viewport: string;
  screen: string;
  pageHorizontalOverflow: boolean;
  docScrollWidth: number;
  windowInnerWidth: number;
  messagesScrollOverflowsY: boolean | null;
  messagesScrollOverflowsX: boolean | null;
  messagesScrollWidth: number | null;
  messagesClientWidth: number | null;
  defaultFontSize: string;
  defaultLineHeight: string;
  messageBodyFontSize: string | null;
  messageBodyLineHeight: string | null;
  composerBox: { x: number; y: number; width: number; height: number; bottom: number } | null;
  composerFullyInside: boolean | null;
  composerBottomPadding: string | null;
  composerRespectsSafeArea: boolean | null;
  minTouchTarget: { selector: string; text: string; width: number; height: number } | null;
  sub44pxTargets: Array<{ selector: string; text: string; width: number; height: number }>;
  codeBlockScroll: { scrollWidth: number; clientWidth: number; overflows: boolean } | null;
  tableScroll: { scrollWidth: number; clientWidth: number; overflows: boolean } | null;
  latestButtonVisible: boolean;
  latestButtonBox: { x: number; y: number; width: number; height: number } | null;
  transcriptContentBox: { x: number; y: number; width: number; height: number } | null;
  modelSelectorBox: { x: number; y: number; width: number; height: number } | null;
  latestComposerGap: number | null;
  latestIntersectsTranscript: boolean | null;
}

interface InteractionResults {
  scrollUpNoJump: { before: number; after: number; passed: boolean };
  tapLatestReturnsToTail: { distanceToTail: number; passed: boolean; note?: string };
  expandToolPreservesScroll: { before: number; after: number; passed: boolean };
  subagentPanelPreservesScroll: { before: number; after: number; passed: boolean };
  composerFocusVisible: { y: number; height: number; viewportHeight: number; passed: boolean; note: string };
}

const VIEWPORTS = [
  { name: "375x667", width: 375, height: 667, dpr: 2, isMobile: true, hasTouch: true },
  { name: "375x812", width: 375, height: 812, dpr: 3, isMobile: true, hasTouch: true },
  { name: "390x844", width: 390, height: 844, dpr: 2, isMobile: true, hasTouch: true },
  { name: "430x932", width: 430, height: 932, dpr: 3, isMobile: true, hasTouch: true },
  { name: "768x1024", width: 768, height: 1024, dpr: 2, isMobile: true, hasTouch: true },
  { name: "1280x800", width: 1280, height: 800, dpr: 1, isMobile: false, hasTouch: false },
  { name: "1440x900", width: 1440, height: 900, dpr: 1, isMobile: false, hasTouch: false },
] as const;
const SCREENS_DIR = join(process.cwd(), "docs", "assets", "screens");

const MANIFEST_PATH = join(SCREENS_DIR, "manifest.md");

const allGeometryRecords: GeometryRecord[] = [];
let interactionResults: InteractionResults | null = null;

async function measureDOM(page: Page, viewport: string, screen: string): Promise<GeometryRecord> {
  return await page.evaluate(
    ({ vp, sn }) => {
      const docScrollWidth = document.documentElement.scrollWidth;
      const windowInnerWidth = window.innerWidth;
      const pageHorizontalOverflow = docScrollWidth > windowInnerWidth;

      const messagesScroll = document.querySelector(".messages-scroll") as HTMLElement | null;
      const messagesScrollOverflowsY = messagesScroll ? messagesScroll.scrollHeight > messagesScroll.clientHeight : null;
      const messagesScrollOverflowsX = messagesScroll ? messagesScroll.scrollWidth > messagesScroll.clientWidth : null;
      const messagesScrollWidth = messagesScroll ? messagesScroll.scrollWidth : null;
      const messagesClientWidth = messagesScroll ? messagesScroll.clientWidth : null;

      const bodyStyle = window.getComputedStyle(document.body);
      const defaultFontSize = bodyStyle.fontSize;
      const defaultLineHeight = bodyStyle.lineHeight;

      const messageEl = document.querySelector(".message-content") as HTMLElement | null;
      let messageBodyFontSize: string | null = null;
      let messageBodyLineHeight: string | null = null;
      if (messageEl) {
        const target = messageEl.querySelector("p") || messageEl;
        const style = window.getComputedStyle(target);
        messageBodyFontSize = style.fontSize;
        messageBodyLineHeight = style.lineHeight;
      }

      const composerContainer = document.querySelector(".composer-container") as HTMLElement | null;
      let composerBox: { x: number; y: number; width: number; height: number; bottom: number } | null = null;
      let composerFullyInside: boolean | null = null;
      let composerBottomPadding: string | null = null;
      let composerRespectsSafeArea: boolean | null = null;

      if (composerContainer) {
        const rect = composerContainer.getBoundingClientRect();
        composerBox = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          bottom: Math.round(rect.bottom),
        };
        composerFullyInside =
          rect.left >= 0 &&
          rect.right <= window.innerWidth + 1 &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight + 1;
        composerBottomPadding = window.getComputedStyle(composerContainer).paddingBottom;
        const padNum = parseFloat(composerBottomPadding) || 0;
        composerRespectsSafeArea = rect.bottom <= window.innerHeight + 1 && padNum >= 12;
      }

      const interactives = Array.from(
        document.querySelectorAll('button, a[href], input, textarea, select, summary, [role="button"]')
      ) as HTMLElement[];

      let minTouchTarget: { selector: string; text: string; width: number; height: number } | null = null;
      const sub44pxTargets: Array<{ selector: string; text: string; width: number; height: number }> = [];

      for (const el of interactives) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          continue;
        }
        if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
          continue;
        }
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : "";
        const cls =
          el.className && typeof el.className === "string"
            ? `.${el.className.split(" ").filter(Boolean).slice(0, 2).join(".")}`
            : "";
        const text = (el.textContent || (el as HTMLInputElement).value || "").trim().replace(/\s+/g, " ").slice(0, 25);
        const sel = `${tag}${id}${cls}`;
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);

        if (w < 44 || h < 44) {
          sub44pxTargets.push({ selector: sel, text, width: w, height: h });
        }

        if (!minTouchTarget || Math.min(w, h) < Math.min(minTouchTarget.width, minTouchTarget.height)) {
          minTouchTarget = { selector: sel, text, width: w, height: h };
        }
      }

      const codePre = document.querySelector(".markdown-code-block pre, pre") as HTMLElement | null;
      let codeBlockScroll: { scrollWidth: number; clientWidth: number; overflows: boolean } | null = null;
      if (codePre) {
        codeBlockScroll = {
          scrollWidth: codePre.scrollWidth,
          clientWidth: codePre.clientWidth,
          overflows: codePre.scrollWidth > codePre.clientWidth,
        };
      }

      const tableWrapper = document.querySelector(".markdown-table-scroll") as HTMLElement | null;
      let tableScroll: { scrollWidth: number; clientWidth: number; overflows: boolean } | null = null;
      if (tableWrapper) {
        tableScroll = {
          scrollWidth: tableWrapper.scrollWidth,
          clientWidth: tableWrapper.clientWidth,
          overflows: tableWrapper.scrollWidth > tableWrapper.clientWidth,
        };
      }

      const modelSelector = document.querySelector("#conversation-model") as HTMLElement | null;
      const modelSelectorRect = modelSelector?.getBoundingClientRect() ?? null;
      const modelSelectorBox = modelSelectorRect ? { x: Math.round(modelSelectorRect.x), y: Math.round(modelSelectorRect.y), width: Math.round(modelSelectorRect.width), height: Math.round(modelSelectorRect.height) } : null;
      const latestBtn = document.querySelector(".latest-button") as HTMLElement | null;
      const transcriptContent = document.querySelector(".messages-content") as HTMLElement | null;
      const latestButtonBox = latestBtn ? latestBtn.getBoundingClientRect() : null;
      const composerTop = document.querySelector(".composer-container")?.getBoundingClientRect().top ?? null;
      const latestComposerGap = latestButtonBox && composerTop !== null ? Math.round(composerTop - latestButtonBox.bottom) : null;
      const scrollRect = messagesScroll?.getBoundingClientRect() ?? null;
      const contentRect = transcriptContent?.getBoundingClientRect() ?? null;
      const transcriptContentRect = scrollRect && contentRect ? {
        left: Math.max(scrollRect.left, contentRect.left),
        right: Math.min(scrollRect.right, contentRect.right),
        top: Math.max(scrollRect.top, contentRect.top),
        bottom: Math.min(scrollRect.bottom, contentRect.bottom),
      } : null;
      const latestButtonVisible = Boolean(latestButtonBox && latestButtonBox.width > 0 && latestButtonBox.height > 0 && window.getComputedStyle(latestBtn!).display !== "none" && window.getComputedStyle(latestBtn!).visibility !== "hidden");
      const latestIntersectsTranscript = latestButtonBox && transcriptContentRect
        ? latestButtonBox.left < transcriptContentRect.right && latestButtonBox.right > transcriptContentRect.left && latestButtonBox.top < transcriptContentRect.bottom && latestButtonBox.bottom > transcriptContentRect.top
        : null;

      return {
        viewport: vp,
        screen: sn,
        pageHorizontalOverflow,
        docScrollWidth,
        windowInnerWidth,
        messagesScrollOverflowsY,
        messagesScrollOverflowsX,
        messagesScrollWidth,
        messagesClientWidth,
        defaultFontSize,
        defaultLineHeight,
        messageBodyFontSize,
        messageBodyLineHeight,
        composerBox,
        composerFullyInside,
        composerBottomPadding,
        composerRespectsSafeArea,
        minTouchTarget,
        sub44pxTargets,
        codeBlockScroll,
        tableScroll,
        latestButtonVisible,
        latestButtonBox: latestButtonBox ? { x: Math.round(latestButtonBox.x), y: Math.round(latestButtonBox.y), width: Math.round(latestButtonBox.width), height: Math.round(latestButtonBox.height) } : null,
        transcriptContentBox: transcriptContentRect ? { x: Math.round(transcriptContentRect.left), y: Math.round(transcriptContentRect.top), width: Math.round(transcriptContentRect.right - transcriptContentRect.left), height: Math.round(transcriptContentRect.bottom - transcriptContentRect.top) } : null,
        modelSelectorBox,
        latestComposerGap,
        latestIntersectsTranscript,
      };
    },
    { vp: viewport, sn: screen }
  );
}

async function captureScreen(page: Page, viewport: string, screen: string): Promise<GeometryRecord> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const geo = await measureDOM(page, viewport, screen);
  allGeometryRecords.push(geo);
  if (geo.latestButtonVisible) {
    expect(geo.latestButtonBox!.width, `Latest button width at ${viewport}/${screen}`).toBeGreaterThanOrEqual(44);
    expect(geo.latestButtonBox!.height, `Latest button height at ${viewport}/${screen}`).toBeGreaterThanOrEqual(44);
    expect(geo.latestIntersectsTranscript, `Latest must not cover visible transcript at ${viewport}/${screen}`).toBe(false);
    expect(geo.latestComposerGap, `Latest button must leave 8px before composer at ${viewport}/${screen}`).toBeGreaterThanOrEqual(8);
  }
  const filePath = join(SCREENS_DIR, `${viewport}-${screen}.png`);
  await page.screenshot({ path: filePath });
  return geo;
}

test.describe("Screenshot inventory & geometry verification", () => {
  test.beforeAll(async ({ request }) => {
    mkdirSync(SCREENS_DIR, { recursive: true });
    await requireAppServer(request);
  });

  for (const vp of VIEWPORTS) {
    test(`capture inventory at ${vp.name}`, async ({ browser }) => {
      test.setTimeout(120_000);
      const fixture = harnessFixture();

      const context: BrowserContext = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dpr,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
      });

      const page: Page = await context.newPage();

      try {
        // (a) project list
        await login(page);
        await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
        await captureScreen(page, vp.name, "project-list");

        // (b) folder browser
        await page.getByRole("button", { name: "+ New Project" }).click();
        await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
        await expect(page.getByRole("button", { name: "+ New Folder" })).toBeVisible();
        await captureScreen(page, vp.name, "folder-browser");

        // (c) the "+ New Folder" name form
        await page.getByRole("button", { name: "+ New Folder" }).click();
        await expect(page.locator("#new-folder-name")).toBeVisible();
        await expect(page.getByRole("button", { name: "Create folder" })).toBeVisible();
        await captureScreen(page, vp.name, "new-folder-form");


        // Cancel new folder form, then cancel folder browser modal
        await page.locator("form").getByRole("button", { name: "Cancel" }).click();
        await page.locator(".modal-content > div").last().getByRole("button", { name: "Cancel" }).click();
        await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
        // (d) the dedicated paginated fixture directory and its Load more control
        await page.getByRole("button", { name: "+ New Project" }).click();
        await page.getByRole("button", { name: "Roots", exact: true }).click();
        await openFolderRow(page, "paged");
        const pageEntries = page.locator(".folder-item").filter({ hasText: /^📁 entry-\d{3}$/u });
        await expect(pageEntries).toHaveCount(100);
        await expect(page.getByText(/^📁 entry-001$/u)).toBeVisible();
        await expect(page.getByText(/^📁 entry-105$/u)).toHaveCount(0);
        await page.locator(".folder-browser-list").evaluate((element) => { element.scrollTop = element.scrollHeight; });
        const loadMore = page.getByRole("button", { name: "Load more" });
        await expect(loadMore).toBeVisible();
        await loadMore.scrollIntoViewIfNeeded();
        await expect(loadMore).toBeInViewport();
        if (["375x812", "390x844", "430x932"].includes(vp.name)) {
          await captureScreen(page, vp.name, "folder-browser-paginated");
        }
        await loadMore.click();
        await expect(pageEntries).toHaveCount(200);
        await expect(page.getByText(/^📁 entry-001$/u)).toBeVisible();
        await expect(page.getByText(/^📁 entry-105$/u)).toBeVisible();
        await page.getByRole("button", { name: "Cancel", exact: true }).click();

        // (d) conversation list (project detail with conversations + native sessions)
        await mockNativeSessions(page);
        await page.getByRole("heading", { name: "Seeded Fixture", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Seeded conversation", exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Native OMP Sessions" })).toBeVisible();
        await captureScreen(page, vp.name, "conversation-list");

        // Install Collab mock host before clicking conversation
        await page.route("**/api/models", async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, data: { models: ["preferred/model", "catalog/model"], source: "omp", reason: null } }),
          });
        });
        const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
        await page.getByRole("heading", { name: "Seeded conversation", exact: true }).click();

        const composer = page.locator("textarea.composer-input");
        await expect(composer).toBeVisible();
        await expect.poll(() => host.guestFrames.find((frame) => frame.t === "hello")?.writeToken).toMatch(/^[A-Za-z0-9_-]{22}$/u);
        await host.send({ ...welcomeFrame(false), state: { ...welcomeFrame(false).state, model: { id: "effective/model", name: "Effective model", provider: "test", contextWindow: 100000 } } });
        await expect(composer).toBeEnabled();

        await page.getByText("Conversation model settings").click();
        const modelInput = page.locator("#conversation-model");
        await expect(modelInput).toBeVisible();
        const modelBox = await modelInput.boundingBox();
        expect(modelBox).not.toBeNull();
        expect(modelBox!.height, "model selector must meet 44px touch minimum").toBeGreaterThanOrEqual(44);
        expect(modelBox!.width, "model selector must meet 44px touch minimum").toBeGreaterThanOrEqual(44);
        await expect(modelInput.locator('option[value="catalog/model"]')).toBeAttached();
        await expect(page.getByText("Preferred for next launch: preferred/model")).toBeVisible();
        await expect(page.getByText("Effective model reported now: effective/model")).toBeVisible();
        if (["375x812", "390x844", "430x932"].includes(vp.name)) {
          await captureScreen(page, vp.name, "model-settings-expanded");
          await modelInput.selectOption("catalog/model");
          await captureScreen(page, vp.name, "model-selector-populated");
          await modelInput.selectOption("preferred/model");
        }
        await page.getByText("Conversation model settings").click();
        // (e) a conversation with a short exchange
        const t1 = 1774435000000;
        await host.send({
          t: "entry",
          entry: createUserMessageEntry("entry-u1", "Check status of the test suite", t1),
        });
        await host.send({
          t: "entry",
          entry: createAssistantMessageEntry(
            "entry-a1",
            "All 42 tests passing across all packages. Ready for next task.",
            t1 + 1000
          ),
        });
        await expect(page.getByText("All 42 tests passing across all packages.")).toBeVisible();
        await captureScreen(page, vp.name, "short-exchange");

        // (f) a conversation with a LONG coding response
        const t2 = t1 + 2000;
        await host.send({
          t: "entry",
          entry: createUserMessageEntry("entry-u2", "Run the full verification audit and generate the report", t2),
        });
        await host.send({
          t: "entry",
          entry: createAssistantMessageEntry("entry-a2", LONG_CODING_RESPONSE_TEXT, t2 + 1000),
        });
        await host.send({
          t: "entry",
          entry: createToolResultEntry("entry-t1", "tool-vitest-run", "bash", REALISTIC_TOOL_OUTPUT, false, t2 + 2000),
        });
        await expect(page.getByRole("heading", { name: "Test Suite Audit & Session Verification Report" })).toBeVisible();
        // Scroll to top of long response
        await page.evaluate(() => {
          const el = document.querySelector(".messages-scroll");
          if (el) el.scrollTop = 0;
        });
        await page.waitForTimeout(200);
        await captureScreen(page, vp.name, "long-response");

        // (l) wide table (overflows viewport, scrolls internally)
        await page.evaluate(() => {
          const tbl = document.querySelector(".markdown-table-scroll");
          if (tbl) tbl.scrollIntoView({ block: "center" });
        });
        await page.waitForTimeout(200);
        const wideTableGeo = await captureScreen(page, vp.name, "wide-table");
        expect(wideTableGeo.pageHorizontalOverflow, "page must NOT scroll horizontally with wide table").toBe(false);
        if (vp.width <= 390) {
          expect(
            wideTableGeo.tableScroll?.overflows,
            `wide table must scroll internally on ${vp.name} (scrollWidth: ${wideTableGeo.tableScroll?.scrollWidth}, clientWidth: ${wideTableGeo.tableScroll?.clientWidth})`
          ).toBe(true);
        }

        // (m) long unbroken string in prose (wraps without page-level horizontal overflow)
        await page.evaluate(() => {
          const headings = Array.from(document.querySelectorAll("h4"));
          const unbrokenHeading = headings.find((h) => h.textContent?.includes("Canonical Snapshot Checkpoint URL"));
          if (unbrokenHeading) unbrokenHeading.scrollIntoView({ block: "center" });
        });
        await page.waitForTimeout(200);
        const unbrokenGeo = await captureScreen(page, vp.name, "unbroken-string");
        expect(unbrokenGeo.pageHorizontalOverflow, "page must NOT scroll horizontally with 300-char unbroken string").toBe(false);

        // (g) a large code block
        await page.evaluate(() => {
          const pre = document.querySelector(".markdown-code-block pre");
          if (pre) pre.scrollIntoView({ block: "center" });
        });
        await page.waitForTimeout(200);
        await captureScreen(page, vp.name, "large-code-block");

        // (h) expanded tool details
        const summary = page.locator(".message-card.tool summary");
        await summary.click();
        await page.evaluate(() => {
          const card = document.querySelector(".message-card.tool");
          if (card) card.scrollIntoView({ block: "start" });
        });
        await page.waitForTimeout(200);
        await captureScreen(page, vp.name, "expanded-tool-details");

        // (i) the subagent panel
        await host.send({ t: "agents", agents: MOCK_SUBAGENTS });
        const agentsBtn = page.getByRole("button", { name: "Agents (2)" });
        const header = page.locator(".app-header");
        await expect.poll(() => header.locator(".conversation-header-title").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(60);
        await expect.poll(() => header.locator(".conversation-header-actions").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(50);
        await expect(agentsBtn).toBeVisible();
        await agentsBtn.click();
        await expect(page.locator(".modal-overlay")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Subagents (2)" })).toBeVisible();
        await captureScreen(page, vp.name, "subagent-panel");

        // Close subagent panel
        await page.locator(".modal-content button.ghost", { hasText: "✕" }).click();
        await expect(page.locator(".modal-overlay")).toBeHidden();

        // (j) the slash-command suggestion list while typing `/`
        await composer.fill("/");
        await expect(page.locator(".composer-suggestions")).toBeVisible();
        await captureScreen(page, vp.name, "slash-suggestions");
        await composer.fill("");
        await expect(page.locator(".composer-suggestions")).toBeHidden();
        await composer.fill("/model");
        await page.getByRole("button", { name: "Send" }).click();
        await expect(page.locator(".slash-command-intercept")).toBeVisible();
        if (["375x812", "390x844", "430x932"].includes(vp.name)) {
          await captureScreen(page, vp.name, "slash-command-intercepted");
        }
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await composer.fill("");

        // (k) the approval request card
        await host.send({ t: "ui-request", request: MOCK_APPROVAL_REQUEST });
        await expect(page.getByRole("heading", { name: "Approval Requested" })).toBeVisible();
        await page.evaluate(() => {
          const card = document.querySelector(".card");
          if (card) card.scrollIntoView({ block: "center" });
        });
        await page.waitForTimeout(200);
        await captureScreen(page, vp.name, "approval-request");
        await host.send(welcomeFrame(true, true));
        await expect(page.getByText(/Read-only view/)).toBeVisible();
        await expect(page.locator("textarea.composer-input")).toBeDisabled();
        await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0);
        if (["375x812", "390x844", "430x932"].includes(vp.name)) {
          await captureScreen(page, vp.name, "read-only-welcome");
        }
        await host.send({ t: "ui-request", request: { ...MOCK_APPROVAL_REQUEST, reqId: 102 } });
        await expect(page.getByRole("button", { name: /Deny/ })).toHaveCount(0);
        await expect(page.getByText("Read-only link — this request cannot be answered here.")).toBeVisible();
        if (["375x812", "390x844", "430x932"].includes(vp.name)) {
          await captureScreen(page, vp.name, "read-only-conversation");
        }

        await host.send({ t: "ui-request-end", reqId: 102 });
        await host.send(welcomeFrame(false));
        await expect(page.getByText(/Read-only view/)).toBeHidden();
        await expect(composer).toBeEnabled();
        await composer.fill("");
        await expect(page.locator(".composer-suggestions")).toBeHidden();

        // Interaction assertions on primary mobile viewport (390x844)
        if (vp.name === "390x844") {
          // Add independent tool and agent state for scroll-preservation checks.
          await host.send({
            t: "entry",
            entry: createToolResultEntry("scroll-tool", "scroll-tool-call", "bash", REALISTIC_TOOL_OUTPUT, false, Date.now() + 100),
          });
          await expect(page.locator(".message-card.tool summary")).toBeVisible();
          await host.send({ t: "agents", agents: MOCK_SUBAGENTS });
          await expect(agentsBtn).toBeVisible();
          // The read-only welcome replaces transcript history; restore enough content for scroll tests.
          for (let index = 0; index < 24; index++) {
            await host.send({
              t: "entry",
              entry: createAssistantMessageEntry(`scroll-fixture-${index}`, `History segment ${index}: ${"reading older content ".repeat(14)}`, Date.now() + index),
            });
          }
          await expect(page.locator(".message-card.assistant")).toHaveCount(24);
          const ms = page.locator(".messages-scroll");
          await ms.evaluate((el) => {
            el.scrollTop = 150;
            el.dispatchEvent(new Event("scroll"));
          });
          await page.waitForTimeout(100);
          const scrollTopBefore = await ms.evaluate((el) => el.scrollTop);

          await host.send({
            t: "entry",
            entry: createAssistantMessageEntry(
              "entry-stream-followup",
              "Additional streamed content arriving while reader is reviewing earlier paragraphs.",
              Date.now()
            ),
          });
          await page.waitForTimeout(300);

          const scrollTopAfter = await ms.evaluate((el) => el.scrollTop);
          const scrollPassed = Math.abs(scrollTopAfter - scrollTopBefore) <= 2;
          expect(scrollPassed, `scroll position must NOT jump when streaming content arrives while scrolled up (before: ${scrollTopBefore}, after: ${scrollTopAfter})`).toBe(true);

          // (ii) tap "↓ Latest" -> assert returns to tail
          const latestBtn = page.locator(".latest-button");
          await expect(latestBtn).toBeVisible({ timeout: 5000 });
          const latestGeometry = await latestBtn.evaluate((button) => {
            const b = button.getBoundingClientRect();
            const t = document.querySelector(".messages-scroll")!.getBoundingClientRect();
            return { box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, intersects: b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top };
          });
          expect(latestGeometry.box.height).toBeGreaterThanOrEqual(44);
          expect(latestGeometry.box.width).toBeGreaterThanOrEqual(44);
          expect(latestGeometry.intersects).toBe(false);
          await latestBtn.click();
          await page.waitForTimeout(200);
          const distToTail = await ms.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
          const latestPassed = distToTail <= 20;
          expect(distToTail, "tap Latest button must return scroll position to tail").toBeLessThanOrEqual(20);
          await expect(latestBtn).toBeHidden();
          const latestNote = "Tapped '↓ Latest' button; scroll returned to tail.";

          // (iii) expand tool details and assert reader scroll position is preserved
          await summary.scrollIntoViewIfNeeded();
          await page.waitForTimeout(100);
          const toolScrollBefore = await page.evaluate(
            () => window.scrollY || document.documentElement.scrollTop || (document.querySelector(".messages-scroll") as HTMLElement).scrollTop
          );
          // Click summary while already in view to toggle details
          await summary.click();
          await page.waitForTimeout(150);
          const toolScrollAfter = await page.evaluate(
            () => window.scrollY || document.documentElement.scrollTop || (document.querySelector(".messages-scroll") as HTMLElement).scrollTop
          );
          const toolPreserved = Math.abs(toolScrollAfter - toolScrollBefore) <= 5;
          expect(toolPreserved, `expanding tool details must preserve reader scroll position (before: ${toolScrollBefore}, after: ${toolScrollAfter})`).toBe(true);

          // (iv) open and close subagent panel and assert chat scroll position is unchanged
          const chatScrollBefore = await page.evaluate(
            () => window.scrollY || document.documentElement.scrollTop || (document.querySelector(".messages-scroll") as HTMLElement).scrollTop
          );
          await agentsBtn.click();
          await expect(page.locator(".modal-overlay")).toBeVisible();
          await page.locator(".modal-content button.ghost", { hasText: "✕" }).click();
          await expect(page.locator(".modal-overlay")).toBeHidden();
          const chatScrollAfter = await page.evaluate(
            () => window.scrollY || document.documentElement.scrollTop || (document.querySelector(".messages-scroll") as HTMLElement).scrollTop
          );
          const modalPreserved = Math.abs(chatScrollAfter - chatScrollBefore) <= 2;
          expect(modalPreserved, "modal open/close must preserve chat scroll position").toBe(true);

          // (v) focus composer and assert still fully visible
          await composer.focus();
          const composerBox = await composer.boundingBox();
          expect(composerBox).not.toBeNull();
          const compPassed =
            composerBox!.y >= 0 && composerBox!.y + composerBox!.height <= vp.height + 1;
          expect(compPassed, "composer must remain fully visible when focused").toBe(true);

          interactionResults = {
            scrollUpNoJump: { before: scrollTopBefore, after: scrollTopAfter, passed: scrollPassed },
            tapLatestReturnsToTail: { distanceToTail: distToTail, passed: latestPassed, note: latestNote },
            expandToolPreservesScroll: { before: toolScrollBefore, after: toolScrollAfter, passed: toolPreserved },
            subagentPanelPreservesScroll: { before: chatScrollBefore, after: chatScrollAfter, passed: modalPreserved },
            composerFocusVisible: {
              y: Math.round(composerBox!.y),
              height: Math.round(composerBox!.height),
              viewportHeight: vp.height,
              passed: compPassed,
              note: "Mobile software keyboard cannot be simulated in headless Playwright; marked keyboard-unverified.",
            },
          };
        }
      } finally {
        await context.close();
      }
    });
  }

  test.afterAll(() => {
    // Generate manifest.md
    let md = `# Screenshot Inventory & Geometry Report\n\n`;
    md += `Generated: ${new Date().toISOString()}\n`;
    md += `Total screenshots: ${allGeometryRecords.length}\n`;
    md += `Viewports tested: ${VIEWPORTS.map((v) => v.name).join(", ")}\n\n`;

    md += `## 1. Verified Interactions (Tested at 390×844)\n\n`;
    if (interactionResults) {
      md += `| Interaction | Result | Measurement | Status |\n`;
      md += `| :--- | :--- | :--- | :--- |\n`;
      md += `| (i) Scroll up in transcript, stream more content | Scroll position did not jump | Before: ${interactionResults.scrollUpNoJump.before}px, After: ${interactionResults.scrollUpNoJump.after}px | **PASS** |\n`;
      const latestStatus = interactionResults.tapLatestReturnsToTail.passed
        ? `**PASS**`
        : `**UNVERIFIED (button hidden)**`;
      const latestDesc = interactionResults.tapLatestReturnsToTail.passed
        ? `Returned to transcript tail`
        : `Button not rendered by app`;
      const latestMeas = interactionResults.tapLatestReturnsToTail.passed
        ? `Remaining distance to tail: ${interactionResults.tapLatestReturnsToTail.distanceToTail}px`
        : `${interactionResults.tapLatestReturnsToTail.note}`;
      md += `| (ii) Tap "↓ Latest" button | ${latestDesc} | ${latestMeas} | ${latestStatus} |\n`;
      md += `| (iii) Expand tool details | Reader scroll position preserved | Before: ${interactionResults.expandToolPreservesScroll.before}px, After: ${interactionResults.expandToolPreservesScroll.after}px | **PASS** |\n`;
      md += `| (iv) Open & close subagent panel | Chat scroll position unchanged | Before: ${interactionResults.subagentPanelPreservesScroll.before}px, After: ${interactionResults.subagentPanelPreservesScroll.after}px | **PASS** |\n`;
      md += `| (v) Focus composer | Fully inside viewport | y: ${interactionResults.composerFocusVisible.y}px, height: ${interactionResults.composerFocusVisible.height}px (viewport ${interactionResults.composerFocusVisible.viewportHeight}px) | **PASS (keyboard-unverified)** |\n\n`;
      md += `*Note on (v):* ${interactionResults.composerFocusVisible.note}\n\n`;
    }

    md += `## 2. Layout Note: Transcript Scrolling & "Fits Vertically"\n\n`;
    md += `In the initial pre-fix measurement, \`.messages-scroll\` reported \`no-scroll\` (\`scrollHeight === clientHeight = 3325px\`) because \`.conversation-screen\` had \`flex: 1 1 0%\` inside an unconstrained \`#root\`, expanding the entire transcript to the content height. In that state, the transcript container was NOT scrolling internally; the entire browser window/document scrolled instead, preventing the detached condition from ever triggering. After the layout fix (\`flex: 0 0 100dvh\`), \`.messages-scroll\` is constrained to the viewport (\`clientHeight: ~650px\`, \`scrollHeight: ~3325px\`) and correctly scrolls internally (\`scroll-Y\`), allowing the "↓ Latest" button to render and function as designed.\n\n`;
    md += `## 3. Geometry Table Per Screen\n\n`;
    md += `| Viewport | Screen | Page H-Overflow | .messages-scroll | Body Font / Line-H | Composer Bounding Box | Model Selector Box | Latest-to-Composer Gap | Min Touch Target | Code Scroll/Client | Table Scroll/Client | Latest Btn |\n`;
    md += `| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    for (const r of allGeometryRecords) {
      const hOverflow = r.pageHorizontalOverflow ? `⚠️ YES (${r.docScrollWidth} > ${r.windowInnerWidth})` : "NO";
      const msgScroll =
        r.messagesScrollOverflowsY !== null
          ? `${r.messagesScrollOverflowsY ? "scroll-Y" : "no-scroll"} (${r.messagesClientWidth}px)`
          : "N/A";
      const font = r.messageBodyFontSize
        ? `${r.messageBodyFontSize} / ${r.messageBodyLineHeight}`
        : `${r.defaultFontSize} / ${r.defaultLineHeight}`;
      const comp = r.composerBox
        ? `${r.composerBox.width}×${r.composerBox.height}@y=${r.composerBox.y} (${r.composerFullyInside ? "in-vp" : "clipped"})`
        : "N/A";
      const model = r.modelSelectorBox ? `${r.modelSelectorBox.width}×${r.modelSelectorBox.height}@(${r.modelSelectorBox.x}, ${r.modelSelectorBox.y})` : "N/A";
      const touch = r.minTouchTarget
        ? `${r.minTouchTarget.width}×${r.minTouchTarget.height} (\`${r.minTouchTarget.selector}\`)`
        : "N/A";
      const code = r.codeBlockScroll
        ? `${r.codeBlockScroll.scrollWidth} / ${r.codeBlockScroll.clientWidth} (${r.codeBlockScroll.overflows ? "scroll-X" : "fits"})`
        : "N/A";
      const table = r.tableScroll
        ? `${r.tableScroll.scrollWidth} / ${r.tableScroll.clientWidth} (${r.tableScroll.overflows ? "scroll-X" : "fits"})`
        : "N/A";
      const latest = r.latestButtonVisible ? "Visible" : "Hidden";
      const latestGap = r.latestComposerGap === null ? "N/A" : `${r.latestComposerGap}px`;

      md += `| ${r.viewport} | ${r.screen} | ${hOverflow} | ${msgScroll} | ${font} | ${comp} | ${model} | ${latestGap} | ${touch} | ${code} | ${table} | ${latest} |\n`;
    }

    md += `\n## 3. Detailed Screenshot Inventory\n\n`;
    for (const r of allGeometryRecords) {
      const fileName = `${r.viewport}-${r.screen}.png`;
      md += `### \`${fileName}\`\n\n`;
      md += `- **Viewport**: ${r.viewport}\n`;
      md += `- **Screen**: ${r.screen}\n`;
      md += `- **Page-level Horizontal Overflow**: ${r.pageHorizontalOverflow ? `YES (doc: ${r.docScrollWidth}px, window: ${r.windowInnerWidth}px)` : "None (fits window)"}\n`;
      md += `- **Transcript Container (.messages-scroll)**: ${r.messagesScrollOverflowsY !== null ? (r.messagesScrollOverflowsY ? "Overflows vertically (scrollable)" : "Fits vertically") : "Not present"}\n`;
      md += `- **Body Text Typography**: font-size: ${r.messageBodyFontSize || r.defaultFontSize}, line-height: ${r.messageBodyLineHeight || r.defaultLineHeight}\n`;
      if (r.composerBox) {
        md += `- **Composer Bounding Box**: ${r.composerBox.width}px × ${r.composerBox.height}px at (x: ${r.composerBox.x}, y: ${r.composerBox.y}), fully inside viewport: ${r.composerFullyInside ? "YES" : "NO"}, bottom padding: ${r.composerBottomPadding}\n`;
      }
      if (r.latestButtonBox) md += `- **Latest button box**: ${r.latestButtonBox.width}px × ${r.latestButtonBox.height}px at (${r.latestButtonBox.x}, ${r.latestButtonBox.y})\n`;
      if (r.latestComposerGap !== null) md += `- **Latest-to-composer gap**: ${r.latestComposerGap}px\n`;
      if (r.modelSelectorBox) md += `- **Model selector box**: ${r.modelSelectorBox.width}px × ${r.modelSelectorBox.height}px at (${r.modelSelectorBox.x}, ${r.modelSelectorBox.y})\n`;
      if (r.transcriptContentBox) md += `- **Transcript box**: ${r.transcriptContentBox.width}px × ${r.transcriptContentBox.height}px at (${r.transcriptContentBox.x}, ${r.transcriptContentBox.y}); Latest intersection: ${r.latestIntersectsTranscript}\n`;
      if (r.codeBlockScroll) {
        md += `- **Code Block Scroll Geometry**: scrollWidth: ${r.codeBlockScroll.scrollWidth}px, clientWidth: ${r.codeBlockScroll.clientWidth}px (horizontal scroll: ${r.codeBlockScroll.overflows ? "YES" : "NO"})\n`;
      }
      if (r.tableScroll) {
        md += `- **Table Scroll Geometry**: scrollWidth: ${r.tableScroll.scrollWidth}px, clientWidth: ${r.tableScroll.clientWidth}px (horizontal scroll: ${r.tableScroll.overflows ? "YES" : "NO"})\n`;
      }
      if (r.minTouchTarget) {
        md += `- **Minimum Touch Target**: ${r.minTouchTarget.width}px × ${r.minTouchTarget.height}px on \`${r.minTouchTarget.selector}\` ("${r.minTouchTarget.text}")\n`;
      }
      if (r.sub44pxTargets.length > 0) {
        md += `- **Sub-44px Touch Targets (${r.sub44pxTargets.length})**:\n`;
        for (const t of r.sub44pxTargets.slice(0, 5)) {
          md += `  - \`${t.selector}\` ("${t.text}"): ${t.width}px × ${t.height}px\n`;
        }
        if (r.sub44pxTargets.length > 5) {
          md += `  - ... and ${r.sub44pxTargets.length - 5} more\n`;
        }
      }
      md += `\n`;
    }

    writeFileSync(MANIFEST_PATH, md, "utf8");
  });
});
