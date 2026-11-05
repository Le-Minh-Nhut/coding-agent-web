import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, type Page } from "@playwright/test";
import {
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
  createUserMessageEntry,
  MOCK_SUBAGENTS,
  MOCK_APPROVAL_REQUEST,
  type MockCollabHost,
} from "./fixture.js";

/**
 * Round 54 geometry. DOM numbers only — this lane cannot read pixels, so nothing
 * here inspects a screenshot; the PNGs are written to the scratch dir for the
 * owner, and pixel review is explicitly left to a separate pass.
 *
 * The claims asserted (from the design spec):
 *  - the recovery summary never exceeds ~64px, and the transcript stays scrollable
 *    with 1 long record and with 3;
 *  - the agents screen occupies the full viewport and the composer is not on it;
 *  - the header has no horizontal overflow at 320px;
 *  - the dashboard row is bounded;
 *  - the named design tokens resolve to their specified values.
 */

const SCREENS_DIR = process.env.CAW_SCREENS_DIR ?? join(tmpdir(), "caw-screens");
const MOBILE = { width: 390, height: 844 };
const NARROW = { width: 320, height: 568 };

const VIEWPORT = { width: 390, height: 844 };

/** The design tokens, and the value each must resolve to. */
const TOKENS: Record<string, string> = {
  "--app-bg": "#050505",
  "--surface-primary": "#1b1b1b",
  "--surface-secondary": "#242424",
  "--text-primary": "#f5f5f5",
  "--text-secondary": "#a5a5a5",
  "--text-muted": "#909090",
  "--success": "#22c55e",
  "--danger": "#dc2626",
  "--danger-text": "#f87171",
  "--warning": "#f59e0b",
  "--radius-card": "16px",
  "--radius-message": "18px",
  "--radius-composer": "16px",
  "--touch-min": "44px",
};

const LONG_PROMPT = `ROUND54_LONG ${"a sentence that wraps over and over on a phone screen ".repeat(90)} ROUND54_END`;

async function box(page: Page, selector: string) {
  const element = page.locator(selector).first();
  if ((await element.count()) === 0) return null;
  return await element.boundingBox();
}

/** Send a prompt, then refuse it while a newer draft keeps it in the recovery list. */
async function seedRefusedPrompt(page: Page, host: MockCollabHost, text: string): Promise<void> {
  const composer = page.locator("textarea.composer-input");
  await composer.fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => host.prompts.length).toBeGreaterThan(0);
  await composer.fill("NEWER_DRAFT_NOT_SENT");
  await host.send({ t: "error", message: "prompting is unavailable until the host finishes starting up" });
}

test.beforeAll(async ({ request }) => {
  mkdirSync(SCREENS_DIR, { recursive: true });
  await requireAppServer(request);
});

/**
 * m3 — the sheet's own box rules must beat `.modal-content`.
 *
 * `.modal-content` is declared LATER in styles.css with `max-width: 500px` and
 * `border-radius: var(--radius)` (8px) at equal specificity, so a single-class
 * `.recovery-sheet` / `.model-sheet` lost on source order. Measured here, in the
 * real browser, which is the only place the cascade can be checked.
 */
