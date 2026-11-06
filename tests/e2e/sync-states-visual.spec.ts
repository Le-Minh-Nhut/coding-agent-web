import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createAssistantMessageEntry,
  createUserMessageEntry,
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  type MockCollabHost,
} from "./fixture.js";

/**
 * The synchronization states as the user sees them, plus the viewport matrix.
 *
 * The point of this file is that the empty, loading, progress, verified-empty and
 * disconnected states must be *distinguishable* — the original defect was one
 * screen saying "No prompts yet" for all of them. Each state is asserted on its
 * own visible copy and captured to a PNG for the owner.
 *
 * Each state is its own test: the app keeps the open screen in React state and has
 * no URL for it, so a test that wants a second state must start from the project
 * list, which only a fresh page provides.
 *
 * Geometry is asserted with bounding boxes (this lane cannot read pixels; the
 * screenshots are written for human review, exactly as round 54 does).
 */

const SCREENS_DIR = process.env.CAW_SCREENS_DIR ?? join(tmpdir(), "caw-screens");
const COMPOSER = /Send a follow-up…|Turn in flight — send a follow-up…|Read-only/;

const VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: "320x568", width: 320, height: 568 },
  { name: "375x667", width: 375, height: 667 },
  { name: "390x844", width: 390, height: 844 },
  { name: "430x932", width: 430, height: 932 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1440x900", width: 1440, height: 900 },
];

test.beforeAll(() => {
  mkdirSync(SCREENS_DIR, { recursive: true });
});

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

async function openConversation(page: Page): Promise<MockCollabHost> {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();
  return host;
}

function welcome(entryCount: number): Record<string, unknown> {
  return {
    t: "welcome",
    proto: 3,
    header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" },
    state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] },
    agents: [],
    entryCount,
  };
}

test("state: loading an existing conversation says so, and never claims it is empty", async ({ page }) => {
  const host = await openConversation(page);
  await host.send(welcome(3238));
  await host.send({ t: "snapshot-chunk", entries: [createUserMessageEntry("u0", "first", 1)], final: false });

  await expect(page.getByText("Loading conversation…")).toBeVisible();
  await expect(page.getByText("No prompts yet")).toBeHidden();
  await page.screenshot({ path: join(SCREENS_DIR, "state-01-loading.png") });

  // Progress is the host's own count, shown as it arrives.
  await host.send({ t: "snapshot-chunk", entries: [createUserMessageEntry("u1", "second", 2)], final: false });
  await expect(page.locator(".empty-state-sub")).toContainText("2 of 3238");
  await page.screenshot({ path: join(SCREENS_DIR, "state-02-progress.png") });
});

test("state: a verified-empty conversation is the only one that says it is empty", async ({ page }) => {
  const host = await openConversation(page);
  await host.send(welcome(0));
  await expect(page.getByText("Start the conversation")).toBeVisible();
  await expect(page.getByText("This session has no prompts yet.")).toBeVisible();
  await page.screenshot({ path: join(SCREENS_DIR, "state-03-verified-empty.png") });
});

test("state: a populated conversation renders its rows", async ({ page }) => {
  const host = await openConversation(page);
  await host.send(welcome(2));
  await host.send({
    t: "snapshot-chunk",
    entries: [
      createUserMessageEntry("p0", "Why does the snapshot stall?", 1),
      createAssistantMessageEntry("p1", "Because the relay closed the socket mid-flight.", 2),
    ],
    final: true,
  });
  await expect(page.locator(".messages-scroll .message-card")).toHaveCount(2);
  await page.screenshot({ path: join(SCREENS_DIR, "state-04-populated.png") });
});

test("state: a dropped connection keeps history and says the link is down", async ({ page }) => {
  const host = await openConversation(page);
  await host.send(welcome(1));
  await host.send({ t: "snapshot-chunk", entries: [createUserMessageEntry("d0", "kept through the drop", 1)], final: true });
  await expect(page.locator(".messages-scroll .message-card")).toHaveCount(1);

  await host.drop();
  await expect(page.locator(".banner").filter({ hasText: /reconnect|disconnect/i }).first()).toBeVisible();
  // The verified row survives: a dropped socket is not a lost transcript.
  await expect(page.getByText("kept through the drop")).toBeVisible();
  await page.screenshot({ path: join(SCREENS_DIR, "state-05-disconnected.png") });
});

