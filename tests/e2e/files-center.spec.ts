import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
  type MockCollabHost,
} from "./fixture.js";

/**
 * Files Center + File Diff viewer, driven through the real screen.
 *
 * The diffs seeded here are OMP's real **gutter** payloads (` 12|code`, `-7|old`,
 * `+9|new`, blank line between hunks) rather than unified diffs: the viewer parses
 * what the host actually sends, and a unified fixture would prove a code path no
 * session ever takes.
 *
 * What is asserted (the claims this screen makes):
 *  - the layer opens from the conversation's overflow menu and lists exactly the
 *    unique file count, with short names;
 *  - tapping a file shows its diff with non-transparent add/del row backgrounds,
 *    distinct from context and from each other;
 *  - hunk navigation moves the viewer's OWN scrollTop;
 *  - Back returns list → conversation, with the draft and the transcript scroll
 *    position preserved;
 *  - no horizontal page overflow at any of the four required phone viewports.
 */

const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;

/** A real two-hunk gutter diff: context, a removal, an addition, a gap, more. */
function gutterDiff(): string {
  return [
    ` 1|import { login } from "./auth";`,
    ` 2|`,
    `-3|export function run(user: string) {`,
    `+3|export async function run(user: string) {`,
    `+4|  const token = await login(user);`,
    ` 4|  return user;`,
    ` 5|}`,
    ``,
    ` 40|const cache = new Map<string, number>();`,
    `-41|cache.set("a", 1);`,
    `+41|cache.set("a", 2);`,
    ` 42|export default cache;`,
  ].join("\n");
}