test("both bottom sheets keep their own box rules against .modal-content", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(MOBILE);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await seedRefusedPrompt(page, host, "ROUND54_SHEET_GEOMETRY");

  await page.locator(".recovery-summary").click();
  const sheet = page.locator(".recovery-sheet");
  await expect(sheet).toBeVisible();

  const measured = await page.evaluate(() => {
    const el = document.querySelector(".recovery-sheet") as HTMLElement;
    const overlay = document.querySelector(".recovery-sheet-overlay") as HTMLElement;
    const style = getComputedStyle(el);
    return {
      maxWidth: style.maxWidth,
      borderRadius: style.borderTopLeftRadius,
      bottomRadius: style.borderBottomLeftRadius,
      overlayAlign: getComputedStyle(overlay).alignItems,
      paddingBottom: style.paddingBottom,
    };
  });
  console.log("[round54 recovery sheet geometry]", JSON.stringify(measured));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-sheet-geometry.png") });

  // The values the stylesheet intends — NOT `.modal-content`'s 500px / 8px, which is
  // what the cascade was silently substituting before the specificity fix.
  expect(measured.maxWidth, "sheet width is its own, not .modal-content's 500px").toBe("560px");
  expect(measured.borderRadius, "top radius is the card token, not .modal-content's 8px").toBe("16px");
  expect(measured.bottomRadius, "only the top corners are rounded on a bottom sheet").toBe("0px");
  expect(measured.overlayAlign, "bottom-anchored").toBe("flex-end");

  // The model sheet carries the same pair of rules and the same shadowing risk, so it
  // is measured too (its own width is 520px).
  await page.locator(".recovery-sheet [aria-label='Close prompt review']").click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Model settings" }).click();
  const modelSheet = page.locator(".model-sheet");
  await expect(modelSheet).toBeVisible();
  const modelMeasured = await page.evaluate(() => {
    const el = document.querySelector(".model-sheet") as HTMLElement;
    const overlay = document.querySelector(".model-sheet-overlay") as HTMLElement;
    const style = getComputedStyle(el);
    return {
      maxWidth: style.maxWidth,
      borderRadius: style.borderTopLeftRadius,
      bottomRadius: style.borderBottomLeftRadius,
      overlayAlign: getComputedStyle(overlay).alignItems,
    };
  });
  console.log("[round54 model sheet geometry]", JSON.stringify(modelMeasured));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-sheet-geometry.png") });

  expect(modelMeasured.maxWidth, "model sheet width is its own, not 500px").toBe("520px");
  // Its top radius is `var(--radius)` (8px) by design, which is NOT a discriminator —
  // `.modal-content` sets the same value. The bottom corners are: `.modal-content`
  // rounds all four, this rule squares the bottom two, so 0px proves the fix.
  expect(modelMeasured.bottomRadius, "model sheet's bottom corners are square, not .modal-content's 8px").toBe("0px");
  expect(modelMeasured.overlayAlign, "model sheet is bottom-anchored").toBe("flex-end");
});

/**
 * m8 — the transcript budget must hold in the DEGRADED configuration too.
 *
 * The bounded-row assertions above run on a healthy screen. The real risk is the
 * hostile one: the smallest phone, the maximum honest banner stack, and the longest
 * prompts retained at the review ceiling. If those rows ever returned to full width
 * or full text, they would starve the transcript exactly as P1-A did — and an
 * assertion that only runs where it cannot fail would not notice.
 */
test("the transcript keeps a usable height under a hostile banner stack at 320x568", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  // iPhone SE 1st-gen class: the shortest screen the app is expected to serve.
  await page.setViewportSize({ width: 320, height: 568 });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  // Every row that legitimately stays a full-width banner, at once: a routine
  // warning notice, the review summary, the connecting banner and the startup
  // banner — plus a reason paragraph. This is the degraded configuration.
  await host.send({ t: "event", event: { type: "notice", level: "warning", message: "Host reports a starting worker.", source: "collab" } });
  await seedRefusedPrompt(page, host, LONG_PROMPT);
  await expect(page.locator(".recovery-summary")).toBeVisible();
  // The reason paragraph ("Stop session unavailable: …") renders alongside, which is
  // the other kind of permanent row a narrow screen has to budget for.
  await expect(page.locator(".handoff-reason").first()).toBeVisible();

  const measured = await page.evaluate(() => {
    const scroll = document.querySelector(".messages-scroll") as HTMLElement;
    const summary = document.querySelector(".recovery-summary") as HTMLElement | null;
    const stack = [...document.querySelectorAll(".banner, .notice-row, .recovery-summary, .handoff-reason, .approval-card")]
      .map((el) => Math.round(el.getBoundingClientRect().height));
    return {
      transcriptHeight: Math.round(scroll.getBoundingClientRect().height),
      transcriptScrollable: scroll.scrollHeight >= scroll.clientHeight,
      summaryHeight: summary === null ? 0 : Math.round(summary.getBoundingClientRect().height),
      bannerStackHeight: stack.reduce((sum, height) => sum + height, 0),
      bannerRows: stack.length,
      appHeight: window.innerHeight,
      // The prompt text must not be in the column even here.
      promptTextInColumn: (document.querySelector(".conversation-column") as HTMLElement).textContent!.includes("ROUND54_LONG"),
    };
  });
  console.log("[round54 hostile banner stack]", JSON.stringify(measured));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-hostile-banner-stack.png") });

  // The invariant, in the configuration where it can actually fail.
  expect(measured.transcriptHeight, "the transcript survives the worst banner stack").toBeGreaterThan(100);
  expect(measured.transcriptScrollable).toBe(true);
  expect(measured.summaryHeight, "the review row is still bounded here").toBeLessThanOrEqual(64);
  expect(measured.promptTextInColumn, "the prompt never returns to the column").toBe(false);
});

