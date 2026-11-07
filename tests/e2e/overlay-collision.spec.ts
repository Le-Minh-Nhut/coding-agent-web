import { expect, test, type Page } from "@playwright/test";
import {
  MOCK_APPROVAL_REQUEST,
  createUserMessageEntry,
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  welcomeFrame,
  type MockCollabHost,
} from "./fixture.js";

/**
 * The floating "↓ Latest" control must never float over an approval.
 *
 * Its geometry is `position: absolute; right: safe+12px; bottom: safe+84px;
 * z-index: 15` (apps/web/src/styles.css) against `.conversation-screen`, so at
 * 320x568 it occupies y 440..484, x 230..308 — while the approval card's second
 * option sits at y 418..472, x 29..291. Measured on the unfixed tree, a tap on
 * the right half of that option returns `.latest-button`: the tap that would
 * unblock the agent scrolls the transcript instead, and a visible control is
 * unreachable by touch.
 *
 * Cutover: the affordance is not rendered at all while a host request is pending
 * (`activeUiRequest === null` in the render gate), rather than raised, shrunk or
 * made transparent — each of those keeps one control stacked on another at some
 * width. Nothing becomes unreachable: the card is the last row of the transcript
 * and the reader reaches it by scrolling.
 *
 * The hit tests below sample the whole option, not only its centre: a centre-only
 * probe misses an overlay parked over the option's right edge, which is exactly
 * this defect's shape.
 */

const VIEWPORTS = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
] as const;

/** The option labels the fixture's approval carries — the buttons under test. */
const OPTION_LABELS = MOCK_APPROVAL_REQUEST.options.map((option) => option.label);

interface OptionProbe {
  label: string;
  rect: { top: number; bottom: number; left: number; right: number };
  fullyInsideTranscript: boolean;
  /** `elementFromPoint` over a grid inside the option; every point must land on it. */
  misses: Array<{ x: number; y: number; hit: string }>;
  /** Points whose hit was the jump-to-latest control — the named regression. */
  latestHits: Array<{ x: number; y: number }>;
}

interface OverlayProbe {
  distanceToBottom: number;
  latestPresent: boolean;
  cardFound: boolean;
  options: OptionProbe[];
  /** Elements at z-index >= 10 whose box overlaps an option's box. */
  stackedOverlaps: Array<{ tag: string; cls: string; zIndex: number }>;
}

/**
 * One page-side probe. Every number is the browser's own layout, so a restyle
 * moves the assertions with it instead of invalidating them.
 */