/** One `edit` tool result carrying a per-file gutter diff. */
function editEntry(id: string, path: string, diff: string, timestamp: number, over: Record<string, unknown> = {}) {
  return {
    t: "entry",
    entry: {
      id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call-${id}`,
        toolName: "edit",
        content: [{ type: "text", text: `Edited ${path}` }],
        details: { path, op: "update", diff, perFileResults: [{ path, op: "update", diff }], ...over },
        isError: false,
        timestamp,
      },
    },
  };
}

/** A failed edit: OMP sends `{diff: "", errorKind}` and no path at all. */
function failedEditEntry(id: string, callId: string, errorKind: string, timestamp: number) {
  return {
    t: "entry",
    entry: {
      id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: callId,
        toolName: "edit",
        content: [{ type: "text", text: "edit failed" }],
        details: { diff: "", errorKind },
        isError: true,
        timestamp,
      },
    },
  };
}

/**
 * The assistant call that produced a failed edit, so its file is knowable at all.
 *
 * OMP puts no path in a failure's `details`; the call's arguments are the only
 * place it appears. Without this the failed row has no file and is dropped, which
 * is exactly the case this seed must exercise.
 */
function failedEditCall(id: string, callId: string, path: string, timestamp: number) {
  return {
    t: "entry",
    entry: {
      id,
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "edit", arguments: { path, old_string: "gone", new_string: "new" } }],
        timestamp,
      },
    },
  };
}

function userEntry(id: string, timestamp: number, content: string) {
  return { t: "entry", entry: { id, type: "message", message: { role: "user", content, timestamp } } };
}

const FILES = [
  { path: "apps/web/src/auth.ts", diff: gutterDiff() },
  { path: "apps/web/src/session.ts", diff: [" 7|const x = 1;", "-8|old();", "+8|fresh();"].join("\n") },
  { path: "docs/readme.md", diff: [" 1|# Title", "+2|New line."].join("\n") },
];

/** Seed a conversation: 3 distinct files (one edited twice) and one failed edit. */
async function seedFilesTranscript(host: MockCollabHost): Promise<void> {
  await host.send(userEntry("m1", 1, "Please update the auth flow."));
  await host.send(editEntry("e1", FILES[0]!.path, FILES[0]!.diff, 10));
  await host.send(editEntry("e2", FILES[1]!.path, FILES[1]!.diff, 11));
  // The same path again: the list must show ONE row with `edits ×2`, not two rows.
  await host.send(editEntry("e3", FILES[0]!.path, FILES[0]!.diff, 12));
  await host.send(editEntry("e4", FILES[2]!.path, FILES[2]!.diff, 13));
  // A failure with no path in its details, so its file is only knowable from the
  // call's arguments — the case that made the header and the dashboard card disagree.
  await host.send(failedEditCall("e5-call", "call-e5", "apps/web/src/gone.ts", 14));
  await host.send(failedEditEntry("e5", "call-e5", "no_match", 15));
}

/** Open the Files layer through the app's own menu. */
async function openFilesLayer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator(".files-layer")).toBeVisible();
}

/**
 * Open the Files layer by tapping the DASHBOARD CARD — the interaction the owner
 * reported broken, which the menu path above never exercises.
 *
 * Scoped to `.dashboard-row` so the header menu's own `Files` entry cannot satisfy
 * the locator, and resolved through `toHaveCount(1)` so an ambiguous match fails
 * loudly instead of clicking whichever button the engine happened to find first.
 * Returns the card's own text and count, so the layer can be held to the same
 * number the card printed before the tap.
 */
async function openFilesLayerFromCard(page: Page): Promise<{ cardText: string; cardCount: number }> {
  const card = page.locator(".dashboard-row").getByRole("button", { name: /Files/ });
  await expect(card, "the dashboard row must hold exactly one Files card").toHaveCount(1);
  const cardText = (await card.innerText()).trim();
  const matched = /(\d+)\s+Files/u.exec(cardText);
  expect(matched, `the Files card prints its count: ${JSON.stringify(cardText)}`).not.toBeNull();
  await card.click();
  await expect(page.locator(".files-layer")).toBeVisible();
  return { cardText, cardCount: Number(matched![1]) };
}

/** Where the visual-verification captures land (Phase 10 keeps a PNG per screen). */
const CAPTURES = join(homedir(), ".cache", "caw-screens");

/** Computed value of one CSS property on the first row matching a selector, as the browser reports it. */
async function rowCss(page: Page, selector: string, property: "backgroundColor" | "color"): Promise<string> {
  return page.locator(selector).first().evaluate((element, prop) => getComputedStyle(element)[prop], property);
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("the Files layer opens from the menu and lists the unique file count with short names", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await seedFilesTranscript(host);

  await openFilesLayer(page);

  // Three distinct paths had an APPLIED edit; the failed edit is listed but not
  // counted. The dashboard card counts applied paths too, so the two numbers must
  // be equal — that equality is the point of this case.
  await expect(page.getByRole("heading", { name: "Changed Files" })).toBeVisible();
  const header = page.locator(".files-count");
  await expect(header).toContainText("3 files changed");
  await expect(header).toContainText("1 failed row not counted");
  await expect(page.locator(".dashboard-card").filter({ hasText: "Files" })).toContainText("3 Files");
  const rows = page.locator(".files-row");
  await expect(rows).toHaveCount(4);
  await expect(page.locator(".files-row-name")).toHaveText(["auth.ts", "session.ts", "readme.md", "gone.ts"]);
  // The path edited twice is one row, and says so.
  await expect(page.locator(".files-row").filter({ hasText: "auth.ts" }).locator(".files-row-edits")).toHaveText("edits ×2");
  // The failed row is present, labelled as outside the count.
  await expect(page.locator(".files-row").filter({ hasText: "gone.ts" }).locator(".files-row-flag--failed")).toContainText("not counted");
  // Provenance is stated on the screen, not implied.
  await expect(page.locator(".files-window-note")).toContainText("Edits observed in this conversation's transcript");
  await expect(page.locator(".files-window-note")).toContainText("not the git working tree");

  // Capture the screen this test just proved: Phase 10 verifies screens visually,
  // and a state can only be photographed where it was actually driven.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".files-list").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(CAPTURES, "files-center-list.png") });
});

test("tapping a file shows its diff with add/del row backgrounds distinct from context", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await seedFilesTranscript(host);

  await openFilesLayer(page);
  await page.locator(".files-row").filter({ hasText: "auth.ts" }).click();

  await expect(page.locator(".files-diff")).toBeVisible();
  await expect(page.locator(".tv-diff-row--add").first()).toBeVisible();
  await expect(page.locator(".tv-diff-row--del").first()).toBeVisible();

  const [add, del, ctx, addColor, delColor, ctxColor] = await Promise.all([
    rowCss(page, ".tv-diff-row--add", "backgroundColor"),
    rowCss(page, ".tv-diff-row--del", "backgroundColor"),
    rowCss(page, ".files-diff-row:not(.tv-diff-row--add):not(.tv-diff-row--del):not(.tv-diff-row--hunk):not(.tv-diff-row--gap)", "backgroundColor"),
    rowCss(page, ".tv-diff-row--add", "color"),
    rowCss(page, ".tv-diff-row--del", "color"),
    rowCss(page, ".files-diff-row:not(.tv-diff-row--add):not(.tv-diff-row--del):not(.tv-diff-row--hunk):not(.tv-diff-row--gap)", "color"),
  ]);
  const colours = { add, del, ctx, addColor, delColor, ctxColor };
  console.log("[files-center diff colours]", JSON.stringify(colours));

  // The glyph colour is the same single declaration the conversation diff rows
  // resolve, so an added line can never be one green here and another there.
  // `#3fb950` is the conversation's measured add colour; `--danger-text` is #f87171.
  expect(addColor, "add glyphs must match the conversation's #3fb950").toBe("rgb(63, 185, 80)");
  expect(delColor, "del glyphs must match the conversation's --danger-text").toBe("rgb(248, 113, 113)");

  // Measured, not eyeballed. A context row carries no tint by design, so it may be
  // transparent; what must hold is that both signals actually PAINT and that no two
  // of the three rows read the same.
  expect(add, "added rows are tinted, not transparent").not.toBe("rgba(0, 0, 0, 0)");
  expect(del, "deleted rows are tinted, not transparent").not.toBe("rgba(0, 0, 0, 0)");
  expect(add, "added and deleted rows are distinguishable").not.toBe(del);
  expect(ctx, "context does not wear the added tint").not.toBe(add);
  expect(ctx, "context does not wear the deleted tint").not.toBe(del);

  // Two hunks, and the counts come from the shared +/− arithmetic.
  await expect(page.locator(".files-diff-hunks")).toHaveText("2 hunks");

  // The coloured diff itself, captured at the phone size the app targets.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".files-diff").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(CAPTURES, "files-center-diff.png") });
});

test("hunk navigation moves the viewer's own scroll container", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  // One file with more hunks than the viewer renders at once (50), so both the
  // bound and the hunk navigation are exercised: hunk 2 is off screen at 390x844.
  const many = Array.from({ length: 60 }, (_, index) =>
    [` ${index * 5 + 1}|context line ${index}`, `-${index * 5 + 2}|old ${index}`, `+${index * 5 + 2}|new ${index}`].join("\n"),
  ).join("\n\n");
  await host.send(editEntry("h1", "apps/web/src/long.ts", `${many}\n`, 10));
  await page.setViewportSize({ width: 390, height: 844 });

  await openFilesLayer(page);
  await page.locator(".files-row").filter({ hasText: "long.ts" }).click();
  await expect(page.locator(".files-diff-scroll")).toBeVisible();
  // The bound is stated, not silent.
  await expect(page.locator(".files-show-all")).toContainText("more");

  const scroller = page.locator(".files-diff-scroll");
  const before = await scroller.evaluate((element) => element.scrollTop);
  await expect(page.getByRole("button", { name: "Previous hunk" })).toBeDisabled();
  await page.getByRole("button", { name: "Next hunk" }).click();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
  const pageScroll = await page.evaluate(() => document.documentElement.scrollTop);
  expect(pageScroll, "hunk navigation scrolls the viewer, not the page").toBe(0);
});