test("design tokens resolve to their specified values", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(VIEWPORT);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  const resolved = await page.evaluate((names: string[]) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
  }, Object.keys(TOKENS));

  console.log("[round54 tokens]", JSON.stringify(resolved));
  for (const [name, expected] of Object.entries(TOKENS)) {
    expect(resolved[name], `${name} must resolve`).toBe(expected);
  }
});

test("an assistant row has no card box, and the app background is the near-black canvas", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(VIEWPORT);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send({ t: "entry", entry: createUserMessageEntry("r54-u", "hello there", Date.now()) });
  await host.send({ t: "entry", entry: { id: "r54-a", type: "message", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "reply body" }], model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: Date.now() } } });
  await expect(page.getByText("reply body")).toBeVisible();

  const measured = await page.evaluate(() => {
    const assistant = document.querySelector(".message-card.assistant") as HTMLElement | null;
    const user = document.querySelector(".message-card.user") as HTMLElement | null;
    const body = getComputedStyle(document.body);
    const asst = assistant ? getComputedStyle(assistant) : null;
    const usr = user ? getComputedStyle(user) : null;
    return {
      appBg: body.backgroundColor,
      assistantBackground: asst?.backgroundColor ?? null,
      assistantBorderColor: asst?.borderTopColor ?? null,
      userRadius: usr?.borderTopLeftRadius ?? null,
    };
  });
  console.log("[round54 message chrome]", JSON.stringify(measured));
  expect(measured.appBg).toBe("rgb(5, 5, 5)");
  // Minimal chrome: transparent background and transparent border on a reply.
  expect(measured.assistantBackground).toBe("rgba(0, 0, 0, 0)");
  expect(measured.userRadius).toBe("18px");
});

