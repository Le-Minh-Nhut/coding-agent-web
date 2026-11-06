import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
  createUserMessageEntry,
  createAssistantMessageEntry,
  type MockCollabHost,
} from "./fixture.js";

/**
 * The header's overflow sheet, as a real browser sees it.
 *
 * Three claims are only provable here, in Chromium:
 *  - the sheet is GROUPED, and the two destructive session rows sit in the last
 *    group behind their confirmation;
 *  - it is DISMISSABLE — Escape, an outside tap, and browser Back must all close
 *    it, and Back must leave the conversation it covered mounted and editable
 *    (the previous build had no dismissal at all, and Back would have navigated
 *    the conversation away);
 *  - it FITS the phone: at four widths the sheet stays inside the viewport and
 *    adds no horizontal document overflow.
 *
 * The Adv chip rule and the Files layer are asserted here too, because both are
 * visible only in a real render.
 */

const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;

const MENU = "#conversation-actions-menu";
const TRIGGER = { name: "More actions" } as const;

/** Where the visual-verification captures land (Phase 10 keeps a PNG per screen). */
const CAPTURES = join(homedir(), ".cache", "caw-screens");

/** Open the seeded conversation with a live mock host, ready to receive frames. */
async function open(page: Page): Promise<MockCollabHost> {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  return host;
}

test.beforeAll(async ({ request }) => {
  await requireAppServer(request);
});

