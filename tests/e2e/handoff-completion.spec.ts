import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { harnessFixture, installMockCollabHost, openSeededConversation, requireAppServer, welcomeFrame } from "./fixture.js";

/**
 * Handoff completion notification.
 *
 * The requirement: the user must be told when the native OMP handoff has
 * actually completed — never when the command was merely delivered to the pane.
 * A `delivered` answer proves the keystrokes landed and nothing more, so these
 * specs pin the whole lifecycle: delivered alone is NOT success, and success
 * appears only when the server has read a commit out of the native journal.
 *
 * The durable record is a `handoff-committed` event, which is also what makes the
 * outcome survive a reload (the client cannot see a native compaction over
 * Collab — the wire entry carries no `method`).
 */

const COMPOSER = /Send a follow-up…|Turn in flight — send a follow-up…|Read-only/;

test.beforeEach(async ({ request }: { request: APIRequestContext }) => {
  await requireAppServer(request);
});

/** A handoff response shape, as the route returns it. */
function handoffResponse(state: "delivered" | "committed", extra: Record<string, unknown> = {}): unknown {
  return { ok: true, data: { state, paneId: "0", ...extra } };
}

/** Intercept the handoff POST and answer with `body`. */
async function mockHandoff(page: Page, body: unknown, status = 200): Promise<void> {
  await page.route("**/api/conversations/*/handoff", async (route) => {
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
}

type Event = { seq: number; type: string; ts: string; payload: unknown };

/**
 * Intercept the events read. `events` may be a function so a spec can serve one
 * timeline for the pre-paste baseline read and a later one for the reconciliation
 * poll — which is the only way to model "the commit appeared after the paste".
 * Events are newest-last, as the API returns them.
 */
async function mockEvents(page: Page, events: Event[] | (() => Event[])): Promise<void> {
  await page.route("**/api/conversations/*/events*", async (route) => {
    const body = typeof events === "function" ? events() : events;
    // Honour the real cursors. A mock that ignores them cannot tell a forward read
    // from a newest-N window, and would pass whether or not the bug is present.
    const url = new URL(route.request().url());
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    let page_ = body;
    if (after !== null) {
      // Forward: ascending, strictly greater than the cursor, oldest `limit`.
      page_ = body.filter((event) => event.seq > Number(after)).slice(0, limit);
    } else {
      // Backward (the default): the newest `limit`, ascending.
      page_ = body.filter((event) => before === null || event.seq < Number(before)).slice(-limit);
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { events: page_, nextAfter: null, nextBefore: null } }),
    });
  });
}

/** Open the conversation and the handoff card, so the run button is reachable. */
async function openHandoffPanel(page: Page): Promise<void> {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  // "Handoff context" is the menu item; the confirmation card it opens is a
  // `role="group"` with the same accessible name, and *its* button runs it.
  await page.getByRole("button", { name: "Handoff context" }).click();
  const card = page.getByRole("group", { name: "Handoff context" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Run handoff" }).click();
}

test("delivered alone is never reported as completed", async ({ page }) => {
  await mockHandoff(page, handoffResponse("delivered"));
  // The journal never produces a commit, so the honest answer stays "delivered".
  await mockEvents(page, [{ seq: 1, type: "handoff-start", ts: "2026-01-01T00:00:00Z", payload: {} }]);
  await openHandoffPanel(page);

  const banner = page.locator(".banner").filter({ hasText: /handoff/i });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Handoff delivered");
  await expect(banner, "delivery must never be worded as completion").not.toContainText(/Handoff completed|context compacted successfully/i);
  // The tone is not success: this is an unconfirmed operation.
  await expect(banner).toHaveClass(/running/);
});

test("journal evidence turns the same operation into a completion notification", async ({ page }) => {
  await mockHandoff(page, handoffResponse("delivered"));
  // The baseline read happens before the paste, so it cannot already contain this
  // operation's commit; the commit appears only on the later poll. Modelling it
  // the other way would test nothing.
  let pasted = false;
  await mockEvents(page, () => [
    { seq: 1, type: "handoff-start", ts: "2026-01-01T00:00:00Z", payload: {} },
    ...(pasted ? [{ seq: 2, type: "handoff-committed", ts: "2026-01-01T00:01:00Z", payload: { entryId: "comp-42" } }] : []),
  ]);
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/handoff")) pasted = true;
  });
  await openHandoffPanel(page);

  const banner = page.locator(".banner").filter({ hasText: /handoff|Handoff completed/i });
  await expect(banner).toContainText(/Handoff completed/i, { timeout: 20_000 });
  await expect(banner).toHaveClass(/success/);
});

test("an earlier handoff's commit cannot acknowledge a new one", async ({ page }) => {
  await mockHandoff(page, handoffResponse("delivered"));
  // The timeline already holds a commit from a *previous* handoff, at or below the
  // baseline this operation reads before its paste. Correlating by the store's
  // sequence number is what stops that old evidence from being reported as this
  // operation's success — the exact fabrication the state machine forbids.
  await mockEvents(page, [
    { seq: 5, type: "handoff-committed", ts: "2026-01-01T00:00:00Z", payload: { entryId: "comp-old" } },
  ]);
  await openHandoffPanel(page);

  const banner = page.locator(".banner").filter({ hasText: /handoff/i });
  await expect(banner).toContainText(/Handoff delivered/i);
  await expect(banner, "an old commit must not be reported as this operation's success").not.toContainText(/Handoff completed/i);
  await expect(page.locator(".banner.success")).toHaveCount(0);
});