const PROBE = `(labels) => {
  const scroller = document.querySelector(".messages-scroll");
  if (!scroller) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  const card = [...scroller.querySelectorAll(".card")].find((element) =>
    (element.textContent ?? "").includes("Approval Requested"));
  const options = card
    ? [...card.querySelectorAll("button")].filter((button) => labels.some((label) => (button.textContent ?? "").includes(label)))
    : [];
  const describe = (element) => element === null ? "null"
    : element.tagName.toLowerCase() + (element.getAttribute("class") ? "." + element.getAttribute("class").split(/\\s+/).join(".") : "");
  const points = (rect) => {
    const xs = [rect.left + rect.width * 0.1, rect.left + rect.width * 0.5, rect.right - rect.width * 0.1];
    const ys = [rect.top + rect.height * 0.3, rect.bottom - rect.height * 0.3];
    return xs.flatMap((x) => ys.map((y) => ({ x, y })));
  };
  const measured = options.map((button) => {
    const rect = button.getBoundingClientRect();
    const misses = [];
    const latestHits = [];
    for (const point of points(rect)) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (!(hit !== null && (hit === button || button.contains(hit)))) {
        misses.push({ x: Math.round(point.x), y: Math.round(point.y), hit: describe(hit) });
        if (hit !== null && hit.closest(".latest-row, .latest-button") !== null) latestHits.push({ x: Math.round(point.x), y: Math.round(point.y) });
      }
    }
    return {
      label: labels.find((label) => (button.textContent ?? "").includes(label)) ?? "?",
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      fullyInsideTranscript: rect.top >= scrollerRect.top - 0.5 && rect.bottom <= scrollerRect.bottom + 0.5,
      misses,
      latestHits,
    };
  });
  // Only the part of an option that is actually painted: the transcript clips at
  // its own edges, so an option scrolled past them is not on screen there and the
  // composer it sits under covers nothing the reader can see.
  const painted = measured
    .map((option) => ({
      left: Math.max(option.rect.left, scrollerRect.left),
      right: Math.min(option.rect.right, scrollerRect.right),
      top: Math.max(option.rect.top, scrollerRect.top),
      bottom: Math.min(option.rect.bottom, scrollerRect.bottom),
    }))
    .filter((rect) => rect.right - rect.left > 1 && rect.bottom - rect.top > 1);
  const stackedOverlaps = [];
  for (const element of document.querySelectorAll("body *")) {
    if (card && (card.contains(element) || element.contains(card))) continue;
    const zIndex = Number(getComputedStyle(element).zIndex);
    if (!Number.isFinite(zIndex) || zIndex < 10) continue;
    const rect = element.getBoundingClientRect();
    const overlaps = painted.some((option) =>
      rect.left < option.right - 0.5 && rect.right > option.left + 0.5 &&
      rect.top < option.bottom - 0.5 && rect.bottom > option.top + 0.5);
    if (overlaps) stackedOverlaps.push({ tag: element.tagName.toLowerCase(), cls: element.getAttribute("class") ?? "", zIndex });
  }
  return {
    distanceToBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    latestPresent: document.querySelector(".latest-row") !== null,
    cardFound: card !== undefined,
    options: measured,
    stackedOverlaps: stackedOverlaps.slice(0, 8),
  };
}`;

async function probe(page: Page): Promise<OverlayProbe> {
  const result = await page.evaluate(`(${PROBE})(${JSON.stringify(OPTION_LABELS)})`);
  expect(result, "the transcript region must exist").not.toBeNull();
  return result as OverlayProbe;
}

/** A transcript long enough to scroll at 430x932, so "detached" is reachable. */
async function seedHistory(page: Page, host: MockCollabHost, entries = 12): Promise<void> {
  await host.send(welcomeFrame(false));
  for (let index = 0; index < entries; index += 1) {
    await host.send({
      t: "entry",
      entry: createUserMessageEntry(`overlay-${index}`, `Transcript line ${index}: ${"older content ".repeat(24)}`, index + 1),
    });
  }
  await expect(page.locator(".message-card")).toHaveCount(entries);
}

/**
 * Detach the list by 100px — past `TAIL_THRESHOLD_PX` (80), so the affordance's
 * gate is satisfied — and confirm the detach SURVIVES a settle window.
 *
 * Retried, because the tail pin legitimately re-snaps to the bottom while the
 * seeded rows are still being measured: measured, the first scroll is overwritten
 * once and later attempts hold. A detach the pin erased is not the reader's, so
 * it is attempted again rather than trusted.
 */
async function detachBy100(page: Page): Promise<number> {
  let distance = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.evaluate(() => {
      const scroller = document.querySelector(".messages-scroll")!;
      scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 100;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 250)));
    distance = await page.evaluate(() => {
      const scroller = document.querySelector(".messages-scroll")!;
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    });
    if (distance >= 100) return distance;
  }
  throw new Error(`could not detach the transcript: distance to tail stayed at ${distance}`);
}