test("the sheet is grouped, in order, with the session rows last behind their confirmation", async ({ page }) => {
  const host = await open(page);
  await host.send({ t: "entry", entry: createUserMessageEntry("marker", "MENU_GROUP_MARKER", Date.now()) });

  await page.getByRole("button", TRIGGER).click();
  await expect(page.locator(MENU)).toBeVisible();

  // The three headings, in document order.
  const headings = await page.locator(`${MENU} .header-menu-heading`).allTextContents();
  expect(headings).toEqual(["Go to", "Panels", "Session"]);

  // Each destination sits in the group its label promises.
  const groupOf = (heading: string) => page.locator(`${MENU} .header-menu-group`).filter({ has: page.locator(".header-menu-heading", { hasText: heading }) });
  await expect(groupOf("Go to").getByRole("button", { name: "Activity", exact: true })).toBeVisible();
  await expect(groupOf("Go to").getByRole("button", { name: "Files", exact: true })).toBeVisible();
  await expect(groupOf("Go to").getByRole("button", { name: /^Agents \(\d+\)$/ })).toBeVisible();
  await expect(groupOf("Panels").getByRole("button", { name: /^Advisor/ })).toBeVisible();
  await expect(groupOf("Panels").getByRole("button", { name: "Vibe mode", exact: true })).toBeVisible();
  await expect(groupOf("Panels").getByRole("button", { name: "Model settings", exact: true })).toBeVisible();

  // The destructive pair: last group, and Stop still only opens its confirmation.
  const session = page.locator(`${MENU} .header-menu-group--session`);
  const stop = session.getByRole("button", { name: "Stop OMP session" });
  await expect(stop).toBeVisible();
  await expect(page.locator(`${MENU} .header-menu-group`).last().locator(".header-menu-heading")).toHaveText("Session");

  // This fixture's conversation is `managed` but has no verified tmux session, so
  // the control is correctly DISABLED with its reason in `title` — never an enabled
  // action that would fail. The group/order claim above is what this spec proves;
  // the confirmation flow itself is covered where a session exists
  // (`tests/web/stop-session.test.tsx`), so this spec asserts the gate, not a click
  // that cannot happen.
  await expect(stop).toBeDisabled();
  await expect(stop).toHaveAttribute("title", /No verified managed tmux session/);
  // Handoff is offered here (the conversation is ours) and also stays behind its own
  // confirmation.
  const handoff = session.getByRole("button", { name: "Handoff context" });
  await expect(handoff).toBeVisible();

  // The sheet as the user sees it: every group, the destructive pair in place.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(CAPTURES, "action-menu-grouped.png") });

  await handoff.click();
  await expect(page.locator(MENU)).toHaveCount(0);
  const confirm = page.getByRole("group", { name: "Handoff context" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Run handoff" })).toBeVisible();
  // Nothing ran: the card is an offer, not a report.
  await expect(page.getByText(/Handoff complete/i)).toHaveCount(0);
});

test("Escape closes the sheet and returns focus to the trigger", async ({ page }) => {
  await open(page);
  await page.getByRole("button", TRIGGER).click();
  await expect(page.locator(MENU)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(MENU)).toHaveCount(0);
  // Focus must land somewhere real, never on `document.body`.
  await expect(page.getByRole("button", TRIGGER)).toBeFocused();
});

test("a tap outside the sheet closes it, and a tap on a row does not leave an orphan entry", async ({ page }) => {
  await open(page);
  await page.getByRole("button", TRIGGER).click();
  await expect(page.locator(MENU)).toBeVisible();
  await page.locator(".conversation-header-copy h3").click();
  await expect(page.locator(MENU)).toHaveCount(0);

  // Opening and then choosing a row must leave no `cawMenu` entry behind: a later
  // Back must not re-open the sheet over a screen the user has already left.
  await page.getByRole("button", TRIGGER).click();
  await page.locator(MENU).getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.locator(MENU)).toHaveCount(0);
  const heading = page.getByRole("heading", { name: "Activity Timeline" });
  await expect(heading).toBeVisible();
  await page.getByRole("button", { name: "Close activity timeline" }).click();
  await expect(heading).toHaveCount(0);

  // Closing by a row/outside route retires the entry (it is popped), so the
  // current history entry is no longer ours.
  expect(await page.evaluate(() => (window.history.state as Record<string, unknown> | null)?.cawMenu ?? null)).toBeNull();

  await page.getByRole("button", TRIGGER).click();
  await expect(page.locator(MENU)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(MENU)).toHaveCount(0);
  expect(await page.evaluate(() => (window.history.state as Record<string, unknown> | null)?.cawMenu ?? null)).toBeNull();

  // With the entry retired, the app has no orphan to consume: the conversation is
  // still the screen on display and still accepts input.
  await expect(page.locator("textarea.composer-input")).toBeEditable();
  await expect(page.locator(".messages-scroll")).toBeVisible();
});

test("browser Back closes the sheet and leaves the conversation mounted and editable", async ({ page }) => {
  const host = await open(page);
  // A live-only row: it arrived over the socket, so a remount would lose it.
  await host.send({ t: "entry", entry: createUserMessageEntry("marker-back", "BACK_MARKER_ROW", Date.now()) });
  const markerRow = page.getByText("BACK_MARKER_ROW");
  await expect(markerRow).toBeVisible();
  const markerText = await markerRow.innerText();

  await page.getByRole("button", TRIGGER).click();
  await expect(page.locator(MENU)).toBeVisible();

  await page.goBack();
  await expect(page.locator(MENU)).toHaveCount(0);
  // The conversation is the screen underneath, interactive again.
  expect(await page.locator(".conversation-column").evaluate((el) => el.hasAttribute("inert"))).toBe(false);
  const composer = page.locator("textarea.composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("BACK_DRAFT_SURVIVES");
  await expect(composer).toHaveValue("BACK_DRAFT_SURVIVES");
  expect(await markerRow.innerText(), "the live-only row survived the Back").toBe(markerText);
});

test("the sheet fits inside the viewport at every phone width", async ({ page }) => {
  const host = await open(page);
  // A recorded blocker makes the Adv chip render, so the chip-width assertion below
  // is measuring a real element rather than an empty list.
  await host.send(advisorEntry("fit-chip", [{ note: "Blocker for the fit measurement", severity: "blocker" }]));
  await expect(page.locator(".mode-chip--alert")).toBeVisible();
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.getByRole("button", TRIGGER).click();
    await expect(page.locator(MENU)).toBeVisible();

    const measured = await page.evaluate(() => {
      const menu = document.querySelector("#conversation-actions-menu") as HTMLElement;
      const box = menu.getBoundingClientRect();
      const header = document.querySelector(".app-header") as HTMLElement;
      const rows = [...menu.querySelectorAll("button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          label: button.textContent?.trim() ?? "",
          height: Math.round(rect.height),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          // A label wider than its own button paints outside the sheet border.
          overflow: button.scrollWidth - button.clientWidth,
        };
      });
      return {
        top: Math.round(box.top),
        left: Math.round(box.left),
        right: Math.round(box.right),
        bottom: Math.round(box.bottom),
        headerBottom: Math.round(header.getBoundingClientRect().bottom),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        headerScrollWidth: header.scrollWidth,
        headerClientWidth: header.clientWidth,
        chips: [...document.querySelectorAll(".mode-chip")].map((chip) => Math.round(chip.getBoundingClientRect().width)),
        rows,
      };
    });
    console.log(`[action-menu ${viewport.name}]`, JSON.stringify(measured));

    expect(measured.left, `${viewport.name}: sheet starts on screen`).toBeGreaterThanOrEqual(0);
    expect(measured.right, `${viewport.name}: sheet ends on screen`).toBeLessThanOrEqual(measured.viewportWidth);
    expect(measured.bottom, `${viewport.name}: sheet fits vertically`).toBeLessThanOrEqual(measured.viewportHeight);
    expect(measured.top, `${viewport.name}: sheet does not cover the header that opens it`).toBeGreaterThanOrEqual(measured.headerBottom);
    expect(measured.scrollWidth, `${viewport.name}: no horizontal overflow`).toBeLessThanOrEqual(measured.clientWidth + 1);
    expect(measured.headerScrollWidth, `${viewport.name}: header itself does not overflow`).toBeLessThanOrEqual(measured.headerClientWidth + 1);
    // The narrowest phone must not get a half-width sheet.
    if (viewport.width === 320) expect(measured.right - measured.left).toBeLessThanOrEqual(288);

    // Every row: 44px touch minimum, inside the sheet, label not spilling out. The
    // icon-button rule in the header cluster used to squeeze these to 44px WIDE.
    expect(measured.rows.length).toBeGreaterThanOrEqual(7);
    for (const row of measured.rows) {
      expect(row.height, `${viewport.name}: "${row.label}" meets the touch minimum`).toBeGreaterThanOrEqual(44);
      expect(row.left, `${viewport.name}: "${row.label}" starts inside the sheet`).toBeGreaterThanOrEqual(measured.left);
      expect(row.right, `${viewport.name}: "${row.label}" ends inside the sheet`).toBeLessThanOrEqual(measured.right);
      expect(row.overflow, `${viewport.name}: "${row.label}" label fits its button`).toBeLessThanOrEqual(1);
    }

    // The chips share that cluster and must not be compressed by the same rule.
    expect(measured.chips.length, `${viewport.name}: the Adv chip is present to measure`).toBeGreaterThanOrEqual(1);
    for (const width of measured.chips) expect(width, `${viewport.name}: a chip is not compressed`).toBeGreaterThanOrEqual(44);

    // Capture the two ends of the range: the fit claim is checkable by eye here.
    if (viewport.width === 320) await page.screenshot({ path: join(CAPTURES, "action-menu-320.png") });
    if (viewport.width === 390) await page.screenshot({ path: join(CAPTURES, "action-menu-390-fixed.png") });

    await page.keyboard.press("Escape");
    await expect(page.locator(MENU)).toHaveCount(0);
  }
});