test("Back returns list then conversation, with the draft and transcript scroll preserved", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await host.send(userEntry("m0", 0, "Seed the transcript with enough rows to scroll."));
  for (let index = 0; index < 12; index++) {
    await host.send(editEntry(`row-${index}`, `apps/web/src/module-${index}.ts`, ` 1|const a = ${index};`, 1 + index));
  }
  await seedFilesTranscript(host);

  const composer = page.locator("textarea.composer-input");
  await composer.fill("unsent draft that must survive the Files layer");
  const scroll = page.locator(".messages-scroll");
  await scroll.evaluate((element) => { element.scrollTop = 240; });
  const scrollBefore = await scroll.evaluate((element) => element.scrollTop);

  await openFilesLayer(page);
  await page.locator(".files-row").first().click();
  await expect(page.locator(".files-diff")).toBeVisible();

  // Back from the diff goes to the LIST, not out of the layer. Scoped to the
  // layer: the conversation's own header Back is behind it and would be the
  // `.first()` match in DOM order.
  const filesLayer = page.locator(".files-layer");
  await filesLayer.getByRole("button", { name: "Back" }).click();
  await expect(page.locator(".files-list")).toBeVisible();
  await expect(page.locator(".files-diff")).toHaveCount(0);

  // Back from the list goes to the conversation, unchanged.
  await filesLayer.getByRole("button", { name: "Back" }).click();
  await expect(page.locator(".files-layer")).toHaveCount(0);
  await expect(composer).toHaveValue("unsent draft that must survive the Files layer");
  expect(await scroll.evaluate((element) => element.scrollTop), "transcript scroll survives").toBe(scrollBefore);
});

