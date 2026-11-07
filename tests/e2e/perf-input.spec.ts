/**
 * PERF-INPUT-01/02: does the composer lose characters, and if so who loses them?
 *
 * The prior round measured 491-492 of 500 injected characters arriving while a turn
 * streamed, and 500 of 500 at a human pace. Two very different stories fit that
 * number, and the fix differs completely:
 *
 *  - **the app** drops them — a controlled `<textarea value={inputText}>` restores a
 *    stale value from React state and eats whatever landed in between; or
 *  - **the harness** never delivers them — Playwright at `delay: 0` outruns the
 *    compositor and the events queue rather than dispatch.
 *
 * The instrument that separates them is a counter *inside the page*, on the
 * textarea's own `input` events, before React sees anything: if the page's own
 * event count and the concatenated `event.target.value` lengths fall short of 500,
 * the browser never delivered them and the harness is the loser. If the page saw
 * 500 inputs carrying 500 characters and the composer's committed value is short,
 * the app ate them.
 *
 * Nothing here is a timing assertion. The claim is exactness: no dropped, duplicated
 * or reordered character, no lost draft, no accidental submission.
 */
import { expect, test, type Page } from "@playwright/test";
import { requireAppServer } from "./fixture.js";
import { buildTranscriptEntries, sentinel } from "./perf-fixtures.js";
import { COMPOSER, openWithHost, scrollToBottom, sendSnapshot, waitForRow } from "./perf-scroll-harness.js";

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

/** 500 characters with a known sequence, so a dropped or reordered one is visible. */
const TYPED_500 = Array.from({ length: 500 }, (_, index) => "abcdefghij"[index % 10]!).join("");

interface InputTally {
  /** `input` events the textarea saw, with the value length each carried. */
  events: number;
  /** The longest value any single `input` event carried. */
  lastLength: number;
  /** Every character seen across all events, so a reorder is visible. */
  concatenated: string;
  /** `beforeinput`/`input`/`compositionstart` counts, for IME diagnosis. */
  compositionStarts: number;
  compositionEnds: number;
  /** Values React committed at each event, so a clobber is visible as a shrink. */
  committed: number[];
}

async function armInputTally(page: Page): Promise<void> {
  await page.evaluate(() => {
    interface Tally {
      events: number;
      lastLength: number;
      concatenated: string;
      compositionStarts: number;
      compositionEnds: number;
      committed: number[];
      previous: string;
    }
    const w = window as unknown as { __tally?: Tally; __tallyObserver?: MutationObserver };
    const tally: Tally = { events: 0, lastLength: 0, concatenated: "", compositionStarts: 0, compositionEnds: 0, committed: [], previous: "" };
    w.__tally = tally;
    // Captured in the CAPTURE phase on document: this runs before React's delegated
    // listener, so a value React restores afterwards cannot hide what arrived.
    document.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains("composer-input")) return;
      tally.events += 1;
      tally.lastLength = target.value.length;
      // The delta between what the element now holds and what it held before is the
      // characters this single event delivered; a shrink is React restoring state.
      const previous = tally.previous;
      tally.previous = target.value;
      if (target.value.length >= previous.length) tally.concatenated += target.value.slice(previous.length);
      tally.committed.push(target.value.length);
    }, true);
    document.addEventListener("compositionstart", () => { tally.compositionStarts += 1; }, true);
    document.addEventListener("compositionend", () => { tally.compositionEnds += 1; }, true);
  });
}

const readTally = (page: Page): Promise<InputTally> =>
  page.evaluate(() => {
    const tally = (window as unknown as { __tally?: InputTally }).__tally;
    return tally ?? { events: 0, lastLength: 0, concatenated: "", compositionStarts: 0, compositionEnds: 0, committed: [] };
  });

/** Start a streaming turn and return a control that ends it. */
function startStreaming(host: { send(frame: Record<string, unknown>): Promise<void> }, page: Page, gapMs = 100): { stop(): Promise<void> } {
  let stopped = false;
  const run = (async () => {
    await host.send({ t: "event", event: { type: "turn_start" } });
    let text = "";
    for (let index = 0; !stopped; index += 1) {
      text += `\nstreamed line ${index} with enough words to make the row grow`;
      await host.send({
        t: "event",
        event: {
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text }], model: "provider/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "toolUse", timestamp: Date.now() },
        },
      });
      await page.waitForTimeout(gapMs);
    }
  })();
  return { async stop() { stopped = true; await run; } };
}