for (const viewport of VIEWPORTS) {
  test(`an approval keeps every option tappable while detached at ${viewport.name}`, async ({ page }) => {
    const fixture = harnessFixture();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
    await openSeededConversation(page);
    await seedHistory(page, host);
    await host.send({ t: "ui-request", request: MOCK_APPROVAL_REQUEST });
    await expect(page.getByRole("heading", { name: "Approval Requested" })).toBeVisible();

    await detachBy100(page);
    const geometry = await probe(page);
    const at = viewport.name;

    expect(geometry.cardFound, `${at}: approval card must be present`).toBe(true);
    expect(geometry.options.length, `${at}: every approval option is measured`).toBe(3);
    expect(geometry.distanceToBottom, `${at}: the list must be detached, not at the tail`).toBeGreaterThan(80);

    // The real hit test: a grid inside every option that is fully on screen must
    // land on that option, not on whatever floats above it.
    const visible = geometry.options.filter((option) => option.fullyInsideTranscript);
    expect(visible.length, `${at}: at least two options are fully on screen`).toBeGreaterThanOrEqual(2);
    for (const option of visible) {
      expect(option.misses, `${at}: "${option.label}" must be tappable across its whole area`).toEqual([]);
    }

    // The fix, asserted directly: no floating affordance exists while a request
    // is pending, so it cannot cover an option at any width.
    expect(geometry.latestPresent, `${at}: the jump-to-latest row must not render while an approval is pending`).toBe(false);

    // And no control stacked at z-index >= 10 may overlap any option.
    expect(geometry.stackedOverlaps, `${at}: stacked controls over approval options`).toEqual([]);
  });
}

test("the jump-to-latest control still works when no approval is pending", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 320, height: 568 });
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await seedHistory(page, host);
  const composer = page.getByRole("textbox", { name: /Send a follow-up|Turn in flight/ });
  const latest = page.locator(".latest-row");

  // Detached, no approval: the feature must still be there, at the same detach
  // offset the approval tests use.
  const distance = await detachBy100(page);
  expect(distance).toBeGreaterThanOrEqual(100);
  await expect(latest).toBeVisible();

  // The row's two older gates, asserted so a future edit cannot widen it back
  // over an overlay: a suggestion list and an intercepted command own that band.
  await composer.fill("/");
  await expect(page.locator(".command-suggestion").first()).toBeVisible();
  await expect(latest, "no jump affordance while command suggestions are open").toHaveCount(0);
  await composer.fill("");
  await expect(latest, "affordance returns once the suggestions are gone").toBeVisible();
  await composer.fill("/model");
  // A phone is a coarse pointer, so Enter inserts a newline rather than sending
  // (`shouldSubmitOnEnter`); the Send control is the send path here.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".slash-command-intercept")).toBeVisible();
  await expect(latest, "no jump affordance while a slash command is intercepted").toHaveCount(0);
  await page.locator(".slash-command-intercept").getByRole("button", { name: "Cancel" }).click();
  // Cancel only clears the interception; the draft still starts with "/" so the
  // suggestion list stays open and legitimately keeps the row hidden.
  await composer.fill("");
  await expect(latest).toBeVisible();

  // Clicking it returns to the tail and the control disappears.
  await latest.getByRole("button", { name: /Latest/ }).click();
  const after = await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll")!;
    return { scrollTop: scroller.scrollTop, bottom: scroller.scrollHeight - scroller.clientHeight, latest: document.querySelector(".latest-row") !== null };
  });
  expect(after.scrollTop).toBe(after.bottom);
  expect(after.latest).toBe(false);
});

test("the regression, named: at 320px no point on an approval option hits the latest control", async ({ page }) => {
  const fixture = harnessFixture();
  await page.setViewportSize({ width: 320, height: 568 });
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await seedHistory(page, host);
  await host.send({ t: "ui-request", request: MOCK_APPROVAL_REQUEST });
  await expect(page.getByRole("heading", { name: "Approval Requested" })).toBeVisible();
  await detachBy100(page);
  const geometry = await probe(page);

  // The control's real box pre-fix was y 440..484, x 230..308; every option that
  // reaches that box must now be hit-testable across its own area, and no sampled
  // point may land in `.latest-row` / `.latest-button`.
  const visible = geometry.options.filter((entry) => entry.fullyInsideTranscript);
  expect(visible.length).toBeGreaterThanOrEqual(2);
  for (const option of visible) {
    expect(option.latestHits, `320x568: "${option.label}" must not be covered by the latest control`).toEqual([]);
    expect(option.misses, `320x568: "${option.label}" must be the hit target at every sampled point`).toEqual([]);
  }
  expect(geometry.latestPresent, "320x568: the jump-to-latest row must be absent while an approval is pending").toBe(false);
});
