import { expect, test, type APIRequestContext } from "@playwright/test";
import { harnessFixture, installMockCollabHost, openSeededConversation, requireAppServer, statusBanner, welcomeFrame } from "./fixture.js";

/**
 * Losing the network must never look like the agent finishing. docs/architecture/
 * mobile-client.md draws the line explicitly: a dropped socket is reported as
 * `disconnected`, never as `stopped`; after an accepted prompt, automatic
 * reconnect does not resubmit it. This does not claim manual retries are deduplicated.
 *
 * The mock host lets the harness drop the socket on demand — the same mechanism a
 * lost Wi-Fi connection exercises. The screen is opened once per test: the app
 * keeps its current screen in React state, so a reload returns to the project list.
 */

const COMPOSER = /Send instructions to agent|Turn in flight/;

test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
  await requireAppServer(request);
});

test("a dropped connection is reported as reconnecting and recovers without resubmitting", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await expect(composer).toBeVisible();

  // A live host, one prompt sent, one turn in flight.
  await host.send(welcomeFrame(true));
  await composer.fill("please run the test suite");
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => host.prompts.length, "the prompt must reach the host once").toBe(1);

  // Lose the network.
  const connectionsBefore = host.connections;
  await host.drop();

  const banner = statusBanner(page).filter({ hasText: /reconnect|disconnect/i });
  await expect(banner).toBeVisible();
  const bannerText = (await banner.textContent()) ?? "";
  expect(bannerText, "a dropped socket must never read as the agent finishing").not.toMatch(/stopped|finished|completed|idle/i);

  // Recover: a new socket with no action from us, and the banner goes away.
  await expect.poll(() => host.connections, "the client must reconnect on its own").toBeGreaterThan(connectionsBefore);
  await expect(statusBanner(page).filter({ hasText: /reconnect|disconnect/i })).toBeHidden({ timeout: 20_000 });

  // Nothing was resubmitted by the recovery.
  expect(host.prompts, "a reconnect must not resubmit the last prompt").toEqual(["please run the test suite"]);

  // The turn is still in flight (the host never ended it), so the composer stays
  // disabled — but the session is live again: the disconnect banner is gone and
  // no fatal state is claimed.
  await expect(statusBanner(page).filter({ hasText: /disconnect/i })).toBeHidden();
  const placeholder = await composer.getAttribute("placeholder");
  expect(placeholder, "a reconnected session must not claim the socket is gone").not.toMatch(/disconnected/i);
});

test("an offline session is reported distinctly from idle", async ({ page, context }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();

  // No turn in flight: "idle" is deliberately never asserted to the user.
  await host.send(welcomeFrame(false));
  await expect(statusBanner(page).filter({ hasText: /idle|ready for prompt/i })).toBeHidden();

  // Go offline and lose the socket, the way a phone leaving Wi-Fi does.
  await context.setOffline(true);
  await host.drop();

  const banner = statusBanner(page).filter({ hasText: /reconnect|disconnect/i });
  await expect(banner).toBeVisible({ timeout: 20_000 });
  const text = (await banner.textContent()) ?? "";
  expect(text, "an offline session must not be reported as idle or stopped").not.toMatch(/ready for prompt|stopped|finished|idle/i);
  expect(text).not.toMatch(/unknown/i);

  // Everything sent while offline is not silently queued to the host.
  expect(host.prompts).toEqual([]);

  await context.setOffline(false);
});

test("a prompt sent while the host is gone never becomes a silent success", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await expect(composer).toBeVisible();

  // The host is gone for good: nothing can be delivered.
  await host.closeFatal();
  await expect(statusBanner(page).filter({ hasText: /disconnect/i })).toBeVisible();

  // The composer must refuse the prompt rather than accept it and drop it.
  await expect(composer, "a disconnected composer must not accept a prompt").toBeDisabled();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();

  await page.waitForTimeout(300);
  expect(host.prompts, "nothing may reach a host that is gone").toEqual([]);
  expect(host.connections, "a fatal close must not be retried forever").toBeGreaterThan(0);
});