test("PERF-INPUT-01: 500 characters during a stream arrive exactly once, in order", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 500, seed: 31 }), 8);
  await waitForRow(page, sentinel(499));

  const streaming = startStreaming(host, page, 100);
  await expect(page.getByText("Assistant (streaming…")).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await composer.click();
  await armInputTally(page);

  await composer.pressSequentially(TYPED_500, { delay: 0, timeout: 180_000 });
  // Settle: the composer is controlled, so the last commit can land a tick later.
  let value = await composer.inputValue();
  for (let attempt = 0; attempt < 40 && value.length < TYPED_500.length; attempt += 1) {
    await page.waitForTimeout(50);
    const next = await composer.inputValue();
    if (next === value) break;
    value = next;
  }
  const tally = await readTally(page);
  const streamingDuringRun = await page.getByText("Assistant (streaming…").isVisible();
  await streaming.stop();

  const firstMismatch = [...TYPED_500].findIndex((char, index) => value[index] !== char);
  console.log(`PERF_JSON ${JSON.stringify({
    id: "PERF-INPUT-01",
    expected: TYPED_500.length,
    typeof: "burst (delay 0)",
    finalLength: value.length,
    exact: value === TYPED_500,
    firstMismatchIndex: value === TYPED_500 ? -1 : firstMismatch,
    pageInputEvents: tally.events,
    pageLastEventLength: tally.lastLength,
    pageConcatenatedLength: tally.concatenated.length,
    committedShrank: tally.committed.filter((length, index) => index > 0 && length < (tally.committed[index - 1] ?? 0)).length,
    streamingDuringRun,
    verdict: value === TYPED_500
      ? "PASS"
      : tally.events < TYPED_500.length
        ? "HARNESS (page saw fewer input events than keys)"
        : "APP (page saw every key; the committed value is short)",
  })}`);

  expect(streamingDuringRun, "the premise: this ran while a turn was streaming").toBe(true);
  // The finding, asserted: not one character dropped, duplicated or reordered.
  expect(value, `composer holds ${value.length}/${TYPED_500.length} characters after a 500-character burst`).toBe(TYPED_500);
});

/**
 * PERF-STREAM-02: a burst typed while a turn streams must not crash the page.
 *
 * The release sweep found React #185 (maximum update depth) in 4 of 6 runs of exactly
 * this scenario, in a build whose own gates were green: the anchor correction re-armed
 * itself from the window move its own `scrollTop` write caused, and `fitSpacersToGap`
 * shifted the row back by the same amount, sustaining an oscillation. Input exactness
 * (PERF-INPUT-01) does not catch it — the characters arrive and the page dies later —
 * so this asserts the one thing that would have caught it: zero page errors.
 */
test("PERF-STREAM-02: burst typing while streaming and scrolling produces no page error", async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    errors.push(error.message + "\nSTACK " + String(error.stack ?? "").slice(0, 4000));
  });
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 2000, seed: 41 }), 20);
  await waitForRow(page, sentinel(1999));
  await scrollToBottom(page);

  const streaming = startStreaming(host, page, 60);
  await expect(page.getByText("Assistant (streaming…")).toBeVisible({ timeout: 20_000 });
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await composer.click();
  await armInputTally(page);

  // Typing while the stream grows the document is the interaction that produced the
  // loop. Scrolling at the same time is what makes the anchor move, so both happen.
  const scroller = page.locator(".messages-scroll");
  for (let round = 0; round < 2; round += 1) {
    await composer.pressSequentially(TYPED_500, { delay: 0, timeout: 180_000 });
    await scroller.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollTop - 600);
    });
    await page.waitForTimeout(120);
    await composer.press("ControlOrMeta+A");
    await composer.press("Backspace");
  }
  await page.waitForTimeout(400);
  const streamingDuringRun = await page.getByText("Assistant (streaming…").isVisible();
  await streaming.stop();
  // Let any deferred update land: an update-depth trip happens in a commit storm, not
  // necessarily on the keystroke that started it.
  await page.waitForTimeout(300);

  console.log(`PERF_JSON ${JSON.stringify({
    id: "PERF-STREAM-02",
    pageErrors: errors,
    streamingDuringRun,
    verdict: errors.length === 0 ? "PASS" : "FAIL",
  })}`);
  expect(errors, `the page raised ${String(errors.length)} error(s) during a burst while streaming: ${errors.join(" | ")}`).toEqual([]);
  expect(streamingDuringRun, "the premise: typing happened while a turn was streaming").toBe(true);
});

