import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { harnessFixture, installMockCollabHost, mockConversationLink, openSeededConversation, requireAppServer, statusBanner, welcomeFrame } from "./fixture.js";

/**
 * The conversation screen, driven against a mocked Collab host (never a real
 * agent — see tests/e2e/README.md). The claims under test come from
 * docs/architecture/mobile-client.md: the composer is reachable on a phone, the
 * "we do not know" states are distinct, and a conversation with no live agent
 * offers attach instructions instead of an endless spinner.
 *
 * The conversation is the one seeded by `scripts/e2e-server.mjs`; the app keeps
 * its current screen in React state, so each test opens the screen once rather
 * than reloading (a reload would return to the project list).
 */

const COMPOSER = /Send instructions to agent|Turn in flight/;

/** Open a conversation with the given link response already in place. */
async function openWithLink(page: Page, response: unknown, status: number): Promise<void> {
  await mockConversationLink(page, response, status);
  await openSeededConversation(page);
}

test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
  await requireAppServer(request);
});

test("composer is bottom-anchored and reachable at the mobile viewport", async ({ page }) => {
  const fixture = harnessFixture();
  await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);

  const composer = page.getByRole("textbox", { name: COMPOSER });
  await expect(composer).toBeVisible();

  const box = await composer.boundingBox();
  expect(box, "the composer must be laid out").not.toBeNull();
  expect(box!.y + box!.height, "the composer must fit inside the 390x844 viewport").toBeLessThanOrEqual(845);
  expect(box!.y, "the composer must sit at the bottom of the screen").toBeGreaterThan(600);

  // Reachable means focusable by touch, not merely present in the DOM.
  await composer.click();
  await expect(composer).toBeFocused();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});

test("a conversation with no live host offers attach instructions, not an endless spinner", async ({ page }) => {
  await openWithLink(page, { ok: false, error: { code: "link_unavailable", message: "No live host for this conversation" } }, 409);

  const attach = page.getByRole("heading", { name: /no live agent to attach to/i });
  await expect(attach).toBeVisible();

  // The card must hand the user something actionable: either the real tmux
  // command, or (when the conversation has no managed session) how to find one.
  const guidance = page.getByText(/How to attach in terminal|omp session list/i);
  await expect(guidance.first()).toBeVisible();

  // Not a spinner that never ends: nothing is still loading.
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByText(/^Loading…$/)).toHaveCount(0);

  // And it does not claim to be disconnected: there was never a connection.
  const text = (await attach.textContent()) ?? "";
  expect(text).not.toMatch(/disconnect/i);
});

test("unknown is its own state: never idle, never disconnected", async ({ page }) => {
  await openWithLink(page, { ok: false, error: { code: "link_unavailable", message: "No live host for this conversation" } }, 409);

  const unknown = statusBanner(page).filter({ hasText: /unknown/i });
  await expect(unknown).toBeVisible();
  await expect(unknown).toContainText(/cannot be determined/i);

  const text = (await unknown.textContent()) ?? "";
  expect(text).not.toMatch(/disconnect/i);
  expect(text).not.toMatch(/idle|ready for prompt|stopped/i);

  // The no-live-agent card and the unknown banner are two different statements.
  await expect(page.getByRole("heading", { name: /no live agent to attach to/i })).toBeVisible();
});

test("a refused room is reported as disconnected, with a way back", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();

  // The relay refuses a second host for the room; that is terminal for now.
  await host.closeFatal();

  const disconnected = statusBanner(page).filter({ hasText: /disconnect/i });
  await expect(disconnected).toBeVisible();
  await expect(disconnected).toContainText(/connection lost|already connected/i);
  const text = (await disconnected.textContent()) ?? "";
  expect(text, "disconnected must not be reported as unknown or idle").not.toMatch(/unknown|idle|ready for prompt/i);

  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("a connected host reports a turn in flight, then settles without claiming completion", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();

  // The send is awaited so the state change is applied before asserting: the
  // frame travels through a real WebSocket, so "Stop" appears a tick later.
  await host.send(welcomeFrame(true));
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 15_000 });

  await host.send(welcomeFrame(false));
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 15_000 });
  // Settling is never announced to the user as idle/finished.
  await expect(statusBanner(page).filter({ hasText: /idle|ready for prompt|finished|completed/i })).toBeHidden();
});

test("a prompt sent to a live host reaches it exactly once", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();

  await host.send(welcomeFrame(false));
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await composer.fill("summarise the failing test");
  await page.getByRole("button", { name: "Send" }).click();

  await expect.poll(() => host.prompts.length, "the prompt must be delivered once").toBe(1);
  expect(host.prompts[0]).toBe("summarise the failing test");

  // Double-tapping send while the turn is in flight must not queue it twice.
  await page.getByRole("button", { name: "Send" }).click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(200);
  expect(host.prompts.length).toBe(1);
});