test("the recovery summary is one bounded row and the transcript stays usable with a long prompt", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(MOBILE);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  const summary = page.locator(".recovery-summary");
  await expect(summary).toHaveCount(0);

  await seedRefusedPrompt(page, host, LONG_PROMPT);
  await expect(summary).toBeVisible();

  const geometry = await page.evaluate(() => {
    const row = document.querySelector(".recovery-summary") as HTMLElement;
    const scroll = document.querySelector(".messages-scroll") as HTMLElement;
    const column = document.querySelector(".conversation-column") as HTMLElement;
    return {
      summaryHeight: Math.round(row.getBoundingClientRect().height),
      summaryWidth: Math.round(row.getBoundingClientRect().width),
      // P1-A: the prompt text must NOT be in the conversation column at all.
      promptTextPresent: column.textContent!.includes("ROUND54_LONG"),
      summaryText: row.textContent,
      transcriptHeight: Math.round(scroll.getBoundingClientRect().height),
      transcriptScrollable: scroll.scrollHeight >= scroll.clientHeight,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  console.log("[round54 recovery summary]", JSON.stringify(geometry));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-recovery-summary-1.png") });

  expect(geometry.summaryHeight, "recovery summary must never exceed 64px").toBeLessThanOrEqual(64);
  expect(geometry.summaryHeight, "and must meet the 44px touch minimum").toBeGreaterThanOrEqual(44);
  expect(geometry.promptTextPresent, "the full prompt must not be in the conversation column").toBe(false);
  expect(geometry.summaryText).toContain("1 prompt needs review");
  expect(geometry.transcriptHeight, "the transcript keeps the remaining viewport").toBeGreaterThan(200);
  expect(geometry.documentOverflow).toBe(false);

  // Two more records: the row stays the same bounded height (counts change only).
  await seedRefusedPrompt(page, host, `${LONG_PROMPT} B`);
  await seedRefusedPrompt(page, host, `${LONG_PROMPT} C`);
  const three = await page.evaluate(() => {
    const row = document.querySelector(".recovery-summary") as HTMLElement;
    const scroll = document.querySelector(".messages-scroll") as HTMLElement;
    return {
      summaryHeight: Math.round(row.getBoundingClientRect().height),
      summaryText: row.textContent,
      transcriptHeight: Math.round(scroll.getBoundingClientRect().height),
      recordsTextInColumn: (document.querySelector(".conversation-column") as HTMLElement).textContent!.includes("ROUND54_LONG"),
    };
  });
  console.log("[round54 recovery summary x3]", JSON.stringify(three));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-recovery-summary-3.png") });
  expect(three.summaryHeight, "still bounded with 3 long records").toBeLessThanOrEqual(64);
  expect(three.summaryText).toContain("3 prompts need review");
  expect(three.transcriptHeight).toBeGreaterThan(150);
  expect(three.recordsTextInColumn).toBe(false);

  // The records are all reachable in the sheet, complete.
  await summary.click();
  const sheet = await page.evaluate(() => {
    const sheetElement = document.querySelector(".recovery-sheet") as HTMLElement;
    return {
      records: sheetElement.querySelectorAll(".recovery-record").length,
      text: sheetElement.textContent!,
      height: Math.round(sheetElement.getBoundingClientRect().height),
      viewportHeight: window.innerHeight,
    };
  });
  console.log("[round54 recovery sheet]", JSON.stringify({ records: sheet.records, height: sheet.height, viewportHeight: sheet.viewportHeight }));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-recovery-sheet.png") });
  expect(sheet.records).toBe(3);
  expect(sheet.text).toContain("ROUND54_LONG");
  expect(sheet.text).toContain("ROUND54_END");
});

test("the agents screen fills the viewport and the composer is not on it", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(MOBILE);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send({ t: "agents", agents: MOCK_SUBAGENTS });

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /^Agents \(/ }).click();
  await expect(page.getByRole("heading", { name: /Agents \(/ })).toBeVisible();

  const measured = await page.evaluate(() => {
    const layer = document.querySelector(".agents-layer") as HTMLElement;
    const screen = document.querySelector(".agents-center") as HTMLElement;
    const composer = document.querySelector(".composer-container") as HTMLElement | null;
    const layerBox = layer.getBoundingClientRect();
    const composerBox = composer?.getBoundingClientRect() ?? null;
    // The conversation stays MOUNTED underneath (that is what preserves the socket,
    // draft and scroll), so the composer element still exists with a box. "Not on
    // screen" therefore means *occluded*: a hit test at the composer's own centre
    // must land on the opaque layer, never on the composer.
    const composerCovered = composerBox === null || (() => {
      const hit = document.elementFromPoint(composerBox.left + composerBox.width / 2, composerBox.top + composerBox.height / 2);
      return hit === null || layer.contains(hit) || hit === layer;
    })();
    return {
      layerTop: Math.round(layerBox.top),
      layerLeft: Math.round(layerBox.left),
      layerWidth: Math.round(layerBox.width),
      layerHeight: Math.round(layerBox.height),
      layerBackground: getComputedStyle(layer).backgroundColor,
      screenScrollable: screen.scrollHeight >= screen.clientHeight,
      composerCovered,
      composerInert: document.querySelector(".conversation-column")!.hasAttribute("inert"),
      // The layer must not be a child of the conversation column.
      layerInsideColumn: layer.closest(".conversation-column") !== null,
    };
  });
  console.log("[round54 agents layer]", JSON.stringify(measured));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-agents-layer.png") });

  expect(measured.layerTop).toBe(0);
  expect(measured.layerLeft).toBe(0);
  expect(measured.layerWidth).toBe(MOBILE.width);
  expect(measured.layerHeight).toBe(MOBILE.height);
  expect(measured.layerBackground).toBe("rgb(5, 5, 5)");
  expect(measured.layerInsideColumn).toBe(false);
  expect(measured.composerInert, "the covered conversation is inert").toBe(true);
  expect(measured.composerCovered, "the composer must not be on the agents screen").toBe(true);

  // Browser Back returns to the conversation.
  await page.goBack();
  await expect(page.locator(".agents-layer")).toHaveCount(0);
  await expect(page.locator("textarea.composer-input")).toBeVisible();
});

/**
 * Journey C — real browser history over the agents layer.
 *
 * The jsdom suite (tests/web/round54-agents-layer.test.tsx) dispatches synthetic
 * `popstate` events, which proves the mapping but not browser semantics: it cannot
 * show that Chromium *keeps* a Forward entry after a Back, nor that Back from a
 * DETAIL lands on the LIST instead of skipping to the conversation underneath.
 * Only a real Back/Forward pair does that, so it is asserted here.
 *
 * The conversation must also survive the whole walk: it stays mounted under the
 * layer, and the layer's history entries are the app's own, so no step may
 * remount it. Two markers prove it — the document's `performance.timeOrigin`
 * (a document navigation would change it) and a marker stamped on the
 * `.conversation-screen` element itself (a React remount would produce a new
 * element without it).
 */
test("browser Back and Forward walk the agents list, the detail and the conversation in order", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(MOBILE);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send({ t: "agents", agents: MOCK_SUBAGENTS });
  // A real transcript row: its text is the user-visible proof the same conversation
  // is still on screen, unmounted-rendered from scratch would lose it (a remount
  // re-reads the snapshot, this row only ever arrived over the live socket).
  await host.send({ t: "entry", entry: createUserMessageEntry("journey-c-row", "JOURNEY_C_MARKER_ROW", Date.now()) });
  const markerRow = page.getByText("JOURNEY_C_MARKER_ROW");
  await expect(markerRow).toBeVisible();
  const markerText = await markerRow.innerText();

  const marked = await page.evaluate(() => {
    const screen = document.querySelector(".conversation-screen") as HTMLElement | null;
    if (screen !== null) screen.dataset.cawJourneyC = "mounted-once";
    return { timeOrigin: performance.timeOrigin, stamped: screen !== null };
  });
  expect(marked.stamped, "the conversation screen is up before the layer opens").toBe(true);

  // 2. Open Agents Center from the overflow menu.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: /^Agents \(/ }).click();

  const chips = page.getByRole("group", { name: "Filter agents" });
  const taskHeading = page.getByRole("heading", { name: "Task", exact: true });
  const transcriptHeading = page.getByRole("heading", { name: "Transcript", exact: true });
  const actionsHeading = page.getByRole("heading", { name: "Actions", exact: true });

  // ... list is showing.
  await expect(page.getByRole("heading", { name: /Agents \(2\)/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Running", exact: true })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Finished", exact: true })).toBeVisible();

  // 3. Select an agent -> its detail is showing.
  await page.locator(".agent-row").filter({ hasText: "scout-codebase" }).click();
  await expect(page.getByRole("heading", { name: "scout-codebase", exact: true })).toBeVisible();
  await expect(taskHeading).toBeVisible();
  await expect(transcriptHeading).toBeVisible();
  await expect(actionsHeading).toBeVisible();

  // 4. Back -> the LIST, not the conversation.
  await page.goBack();
  await expect(page.getByRole("heading", { name: /Agents \(2\)/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Running", exact: true })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Finished", exact: true })).toBeVisible();
  await expect(taskHeading, "the detail's sections are gone, so this is the list").toHaveCount(0);
  await expect(transcriptHeading).toHaveCount(0);
  await expect(actionsHeading).toHaveCount(0);

  // 5. Back again -> the conversation, interactive again.
  await page.goBack();
  await expect(page.locator(".agents-layer")).toHaveCount(0);
  await expect(page.locator(".agents-center")).toHaveCount(0);
  await expect(page.locator("textarea.composer-input")).toBeEditable();
  expect(await page.locator(".conversation-column").evaluate((el) => el.hasAttribute("inert")), "the conversation is no longer inert").toBe(false);

  // 6. Forward -> back to the LIST (not the detail).
  await page.goForward();
  await expect(page.getByRole("heading", { name: /Agents \(2\)/ })).toBeVisible();
  await expect(chips.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Running", exact: true })).toBeVisible();
  await expect(chips.getByRole("button", { name: "Finished", exact: true })).toBeVisible();
  await expect(taskHeading, "Forward returns the list, not the detail").toHaveCount(0);
  await expect(transcriptHeading).toHaveCount(0);
  await expect(actionsHeading).toHaveCount(0);

  // 7. Forward again -> the detail returns.
  await page.goForward();
  await expect(page.getByRole("heading", { name: "scout-codebase", exact: true })).toBeVisible();
  await expect(taskHeading).toBeVisible();
  await expect(transcriptHeading).toBeVisible();
  await expect(actionsHeading).toBeVisible();

  // 8. The conversation was never unmounted, and its live-only row is intact.
  const after = await page.evaluate(() => {
    const screen = document.querySelector(".conversation-screen") as HTMLElement | null;
    return { timeOrigin: performance.timeOrigin, stamped: screen?.dataset.cawJourneyC ?? null };
  });
  expect(after.timeOrigin, "no document navigation happened on the whole walk").toBe(marked.timeOrigin);
  expect(after.stamped, "the same conversation element is still mounted").toBe("mounted-once");
  expect(await markerRow.innerText(), "the live-only transcript row is unchanged").toBe(markerText);

  // The walk left no orphan entry: Back from the detail is the list, and Back again
  // is the conversation — never a re-opened layer over a screen that is gone.
  await page.goBack();
  await expect(chips.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Agents \(2\)/ })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".agents-layer")).toHaveCount(0);
  expect(await page.locator(".conversation-column").evaluate((el) => el.hasAttribute("inert"))).toBe(false);
});

