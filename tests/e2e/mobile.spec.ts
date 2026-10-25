import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { harnessFixture, installMockCollabHost, login, openSeededConversation, requireAppServer, welcomeFrame } from "./fixture.js";

/**
 * Mobile geometry at 390x844. These are the layout claims docs/architecture/
 * mobile-client.md makes for a phone: nothing scrolls sideways, every control is
 * finger-sized, the composer survives the on-screen keyboard, and a long code
 * block scrolls inside itself instead of widening the page.
 */

const COMPOSER = /Send instructions to agent|Turn in flight/;
const MIN_TOUCH_TARGET = 40;

/** Interactive elements a finger must be able to hit. */
async function touchTargets(page: Page) {
  return page.evaluate((minimum) => {
    const selector = "button, a[href], input:not([type=hidden]), textarea, select, summary, [role=button]";
    const offenders: Array<{ tag: string; text: string; height: number; width: number }> = [];
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (rect.height < minimum) {
        offenders.push({
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? "").trim().slice(0, 40),
          height: Math.round(rect.height * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
        });
      }
    }
    return offenders;
  }, MIN_TOUCH_TARGET);
}

async function pageWidth(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
}

test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
  await requireAppServer(request);
});

test("no horizontal page scroll at 390x844", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

  const width = await pageWidth(page);
  expect(width.clientWidth, "the viewport must actually be 390 CSS px wide").toBe(390);
  expect(width.scrollWidth, "the page must not scroll sideways").toBeLessThanOrEqual(width.clientWidth + 1);
  expect(width.bodyScrollWidth).toBeLessThanOrEqual(width.clientWidth + 1);

  // The folder browser modal is the densest screen; it must not widen the page either.
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  const inModal = await pageWidth(page);
  expect(inModal.scrollWidth).toBeLessThanOrEqual(inModal.clientWidth + 1);
});

test("every interactive target is at least 40px tall on the projects screen", async ({ page }) => {
  await login(page);

  // Create one project so the card actions (star/rename/delete) are on screen.
  await page.getByRole("button", { name: "+ New Project" }).click();
  await expect(page.getByRole("heading", { name: "Browse Folders" })).toBeVisible();
  await page.getByText(/^\S+\s+m-touch$/).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByPlaceholder("Display label (e.g. My Backend)").fill("Touch Fixture");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Touch Fixture", exact: true })).toBeVisible();

  const offenders = await touchTargets(page);
  expect(offenders, `these controls are smaller than ${MIN_TOUCH_TARGET}px tall: ${JSON.stringify(offenders)}`).toEqual([]);

  // Settings is reached from the projects header and must meet the same bar.
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Runtime & Settings" })).toBeVisible();
  const settingsOffenders = await touchTargets(page);
  expect(settingsOffenders, `settings controls below ${MIN_TOUCH_TARGET}px: ${JSON.stringify(settingsOffenders)}`).toEqual([]);
});

test("the composer stays visible after a 300px viewport shrink (keyboard)", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  const composer = page.getByRole("textbox", { name: COMPOSER });
  await expect(composer).toBeVisible();
  expect(await composer.boundingBox()).not.toBeNull();

  // A phone keyboard shortens the viewport the user can see.
  await page.setViewportSize({ width: 390, height: 544 });
  await page.waitForTimeout(150);

  await expect(composer, "the composer must still be on screen with the keyboard up").toBeVisible();
  const after = await composer.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.y + after!.height, "the composer must not be pushed below the shrunken viewport").toBeLessThanOrEqual(544 + 1);
  expect(after!.y).toBeGreaterThan(0);

  // Still reachable, not merely present.
  await composer.click();
  await expect(composer).toBeFocused();
});

test("long code blocks scroll inside themselves, not the page", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();

  const longLine = `const x = "${"A".repeat(400)}";`;
  await host.send({
    t: "entry",
    entry: { id: "e2e-code", type: "message", message: { role: "assistant", content: [{ type: "text", text: `\`\`\`js\n${longLine}\n\`\`\`` }] } },
  });

  const block = page.locator("pre").filter({ hasText: "const x =" });
  await expect(block).toBeVisible();

  const geometry = await block.evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(geometry.scrollWidth, "the code block must overflow internally").toBeGreaterThan(geometry.clientWidth);
  expect(geometry.overflowX, "the overflow must be scrollable inside the block").toBe("auto");

  const pageGeometry = await pageWidth(page);
  expect(pageGeometry.scrollWidth, "a long code line must not widen the page").toBeLessThanOrEqual(pageGeometry.clientWidth + 1);
});

