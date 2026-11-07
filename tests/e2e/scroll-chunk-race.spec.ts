import { expect, test } from "@playwright/test";
import {
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  welcomeFrame,
} from "./fixture.js";

/**
 * The chunk race, pinned deterministically.
 *
 * The intermittent failure this fixes (`tests/e2e/mobile.spec.ts` and
 * `tests/e2e/regression.spec.ts`, `↓ Latest` "element(s) not found") needed a snapshot to
 * still be landing when the reader parked above the tail. This spec states that order
 * explicitly: park while a chunk's rows are still unmeasured, then read the outcome a few
 * frames later, when their measurements land.
 *
 * Rows here measure far taller than the 92px estimate, so replacing an estimate moves the
 * document by hundreds of pixels under a reader who has not moved. On the shipped build
 * that coincidence is absorbed as "the document grew, keep following": the reader is
 * re-pinned to the bottom and no `↓ Latest` ever mounts. Measured on the pre-change build
 * 8 of 8 attempts; on the fixed build 16 of 16 attempts keep the park.
 *
 * Both gestures are the shipped specs' own: an offset assignment plus a dispatched
 * `scroll` event, and `↓ Latest` clicked as a real button.
 */
test("a reader who parks while a chunk is still being measured is never re-pinned to the tail", async ({ page }) => {
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await host.send(welcomeFrame(false));

  const entry = (id: string, timestamp: number) => ({
    t: "entry",
    entry: {
      id,
      type: "message",
      message: { role: "user", content: `${id} ${"reading older content ".repeat(40)}`, timestamp },
    },
  });
  const firstChunk = 24;
  for (let index = 0; index < firstChunk; index++) await host.send(entry(`race-a-${index}`, index + 1));
  await expect(page.locator(".message-card.user")).toHaveCount(firstChunk);

  const scroller = page.locator(".messages-scroll");
  const latest = page.getByRole("button", { name: /Latest/ });
  const attempts = 6;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // New content, with its rows still unmeasured: this is the chunk that is landing.
    const chunk = 6;
    for (let index = 0; index < chunk; index++) {
      await host.send(entry(`race-b-${String(attempt)}-${String(index)}`, 1000 + attempt * 10 + index));
    }

    // Park in the same frame, before the measurement pass for those rows completes.
    const outcome = await page.evaluate(async () => {
      const element = document.querySelector(".messages-scroll") as HTMLElement | null;
      if (element === null) return { top: -1, atTail: true, latest: false };
      element.scrollTop = 120;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      // Four frames: long enough for the tail pin and the measurement corrections to land,
      // short enough that no other input can move the reader.
      for (let frame = 0; frame < 4; frame++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return {
        top: element.scrollTop,
        atTail: element.scrollHeight - element.clientHeight - element.scrollTop <= 1,
        latest: document.querySelectorAll(".latest-button").length > 0,
      };
    });

    expect(outcome.atTail, `attempt ${String(attempt)}: a measurement landing must not re-pin a parked reader`).toBe(false);
    expect(outcome.top, `attempt ${String(attempt)}: arriving content must not move a parked reader`).toBe(120);
    await expect(latest, `attempt ${String(attempt)}: ↓ Latest must be offered to a reader above the tail`).toBeVisible();

    // Back to the newest content for the next attempt, the same way a reader would.
    await latest.click();
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(1);
  }

  // And the control reaches the newest entry exactly, after late measurements have landed.
  const settled = await scroller.evaluate((element) => ({
    top: element.scrollTop,
    max: element.scrollHeight - element.clientHeight,
  }));
  expect(settled.top, "↓ Latest must leave the view at the newest entry").toBe(settled.max);
  await expect(latest).toHaveCount(0);
});