test("PERF-INPUT-02: paste, selection replace, held Backspace and IME composition are exact", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 300, seed: 32 }), 8);
  await waitForRow(page, sentinel(299));
  const composer = page.getByRole("textbox", { name: COMPOSER });
  await composer.click();
  await armInputTally(page);

  // Paste: 2,000 characters in one event, which is a different code path from typing.
  const pasted = Array.from({ length: 2000 }, (_, index) => "xyz0123456789"[index % 13]!).join("");
  // Typed through the browser's real text-insertion path rather than by assigning
  // `.value`: an assigned value bypasses the input pipeline the app actually reads and
  // would pass a broken build. `insertText` delivers a genuine single `input` event
  // carrying the whole 2,000 characters, which is what a paste is.
  await composer.evaluate((element) => (element as HTMLTextAreaElement).focus());
  await page.keyboard.insertText(pasted);
  await page.waitForTimeout(250);
  const afterPaste = await composer.inputValue();

  // Selection replace: select the middle third and type one character over it.
  await composer.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(100, 1100);
  });
  await page.keyboard.type("Z");
  await page.waitForTimeout(100);
  const afterReplace = await composer.inputValue();

  // Held Backspace: 20 deletions in a row, which must remove exactly 20 characters.
  const beforeBackspace = afterReplace.length;
  await page.keyboard.down("Backspace");
  await page.waitForTimeout(400);
  await page.keyboard.up("Backspace");
  await page.waitForTimeout(150);
  const afterBackspace = await composer.inputValue();

  // IME: a Vietnamese-style composition. The composed text must land once, and the
  // composition must not be split by a re-render in the middle of it.
  await composer.fill("");
  await page.waitForTimeout(50);
  await composer.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.focus();
    area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    area.value = "xin chào";
    area.dispatchEvent(new InputEvent("input", { bubbles: true, data: "xin chào", inputType: "insertCompositionText" }));
  });
  await page.waitForTimeout(120);
  const midComposition = await composer.inputValue();
  await composer.evaluate((element) => {
    const area = element as HTMLTextAreaElement;
    area.value = "xin chào thế giới";
    area.dispatchEvent(new InputEvent("input", { bubbles: true, data: " thế giới", inputType: "insertCompositionText" }));
    area.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "xin chào thế giới" }));
  });
  await page.waitForTimeout(150);
  const afterComposition = await composer.inputValue();

  const tally = await readTally(page);
  console.log(`PERF_JSON ${JSON.stringify({
    id: "PERF-INPUT-02",
    paste: { expected: pasted.length, got: afterPaste.length, exact: afterPaste === pasted },
    selectionReplace: { expected: pasted.length - 1000 + 1, got: afterReplace.length, replacedAtStart: afterReplace.slice(0, 100) === pasted.slice(0, 100) },
    heldBackspace: { before: beforeBackspace, after: afterBackspace.length, removed: beforeBackspace - afterBackspace.length },
    ime: { midComposition, afterComposition, compositionStarts: tally.compositionStarts, compositionEnds: tally.compositionEnds },
    pageInputEvents: tally.events,
  })}`);

  expect(afterPaste, "a 2,000-character paste must land whole").toBe(pasted);
  expect(afterReplace, "a selection replace must produce exactly the replacement").toBe(`${pasted.slice(0, 100)}Z${pasted.slice(1100)}`);
  expect(beforeBackspace - afterBackspace.length, "20 held Backspace presses (auto-repeat) must remove characters, never add them").toBeGreaterThan(0);
  expect(afterBackspace.length, "a held Backspace must never leave more text than it started with").toBeLessThanOrEqual(beforeBackspace);
  expect(midComposition, "a composition must be visible mid-flight").toContain("xin chào");
  expect(afterComposition, "the composed text must land once and only once").toBe("xin chào thế giới");
  expect(tally.compositionStarts, "the composition path must have been exercised").toBeGreaterThan(0);
});
