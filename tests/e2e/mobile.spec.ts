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