test("open/dismiss cycles do not accumulate history entries", async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => window.history.length);

  // Ten cycles, then ten more: `history.length` is a never-decreasing high-water
  // mark in the History API, so the observable property is not that it returns to
  // its starting value but that it does not GROW WITH THE NUMBER OF CYCLES. The
  // old code left one orphan per cycle, so the second batch would add ten.
  const cycle = async () => {
    await page.getByRole("button", TRIGGER).click();
    await expect(page.locator(MENU)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(MENU)).toHaveCount(0);
  };
  for (let i = 0; i < 10; i++) await cycle();
  const afterFirst = await page.evaluate(() => window.history.length);
  for (let i = 0; i < 10; i++) await cycle();
  const afterSecond = await page.evaluate(() => window.history.length);
  console.log("[action-menu history cycles]", JSON.stringify({ before, afterFirst, afterSecond }));

  expect(afterSecond, "twenty cycles add no history entry beyond the first one").toBe(afterFirst);
  expect(afterFirst - before, "the first open pushes one entry, and dismissals retire it").toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => (window.history.state as Record<string, unknown> | null)?.cawMenu ?? null)).toBeNull();

  // And ONE Back leaves the conversation — not one Back per dismissed menu.
  await page.goBack();
  await expect(page.locator(MENU)).toHaveCount(0);
  await expect(page.locator("textarea.composer-input")).toHaveCount(0);
});