test("no horizontal page overflow with the diff open at the four phone viewports", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  // A line long enough to overflow if the viewer did not own its own scroller.
  const wide = ` 1|${"const veryLongIdentifier = ".repeat(20)}end;`;
  await host.send(editEntry("w1", "apps/web/src/wide.ts", `${wide}\n-2|short\n+2|${"x".repeat(400)}`, 10));

  await openFilesLayer(page);
  await page.locator(".files-row").first().click();
  await expect(page.locator(".files-diff")).toBeVisible();

  const measured: Record<string, number> = {};
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(viewport.width);
    measured[viewport.name] = await page.evaluate(
      () => Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
    );
    expect(measured[viewport.name], `${viewport.name}: no horizontal page overflow`).toBeLessThanOrEqual(1);
  }
  console.log("[files-center overflow]", JSON.stringify(measured));

  // Wrap ON must not introduce overflow either, and must flip aria-pressed.
  const wrap = page.getByRole("button", { name: "Wrap lines" });
  await expect(wrap).toHaveAttribute("aria-pressed", "false");
  await wrap.click();
  await expect(wrap).toHaveAttribute("aria-pressed", "true");
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect.poll(() => page.evaluate(() => document.documentElement.clientWidth)).toBe(viewport.width);
    expect(
      await page.evaluate(() => Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)),
      `${viewport.name}: no horizontal page overflow while wrapping`,
    ).toBeLessThanOrEqual(1);
  }
});

/**
 * The DASHBOARD CARD is the opener the owner complained about: tapping it used to
 * scroll the transcript instead of showing the list. Every other case in this file
 * reaches the layer through `More actions → Files`, so the card's own handler was
 * never executed by a test — this one taps the card itself.
 *
 * The count the card prints and the count the layer's header prints come from the
 * same rows; holding the two to each other THROUGH the tap is the "numbers cannot
 * disagree" property, proven on the path a user actually takes.
 */
test("tapping the Files dashboard card opens the layer, and browser Back returns to an intact conversation", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await seedFilesTranscript(host);
  await page.setViewportSize({ width: 390, height: 844 });

  const composer = page.locator("textarea.composer-input");
  await composer.fill("draft that must survive the card-opened Files layer");
  const scroll = page.locator(".messages-scroll");
  await scroll.evaluate((element) => { element.scrollTop = 240; });
  const scrollBefore = await scroll.evaluate((element) => element.scrollTop);

  // 1st open, from the card.
  const first = await openFilesLayerFromCard(page);
  console.log("[files-center card opener]", JSON.stringify(first));

  // The layer shows the SAME number the card printed, read off the card itself.
  await expect(page.getByRole("heading", { name: "Changed Files" })).toBeVisible();
  await expect(page.locator(".files-count")).toContainText(`${first.cardCount} files changed`);
  // And the card's own text carried that count, so neither side is a guessed literal.
  expect(first.cardText, `card text: ${JSON.stringify(first.cardText)}`).toContain(`${first.cardCount} Files`);

  // The covered conversation is a second interactive screen no more.
  expect(await page.locator(".conversation-column").evaluate((element) => element.hasAttribute("inert")), "the conversation is inert under the layer").toBe(true);

  // Rows listed with SHORT names, not full paths.
  await expect(page.locator(".files-row-name")).toHaveText(["auth.ts", "session.ts", "readme.md", "gone.ts"]);

  // Screenshot with the layer open, at the phone size the app targets.
  mkdirSync(CAPTURES, { recursive: true });
  const cardCapture = join(CAPTURES, "files-center-from-card.png");
  await page.screenshot({ path: cardCapture });
  const committed = join(process.cwd(), "docs", "assets", "screens", "round55", "files-center-from-card.png");
  mkdirSync(join(process.cwd(), "docs", "assets", "screens", "round55"), { recursive: true });
  copyFileSync(cardCapture, committed);

  // Browser Back leaves the layer, retires its own history entry, and the
  // conversation is interactive again with its draft and scroll intact.
  await page.goBack();
  await expect(page.locator(".files-layer")).toHaveCount(0);
  expect(await page.locator(".conversation-column").evaluate((element) => element.hasAttribute("inert")), "the conversation is no longer inert").toBe(false);
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue("draft that must survive the card-opened Files layer");
  expect(await scroll.evaluate((element) => element.scrollTop), "transcript scroll survives").toBe(scrollBefore);

  // 2nd open, from the same card: a leaking history entry would surface here as a
  // layer that opens then closes itself, or a Back that skips the conversation.
  const second = await openFilesLayerFromCard(page);
  expect(second.cardCount, "the card still reports the same count").toBe(first.cardCount);
  await expect(page.locator(".files-row-name")).toHaveText(["auth.ts", "session.ts", "readme.md", "gone.ts"]);
  await page.goBack();
  await expect(page.locator(".files-layer")).toHaveCount(0);
  expect(await page.locator(".conversation-column").evaluate((element) => element.hasAttribute("inert")), "the second Back behaves the same as the first").toBe(false);
  await expect(composer).toHaveValue("draft that must survive the card-opened Files layer");
});