test("a commit beyond a window of unrelated events is still found", async ({ page }) => {
  // F1: the reconciler used to read the newest N events, so a busy stream could
  // push the commit out of view and the banner would stay "delivered" forever on
  // evidence that exists. It now reads FORWARD from this operation's baseline.
  await mockHandoff(page, handoffResponse("delivered"));
  let pasted = false;
  await mockEvents(page, () => {
    const noiseBefore = Array.from({ length: 120 }, (_, i) => ({ seq: 10 + i, type: "agent.launched", ts: "2026-01-01T00:00:00Z", payload: {} }));
    // The commit is BURIED, not newest: a session that keeps working after the
    // compaction writes more unrelated events, so a newest-N window slides past
    // the commit while a forward read from the baseline still contains it. That
    // ordering is the whole point — with the commit as the newest event, even the
    // broken window would find it and the test would prove nothing.
    const noiseAfter = Array.from({ length: 120 }, (_, i) => ({ seq: 200 + i, type: "agent.exited", ts: "2026-01-01T00:02:00Z", payload: {} }));
    return [
      { seq: 5, type: "handoff-start", ts: "2026-01-01T00:00:00Z", payload: {} },
      ...noiseBefore,
      ...(pasted
        ? [
            { seq: 130, type: "handoff-committed", ts: "2026-01-01T00:01:00Z", payload: { entryId: "comp-buried" } },
            ...noiseAfter,
          ]
        : []),
    ];
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/handoff")) pasted = true;
  });
  await openHandoffPanel(page);

  const banner = page.locator(".banner").filter({ hasText: /Handoff completed|Handoff delivered/i });
  await expect(banner).toContainText(/Handoff completed/i, { timeout: 20_000 });
  await expect(banner).toContainText("comp-buried");
});

test("a committed result is reported immediately, without waiting", async ({ page }) => {
  await mockHandoff(page, handoffResponse("committed", { compactionEntryId: "comp-7" }));
  await mockEvents(page, []);
  await openHandoffPanel(page);

  const banner = page.locator(".banner").filter({ hasText: /Handoff completed/i });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveClass(/success/);
});

test("an agent refusal is reported as a refusal, never as success", async ({ page }) => {
  await mockHandoff(page, handoffResponse("delivered", { refused: true }));
  await mockEvents(page, []);
  await openHandoffPanel(page);

  const banner = page.locator(".banner").filter({ hasText: /refus/i });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/declined|refused/i);
  await expect(banner).not.toHaveClass(/success/);
});

test("a delivery failure is reported as an error", async ({ page }) => {
  await mockHandoff(page, { ok: false, error: { code: "conflict_owner", message: "The recorded process is not the live one." } }, 409);
  await mockEvents(page, []);
  await openHandoffPanel(page);

  const alert = page.locator(".banner.error").filter({ hasText: /process|live|handoff/i });
  await expect(alert).toBeVisible();
  await expect(page.locator(".banner.success")).toHaveCount(0);
});

test("a handoff already generating is refused by name, and claims nothing", async ({ page }) => {
  await mockHandoff(page, { ok: false, error: { code: "handoff_in_flight", message: "A handoff is already generating for this conversation." } }, 409);
  await mockEvents(page, []);
  await openHandoffPanel(page);

  await expect(page.locator(".banner.error")).toContainText(/already/i);
  await expect(page.locator(".banner.success")).toHaveCount(0);
});

test("navigating away from the handoff panel leaves the notification available", async ({ page }) => {
  await mockHandoff(page, handoffResponse("committed", { compactionEntryId: "comp-9" }));
  await mockEvents(page, []);
  await openHandoffPanel(page);

  // The card closes itself on a settled outcome, so the banner is already what the
  // user sees — and it lives on the conversation, not inside the panel.
  const banner = page.locator(".banner.success");
  await expect(banner).toBeVisible();
  await expect(page.getByRole("group", { name: "Handoff context" })).toHaveCount(0);

  // It survives interacting with the rest of the screen: open and close the
  // overflow menu, which is the panel the handoff was launched from.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.keyboard.press("Escape");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/Handoff completed/i);
});

test("the mobile viewport keeps the notification clear of the composer", async ({ page }) => {
  await mockHandoff(page, handoffResponse("committed", { compactionEntryId: "comp-11" }));
  await mockEvents(page, []);
  await openHandoffPanel(page);

  const banner = page.locator(".banner.success");
  await expect(banner).toBeVisible();
  const bannerBox = await banner.boundingBox();
  const composerBox = await page.locator("textarea.composer-input").boundingBox();
  expect(bannerBox, "the banner must be laid out").not.toBeNull();
  expect(composerBox, "the composer must be laid out").not.toBeNull();
  // The banner sits above the composer and does not cover it.
  expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
  // And the transcript is still scrollable underneath.
  await expect(page.locator(".messages-scroll")).toBeVisible();
});