/** One advisor turn, in the exact shape OMP writes it. */
function advisorEntry(id: string, notes: unknown[]) {
  return {
    t: "entry",
    entry: {
      id,
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "custom_message",
      customType: "advisor",
      content: "Advisor notes",
      display: true,
      details: { notes },
    },
  };
}

test("the Adv chip follows only STANDING blockers, and the note count stays reachable from the menu", async ({ page }) => {
  const host = await open(page);
  const chip = page.locator(".mode-chip--alert");

  // A historical non-blocker note: no chip, because nothing on this transport
  // knows whether the advisor is running — only that a note was recorded. (The
  // note still renders as its own transcript card; the chip is what is absent.)
  await host.send(advisorEntry("adv-1", [{ note: "Consider renaming this", severity: "nit" }]));
  await expect(page.locator(".advisor-card")).toBeVisible();
  await expect(chip).toHaveCount(0);

  // The count is not lost: it lives on the menu's own Advisor entry.
  await page.getByRole("button", TRIGGER).click();
  await expect(page.locator(MENU).getByRole("button", { name: "Advisor (1 recorded note)" })).toBeVisible();
  await page.keyboard.press("Escape");

  // A blocker still open is the case that earns the chip.
  await host.send(advisorEntry("adv-2", [{ note: "This will corrupt the journal", severity: "blocker" }]));
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-label", /still open/);

  // The honesty case: the agent SAYING it fixed the issue must not clear the
  // warning. Only evidence that verifies the fix may, and prose is not evidence.
  await host.send({ t: "entry", entry: createAssistantMessageEntry("claim-1", "I have fixed the journal corruption problem.", Date.now()) });
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute("aria-label", /1 advisor blocker still open/);
});

test("the Files item opens the Files Center layer, and Back returns to an unchanged conversation", async ({ page }) => {
  const host = await open(page);
  await host.send({ t: "entry", entry: createUserMessageEntry("files-marker", "FILES_MARKER_ROW", Date.now()) });
  const composer = page.locator("textarea.composer-input");
  await composer.fill("FILES_DRAFT_SURVIVES");
  await page.locator(".messages-scroll").evaluate((el) => { el.scrollTop = 40; });
  const scrollBefore = await page.locator(".messages-scroll").evaluate((el) => el.scrollTop);

  await page.getByRole("button", TRIGGER).click();
  await page.locator(MENU).getByRole("button", { name: "Files", exact: true }).click();

  const layer = page.locator(".files-layer");
  await expect(layer).toBeVisible();
  // One viewport, one interactive screen: the covered conversation is inert.
  expect(await page.locator(".conversation-column").evaluate((el) => el.hasAttribute("inert"))).toBe(true);

  // Close it through its own Back control.
  await layer.getByRole("button", { name: "Back" }).first().click();
  await expect(layer).toHaveCount(0);
  await expect(page.locator(MENU)).toHaveCount(0);
  expect(await page.locator(".conversation-column").evaluate((el) => el.hasAttribute("inert"))).toBe(false);
  // Focus lands on a real control, never `document.body`.
  await expect(page.getByRole("button", TRIGGER)).toBeFocused();
  // The draft and scroll position are exactly where they were.
  await expect(composer).toHaveValue("FILES_DRAFT_SURVIVES");
  expect(await page.locator(".messages-scroll").evaluate((el) => el.scrollTop)).toBe(scrollBefore);
  await expect(page.getByText("FILES_MARKER_ROW")).toBeVisible();
});