test("the header has no horizontal overflow at 320px and the dashboard row is bounded", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(NARROW);
  await openSeededConversation(page);
  await host.send({ ...welcomeFrame(false), state: { ...welcomeFrame(false).state, model: { id: "vendor/a-very-long-model-identifier", name: "Long", provider: "p", contextWindow: 1 } } });

  const measured = await page.evaluate(() => {
    const header = document.querySelector(".app-header") as HTMLElement;
    const dashboard = document.querySelector(".dashboard-row") as HTMLElement;
    const cards = [...document.querySelectorAll(".dashboard-card")] as HTMLElement[];
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      headerHeight: Math.round(header.getBoundingClientRect().height),
      headerScrollWidth: header.scrollWidth,
      headerClientWidth: header.clientWidth,
      dashboardHeight: Math.round(dashboard.getBoundingClientRect().height),
      cardHeights: cards.map((card) => Math.round(card.getBoundingClientRect().height)),
      cardWidths: cards.map((card) => Math.round(card.getBoundingClientRect().width)),
      // The columns the row actually laid out (3 when it fits, 2 when it does not).
      columns: getComputedStyle(dashboard).gridTemplateColumns.split(" ").length,
      headerStatusText: (document.querySelector(".header-status") as HTMLElement).textContent,
    };
  });
  console.log("[round54 narrow header]", JSON.stringify(measured));
  await page.screenshot({ path: join(SCREENS_DIR, "round54-narrow-header.png") });

  expect(measured.documentScrollWidth, "no horizontal document overflow at 320px").toBeLessThanOrEqual(measured.documentClientWidth + 1);
  expect(measured.headerScrollWidth).toBeLessThanOrEqual(measured.headerClientWidth + 1);
  expect(measured.headerHeight, "header stays compact").toBeLessThanOrEqual(90);
  for (const height of measured.cardHeights) expect(height).toBeLessThanOrEqual(64);
  expect(measured.dashboardHeight, "dashboard row bounded").toBeLessThanOrEqual(72);
  expect(measured.columns, "three bounded columns at every width").toBe(3);
  // The model is reported authoritatively by the welcome frame, so it is shown.
  expect(measured.headerStatusText).toContain("vendor/a-very-long-model-identifier");
});

test("no model name is printed when the host reported none", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize(MOBILE);
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  const status = await page.locator(".header-status").textContent();
  console.log("[round54 header status without model]", JSON.stringify({ status }));
  expect(status).toContain("idle");
  expect(status).not.toContain("·");
});