test("wide markdown table keeps natural columns inside horizontal scroller", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await page.setViewportSize({ width: 375, height: 812 });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send({
    t: "entry",
    entry: {
      id: "wide-mobile-table",
      type: "message",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "| Node Identifier | Pod Replica | Microservice Component | Commit Version | Cloud Region | Zone | Runtime Health | Latency (p95) | Memory (RSS) | Error Budget |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| node-east-01 | pod-gateway-a1 | Ingress Dispatcher Gateway | v2.18.4-c892a | US-East (Virginia) | us-east-1a | Healthy Nominal | 12.4 ms | 48.2 MB | 99.985% |",
        }],
      },
    },
  });

  const wrapper = page.locator(".markdown-table-scroll");
  await expect(wrapper).toBeVisible();
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 844 });
    const geometry = await wrapper.evaluate((element) => {
      const table = element.querySelector("table")!;
      return {
        tableScrollWidth: table.scrollWidth,
        wrapperScrollWidth: element.scrollWidth,
        wrapperClientWidth: element.clientWidth,
        overflowX: getComputedStyle(element).overflowX,
        pageScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    console.log(`[wide table geometry ${width}]`, JSON.stringify(geometry));
    expect(geometry.tableScrollWidth, "table columns must keep natural width").toBeGreaterThan(geometry.wrapperClientWidth);
    expect(geometry.wrapperScrollWidth, "table wrapper must horizontally overflow").toBeGreaterThan(geometry.wrapperClientWidth);
    expect(geometry.overflowX).toBe("auto");
    expect(geometry.pageScrollWidth, "wide table must not widen document").toBeLessThanOrEqual(geometry.viewportWidth);
  }
});

test("long conversation scrolls internally and detached reading stays put", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  const entry = (id: string, timestamp: number, content: string) => ({
    t: "entry",
    entry: {
      id,
      type: "message",
      message: { role: "user", content, timestamp },
    },
  });
  for (let index = 0; index < 24; index++) {
    await host.send(entry(`long-${index}`, index + 1, `Transcript line ${index}: ${"reading older content ".repeat(14)}`));
  }

  const scroller = page.locator(".messages-scroll");
  await expect(page.locator(".message-card.user")).toHaveCount(24);
  const before = await page.evaluate(() => {
    const element = document.querySelector(".messages-scroll")!;
    return {
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
    };
  });
  expect(before.scrollHeight, "transcript must overflow its own region").toBeGreaterThan(before.clientHeight);
  expect(before.documentHeight, "conversation must not scroll at document level").toBeLessThanOrEqual(before.viewportHeight);

  await scroller.evaluate((element: HTMLElement) => {
    element.scrollTop = 120;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const latest = page.getByRole("button", { name: /Latest/ });
  await expect(latest).toBeVisible();

  const detachedTop = await scroller.evaluate((element: HTMLElement) => element.scrollTop);
  await host.send(entry("append-while-detached", 100, `Appended below reader ${"new content ".repeat(60)}`));
  await expect(page.locator(".message-card.user")).toHaveCount(25);
  const afterAppend = await scroller.evaluate((element: HTMLElement) => element.scrollTop);
  expect(afterAppend, "appending below reader must preserve scroll position").toBe(detachedTop);

  await host.send({
    t: "entry",
    entry: {
      id: "expand-while-detached",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "large-tool-output",
        toolName: "Large output",
        content: [{ type: "text", text: "Large output line\n".repeat(80) }],
        isError: false,
        timestamp: 101,
      },
    },
  });
  const toolDetails = page.locator("details").filter({ hasText: "Large output" });
  await expect(toolDetails).toBeVisible();
  const beforeExpand = await scroller.evaluate((element: HTMLElement) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
  }));
  await toolDetails.evaluate((element) => { (element as HTMLDetailsElement).open = true; });
  await expect(toolDetails.locator("pre")).toBeVisible();
  await page.waitForTimeout(100);
  const afterExpandGeometry = await scroller.evaluate((element: HTMLElement) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
  }));
  const afterExpand = afterExpandGeometry.scrollTop;
  expect(afterExpand, "expanding output while detached must preserve scroll position").toBe(detachedTop);
  expect(beforeExpand.scrollTop).toBe(detachedTop);

  await latest.click();
  const afterLatest = await scroller.evaluate((element: HTMLElement) => ({
    scrollTop: element.scrollTop,
    bottom: element.scrollHeight - element.clientHeight,
  }));
  expect(afterLatest.scrollTop).toBe(afterLatest.bottom);
  const composerBox = await page.locator(".composer-container").boundingBox();
  const transcriptBox = await scroller.boundingBox();
  expect(composerBox).not.toBeNull();
  expect(transcriptBox).not.toBeNull();
  expect(composerBox!.y).toBeGreaterThanOrEqual(transcriptBox!.y + transcriptBox!.height - 1);
  expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(before.viewportHeight);
  console.log("[mobile transcript geometry]", JSON.stringify({ before, detachedTop, afterAppend, afterExpand, afterLatest, composerBox, transcriptBox }));
});