test("the empty state is centred in the transcript and clear of the composer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const host = await openConversation(page);
  await host.send(welcome(0));
  await expect(page.getByText("Start the conversation")).toBeVisible();

  const state = page.locator(".empty-state");
  const scroll = page.locator(".messages-scroll");
  const composer = page.locator("textarea.composer-input");
  const stateBox = await state.boundingBox();
  const scrollBox = await scroll.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(stateBox && scrollBox && composerBox).toBeTruthy();

  expect(stateBox!.y).toBeGreaterThanOrEqual(scrollBox!.y - 1);
  expect(stateBox!.y + stateBox!.height).toBeLessThanOrEqual(scrollBox!.y + scrollBox!.height + 1);
  expect(stateBox!.y + stateBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);

  const topGap = stateBox!.y - scrollBox!.y;
  const bottomGap = scrollBox!.y + scrollBox!.height - (stateBox!.y + stateBox!.height);
  expect(Math.abs(topGap - bottomGap), `not centred (top ${Math.round(topGap)}, bottom ${Math.round(bottomGap)})`).toBeLessThan(60);
  // Deliberately no screenshot here: the assertion above is the proof, and a
  // capture of this state would be byte-identical to the verified-empty one.
});

test("a long prompt does not take over the screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const host = await openConversation(page);
  const longPrompt = Array.from({ length: 60 }, (_, i) => `line ${i} of a very long prompt`).join("\n");
  await host.send(welcome(1));
  await host.send({ t: "snapshot-chunk", entries: [createUserMessageEntry("long", longPrompt, 1)], final: true });

  // Whether the bound comes from collapsing the row or from the transcript
  // scrolling, what matters is that neither the composer nor the screen is
  // displaced, and that the prompt does not own the whole viewport.
  const card = await page.locator(".messages-scroll .message-card").boundingBox();
  const scroll = await page.locator(".messages-scroll").boundingBox();
  const composer = await page.locator("textarea.composer-input").boundingBox();
  expect(card, "the long prompt must be laid out").not.toBeNull();
  expect(card!.height, "a long prompt took over the transcript").toBeLessThan(scroll!.height);
  expect(composer!.y + composer!.height).toBeLessThanOrEqual(845);
  await page.screenshot({ path: join(SCREENS_DIR, "state-07-long-prompt.png") });
});

for (const viewport of VIEWPORTS) {
  test(`layout holds at ${viewport.name} with no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const host = await openConversation(page);
    await host.send(welcome(2));
    await host.send({
      t: "snapshot-chunk",
      entries: [
        createUserMessageEntry("v0", "A prompt long enough to wrap on a narrow screen, twice over, to exercise the wrapping path rather than a single short token.", 1),
        createAssistantMessageEntry("v1", "An answer with `inline code` and a list:\n- one\n- two\n- three", 2),
      ],
      final: true,
    });
    await expect(page.locator(".messages-scroll .message-card")).toHaveCount(2);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, "the document scrolls horizontally").toBeLessThanOrEqual(overflow.clientWidth + 1);

    const composer = await page.locator("textarea.composer-input").boundingBox();
    expect(composer, "composer not laid out").not.toBeNull();
    expect(composer!.y + composer!.height, "composer below the fold").toBeLessThanOrEqual(viewport.height + 1);

    const scroll = await page.locator(".messages-scroll").boundingBox();
    expect(scroll!.height, "transcript has no usable height").toBeGreaterThan(80);

    const headerOverflow = await page
      .locator(".app-header")
      .first()
      .evaluate((el) => el.scrollWidth - el.clientWidth)
      .catch(() => 0);
    expect(headerOverflow, "header overflows").toBeLessThanOrEqual(1);

    await page.screenshot({ path: join(SCREENS_DIR, `viewport-${viewport.name}.png`) });
  });
}
