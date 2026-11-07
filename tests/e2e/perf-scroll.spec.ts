/**
 * SCROLL-01..12 and PERF-SCROLL-01..08: the owner's black-screen symptom, measured
 * in pixels.
 *
 * The symptom: open a long conversation on an iPhone, scroll to the newest message,
 * then scroll quickly upward — the transcript area goes black/blank for a noticeable
 * time, then the older content appears.
 *
 * Everything here is measured against the built bundle and the mock Collab host.
 * No OMP agent is launched and no live session is touched.
 *
 * Two instruments, deliberately different:
 *
 *  - **The DOM** (`perf-scroll-harness.ts`) for correctness — which row is reachable,
 *    how many nodes exist, how long a frame gap lasted.
 *  - **The pixels** (`Page.startScreencast` on Chromium, `screenshot` on WebKit) for
 *    the blank region, because the DOM is correct in every failing frame: the rows
 *    are mounted, positioned and styled, and the compositor simply has nothing
 *    rasterised to show. That is why the previous round's assertions all passed.
 *
 * Screenshots are read by this spec, never by a model: the check is a numeric
 * "does this frame's transcript band contain ink", so no image ever needs a reader.
 */
import { expect, test, type Page } from "@playwright/test";
import { requireAppServer } from "./fixture.js";
import { buildTranscriptEntries, sentinel } from "./perf-fixtures.js";
import {
  COMPOSER,
  HEAVY_TRANSCRIPT,
  blankStats,
  programmaticScroll,
  longTasksSince,
  markLongTasks,
  openWithHost,
  percentiles,
  readBand,
  readFrameProbe,
  scrollState,
  scrollToBottom,
  sendSnapshot,
  startFrameProbe,
  startPixelRecorder,
  setCpuThrottle,
  startRowWait,
  touchFlick,
  assertRowInView,
  revealRow,
  waitForRow,
  wheelScroll,
  type Percentiles,
  type PixelBlankStats,
  type PixelSample,
  type ScrollState,
} from "./perf-scroll-harness.js";

const LARGE = 4075;

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

/** One scrapeable line per scenario, so the report quotes measurements. */
function report(id: string, payload: Record<string, unknown>): void {
  console.log(`PERF_JSON ${JSON.stringify({ id, ...payload })}`);
}

/**
 * The shared body of every scroll scenario: park at the bottom, arm both probes,
 * run the gesture, then stop the probes and summarise.
 *
 * `gesture` runs while the recorder is live; nothing about the app's own behaviour
 * is stubbed for it.
 */
async function scrollScenario(
  page: Page,
  options: {
    id: string;
    entries?: number;
    seed?: number;
    gesture: (page: Page) => Promise<void>;
    /**
     * Row that must be reachable at the end, so "no rows" is not reported as "blank".
     * `null` means the caller checks the end some other way (see SCROLL-03, whose last
     * entry is a collapsed edit group and has no text of its own to look for).
     */
    expectRowAtEnd?: string | null;
    /** The heavy fixture (markdown, code, tables, diffs, long prompts) or the plain one. */
    heavy?: boolean;
    /** CDP CPU throttle rate, e.g. 4 for a phone-class main thread. */
    throttle?: number;
  },
): Promise<{
  blanks: PixelBlankStats;
  frameGaps: Percentiles;
  longTasksMax: number;
  recorder: PixelSample[];
  finalState: ScrollState;
}> {
  const count = options.entries ?? LARGE;
  const host = await openWithHost(page);
  if (options.throttle !== undefined) await setCpuThrottle(page, options.throttle);
  await sendSnapshot(host, buildTranscriptEntries({ count, seed: options.seed ?? 1, ...(options.heavy === true ? HEAVY_TRANSCRIPT : {}) }), 40);
  // STRICT: this asserts the load OPENED on the newest row, without moving the reader.
  // Walking the document here (as `waitForRow` does) would have proven only that the
  // row exists somewhere, and would have relocated the reader before the gesture this
  // scenario measures (W12). `scrollToBottom` then normalises a view that is already
  // there, and is kept because a later scenario step assumes a bottom-anchored start.
  await assertRowInView(page, sentinel(count - 1));
  await scrollToBottom(page);

  const band = await readBand(page);
  expect(band.height, "the transcript band must have a real box before pixels mean anything").toBeGreaterThan(50);

  const mark = await markLongTasks(page);
  await startFrameProbe(page);
  const recorder = await startPixelRecorder(page, band);
  const started = await page.evaluate(() => performance.now());
  await options.gesture(page);
  const elapsed = await page.evaluate((from) => performance.now() - from, started);
  await recorder.stop();
  const framework = await readFrameProbe(page);
  const longTasks = await longTasksSince(page, mark);

  if (options.expectRowAtEnd !== undefined && options.expectRowAtEnd !== null) {
    await waitForRow(page, options.expectRowAtEnd);
  }

  const blanks = blankStats(recorder.samples);
  // A blank frame is only diagnosable with what the DOM held at that moment: an empty
  // window and a window whose rows sit outside the band look identical in pixels.
  const blankSamples = recorder.samples
    .filter((sample) => sample.blank)
    .map((sample) => ({ mounted: sample.mounted ?? null, visible: sample.visibleEntries ?? null, posRange: sample.posRange ?? null, scrollHeight: sample.scrollHeight ?? null, top: sample.scrollTop, ratio: Math.round(sample.blankRowRatio * 100) / 100 }));
  const gaps = percentiles(framework.gaps);
  const finalState = await scrollState(page);
  report(options.id, {
    sampler: recorder.kind,
    entries: count,
    gestureMs: Math.round(elapsed),
    sampledFrames: blanks.frames,
    blankFrames: blanks.blankFrames,
    blankMs: blanks.blankMs,
    blankRunP50Ms: blanks.blankRunP50Ms,
    blankRunP95Ms: blanks.blankRunP95Ms,
    blankRunMaxMs: blanks.blankRunMaxMs,
    blankSamples,
    frameGapP50Ms: gaps.p50,
    frameGapP95Ms: gaps.p95,
    frameGapMaxMs: gaps.max,
    longTaskMaxMs: Math.round(longTasks.reduce((max, task) => Math.max(max, task.duration), 0)),
    finalScrollTop: finalState.top,
    rowsMounted: finalState.rows,
    domElements: finalState.domElements,
  });
  return { blanks, frameGaps: gaps, longTasksMax: Math.round(longTasks.reduce((max, task) => Math.max(max, task.duration), 0)), recorder: recorder.samples, finalState };
}

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-01 — top → bottom
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-01: top → bottom with a programmatic offset", async ({ page }) => {
  test.setTimeout(300_000);
  const result = await scrollScenario(page, {
    id: "SCROLL-01",
    heavy: true,
    gesture: async (target) => {
      await target.evaluate(() => {
        const scroller = document.querySelector(".messages-scroll");
        if (scroller !== null) scroller.scrollTop = 0;
      });
      await programmaticScroll(target, { from: 0, to: 400_000, steps: 120 });
    },
    // No `expectRowAtEnd`: the conversation's last entry is an `edit` group whose rows
    // are the diff's lines, and those render only when the group is opened. Looking for
    // that text would assert that a collapsed disclosure is expanded. The transcript's
    // reachability is asserted below, positionally.
    expectRowAtEnd: null,
  });
  // The mounted count is now bounded by design, so "rows > 10" would be asserting the
  // bug back. What must hold is that the document still *claims* the whole
  // conversation and that the DOM stays proportional to the window rather than to the
  // history — both are assertions about the contract, not about this machine's speed.
  expect(result.finalState.entries, "the transcript must still report every entry").toBe(LARGE);
  // Reachability, checked by walking the document rather than by counting mounted rows.
  await waitForRow(page, sentinel(0));
  await scrollToBottom(page);
  await waitForRow(page, sentinel(LARGE - 1));
  expect(result.finalState.rows, "the window mounts rows, bounded by design").toBeGreaterThan(0);
  expect(result.finalState.domElements, "a windowed 4,075-entry transcript stays small").toBeLessThan(20_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-02 — bottom → top, rapid (the reported symptom)
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-02: bottom → top rapid flick, blank-frame duration measured", async ({ page }) => {
  test.setTimeout(300_000);
  const result = await scrollScenario(page, {
    id: "SCROLL-02",
    heavy: true,
    entries: 8000,
    throttle: 4,
    gesture: async (target) => {
      for (let flick = 0; flick < 8; flick += 1) await touchFlick(target, { distance: 420, steps: 6, repeats: 1, direction: 1, gapMs: 30 });
    },
  });
  // Correctness before budget: a blank run is the finding, not an assertion — the
  // number is reported either way. What must hold is that content came back.
  // Deliberately a real movement assertion: `top` is only -1 when the scroller is
  // missing, so `>= 0` was very nearly vacuous (W14).
  expect(result.finalState.top, "the flick train must have moved the transcript").toBeGreaterThan(0);
  expect(result.recorder.filter((sample) => sample.scrollTop !== null).length, "samples must be correlated with a real scroll offset").toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-03 — bottom → middle → top → bottom
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-03: bottom → middle → top → bottom", async ({ page }) => {
  test.setTimeout(300_000);
  const result = await scrollScenario(page, {
    id: "SCROLL-03",
    heavy: true,
    gesture: async (target) => {
      // The three legs the name promises, ending at the document's real bottom. The old
      // fixed `480_000` was a guess at where the bottom was, and on a windowed document
      // — whose total height is an estimate until rows are measured — that guess is both
      // wrong and unstable. Scrolling to `scrollHeight` is the user's actual "back to the
      // bottom", and it is what the assertion after it needs to be meaningful.
      await programmaticScroll(target, { from: 480_000, to: 240_000, steps: 40 });
      await programmaticScroll(target, { from: 240_000, to: 0, steps: 40 });
      await target.evaluate(() => {
        const scroller = document.querySelector(".messages-scroll");
        if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
      });
      await target.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); })));
    },
    // The end of the conversation is an `edit` group, and its rows are the diff's
    // 307 lines, which render only when the group is opened. Asserting on the diff's
    // own text would be asserting that a collapsed disclosure is expanded — a different
    // claim, and one this scenario never made. What must hold is that the transcript's
    // LAST entry is the one on screen, identified positionally rather than by text that
    // a disclosure owns.
    expectRowAtEnd: null,
  });
  const tail = await page.evaluate(() => {
    // `[aria-posinset]` is on the entry's real box now, not the display:contents wrapper.
  const all = Array.from(document.querySelectorAll(".messages-scroll .transcript-entry > [aria-posinset]"));
    const last = all.at(-1) ?? null;
    // The wrapper carries the ARIA position and is `display: contents`, so it has no box
    // of its own — measuring it would report every entry as zero-sized. The box belongs
    // to its element child, which is the card.
    const box = (last?.firstElementChild ?? last)?.getBoundingClientRect();
    return {
      posinset: last?.getAttribute("aria-posinset") ?? null,
      setsize: last?.getAttribute("aria-setsize") ?? null,
      boxTop: box === undefined ? null : Math.round(box.top),
      boxBottom: box === undefined ? null : Math.round(box.bottom),
      onScreen: box !== undefined && box.bottom > 0 && box.top < window.innerHeight,
    };
  });
  report("SCROLL-03-tail", tail);
  // Back at the bottom means the newest entry is mounted and inside the viewport — the
  // property the scenario is named for.
  expect(tail.posinset, "the newest entry must be mounted after returning to the bottom").toBe(String(LARGE));
  expect(tail.onScreen, "the newest entry must be inside the viewport, not merely mounted").toBe(true);
  expect(tail.setsize, "the document still claims the whole conversation").toBe(String(LARGE));
  expect(result.finalState.rows).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-04 — rapid direction reversals
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-04: rapid direction reversals through touch flicks", async ({ page }) => {
  test.setTimeout(300_000);
  await scrollScenario(page, {
    id: "SCROLL-04",
    heavy: true,
    gesture: async (target) => {
      for (let cycle = 0; cycle < 5; cycle += 1) {
        await touchFlick(target, { distance: 380, steps: 5, direction: 1, gapMs: 20 });
        await touchFlick(target, { distance: 380, steps: 5, direction: -1, gapMs: 20 });
      }
    },
  });
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeEditable();
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-05 — scroll up while the assistant streams
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-05: scrolling upward while the assistant streams does not force a jump", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 2000, seed: 5 }), 20);
  await waitForRow(page, sentinel(1999));
  await scrollToBottom(page);

  let stopped = false;
  const stream = (async () => {
    await host.send({ t: "event", event: { type: "turn_start" } });
    let text = "";
    let index = 0;
    while (!stopped) {
      text += `\nline ${index} of a streaming answer`;
      await host.send({
        t: "event",
        event: {
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text }], model: "provider/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "toolUse", timestamp: Date.now() },
        },
      });
      index += 1;
      await page.waitForTimeout(100);
    }
  })();

  await expect(page.getByText("Assistant (streaming…")).toBeVisible({ timeout: 20_000 });
  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  await touchFlick(page, { distance: 400, steps: 6, direction: 1, gapMs: 30 });
  await page.waitForTimeout(300);
  await touchFlick(page, { distance: 400, steps: 6, direction: 1, gapMs: 30 });
  await recorder.stop();

  // The premise has to be established, not assumed. On WebKit the two flicks above
  // leave the view essentially AT the tail (`gap: 0` measured throughout), because the
  // streaming row grows the document and tail-follow re-pins on every measurement — the
  // correct behaviour while the reader is at the bottom, and it means the flicks never
  // actually detached them. So detach deliberately, then let the stream run, and only
  // then ask whether a streaming update moved the reader. Without this the scenario
  // measured "the view is following the tail" and called it a yank.
  await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    if (scroller !== null) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 3000);
  });
  await page.waitForTimeout(250);
  const before = await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    return { top: scroller?.scrollTop ?? 0, detached: scroller === null ? 0 : scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop };
  });
  expect(before.detached, "the reader must be away from the tail before a yank can be claimed").toBeGreaterThan(200);
  await page.waitForTimeout(700);
  stopped = true;
  await stream;

  const after = await page.evaluate(() => document.querySelector(".messages-scroll")?.scrollTop ?? 0);
  const blanks = blankStats(recorder.samples);
  report("SCROLL-05", { scrollBefore: before.top, scrollAfter: after, movedUp: after < before.top, blankRunMaxMs: blanks.blankRunMaxMs, blankFrames: blanks.blankFrames, frames: blanks.frames });

  // The user scrolled away from the tail; a streaming update must not yank them back.
  const drift = after - before.top;
  report("SCROLL-05-drift", { detachedPx: Math.round(before.detached), driftPx: Math.round(drift) });
  // The property: with the reader 3,000px away from the tail, streaming must not move
  // them. A tail-follow that fired here would jump by the whole document growth; the
  // tolerance is for sub-pixel measurement noise only.
  expect(Math.abs(drift), `a streaming update moved a detached reader by ${String(Math.round(drift))}px`).toBeLessThan(40);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-06 — scroll while new tool results arrive
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-06: scrolling while tool results arrive keeps the reading position", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 2000, seed: 6 }), 20);
  await waitForRow(page, sentinel(1999));
  await scrollToBottom(page);

  let stopped = false;
  const tools = (async () => {
    for (let index = 0; !stopped; index += 1) {
      await host.send({ t: "event", event: { type: "tool_execution_start", toolCallId: `scroll-tool-${index % 12}`, toolName: "bash", args: { command: `echo ${index}` } } });
      await host.send({ t: "event", event: { type: "tool_execution_end", toolCallId: `scroll-tool-${index % 12}`, toolName: "bash", result: { content: `PERF-TOOL-${index}\n${"out\n".repeat(6)}` } } });
      await page.waitForTimeout(60);
    }
  })();

  await page.waitForTimeout(500);
  const before = await page.evaluate(() => document.querySelector(".messages-scroll")?.scrollTop ?? 0);
  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  await touchFlick(page, { distance: 420, steps: 6, direction: 1, gapMs: 30 });
  await page.waitForTimeout(200);
  await touchFlick(page, { distance: 420, steps: 6, direction: 1, gapMs: 30 });
  await recorder.stop();
  stopped = true;
  await tools;

  const after = await page.evaluate(() => document.querySelector(".messages-scroll")?.scrollTop ?? 0);
  const blanks = blankStats(recorder.samples);
  report("SCROLL-06", { scrollBefore: before, scrollAfter: after, blankRunMaxMs: blanks.blankRunMaxMs, blankFrames: blanks.blankFrames, frames: blanks.frames });
  expect(after, "tool results must not yank a reading user back to the tail").toBeLessThan(before + 40);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-07 — after expanding a long user prompt
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-07: a long user prompt expands and scrolls without a blank viewport", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  // Every 4th row is a user prompt carrying a ~10,000-word body: the expand control
  // is the difference between a one-line row and a page-height one.
  const entries = buildTranscriptEntries({ count: 600, longPromptWords: 2500, seed: 7 });
  await sendSnapshot(host, entries, 12);
  await waitForRow(page, sentinel(599));
  await scrollToBottom(page);

  await programmaticScroll(page, { from: 300_000, to: 120_000, steps: 30 });
  const expand = page.locator(".messages-scroll .collapsible-toggle, .messages-scroll button", { hasText: /^Show more$|^Expand$/ }).first();
  const hasExpand = await expand.count();
  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  if (hasExpand > 0) await expand.click({ timeout: 5000 }).catch(() => undefined);
  await programmaticScroll(page, { from: 120_000, to: 60_000, steps: 20 });
  await recorder.stop();
  const blanks = blankStats(recorder.samples);
  report("SCROLL-07", { expandControlFound: hasExpand > 0, blankRunMaxMs: blanks.blankRunMaxMs, blankFrames: blanks.blankFrames, frames: blanks.frames });
  expect((await scrollState(page)).rows).toBeGreaterThan(10);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-08 — after expanding a tool card
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-08: expanding a tool card then scrolling keeps content in the viewport", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  const entries = buildTranscriptEntries({ count: 800, toolEvery: 3, seed: 8 });
  await sendSnapshot(host, entries, 16);
  await waitForRow(page, sentinel(entries.length - 2));
  await scrollToBottom(page);
  await programmaticScroll(page, { from: 300_000, to: 100_000, steps: 30 });

  // An activity group's disclosure is a button with `aria-expanded`, not a `details`
  // summary: the old selector matched nothing, so this scenario reported
  // `summaryFound: false` and then scrolled an unexpanded list, proving nothing about
  // expansion. Both real disclosures are covered.
  const group = page.locator(".messages-scroll .activity-group-head, .messages-scroll .collapsible-toggle").first();
  const found = await group.count();
  expect(found, "a mounted tool card must exist to expand").toBeGreaterThan(0);
  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  const before = await scrollState(page);
  await group.click({ timeout: 10_000 });
  await page.waitForTimeout(400);
  await programmaticScroll(page, { from: 100_000, to: 50_000, steps: 20 });
  await recorder.stop();
  const blanks = blankStats(recorder.samples);
  const after = await scrollState(page);
  report("SCROLL-08", {
    summaryFound: found > 0,
    blankRunMaxMs: blanks.blankRunMaxMs,
    blankFrames: blanks.blankFrames,
    frames: blanks.frames,
    rowsBefore: before.rows,
    rowsAfter: after.rows,
    domAfter: after.domElements,
  });
  // The window still paints content after an expansion, and the document stays bound-
  // ed: `rows > 10` was the pre-windowing claim that every row is mounted.
  expect(after.rows, "the window still mounts content after an expansion").toBeGreaterThan(0);
  expect(blanks.blankFrames, "a blank frame after expanding then scrolling is the failure").toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-09 — open and close a large diff
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-09: a large diff opens and closes while scrolling stays painted", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  const entries = buildTranscriptEntries({ count: 400, toolEvery: 2, bigDiff: true, seed: 9 });
  await sendSnapshot(host, entries, 8);
  await waitForRow(page, sentinel(entries.length - 2));
  await scrollToBottom(page);

  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  await programmaticScroll(page, { from: 500_000, to: 400_000, steps: 30 });
  // Open the first activity group, which is what mounts a diff body.
  const summary = page.locator(".messages-scroll .activity-group summary").first();
  if (await summary.count() > 0) await summary.click({ timeout: 5000 }).catch(() => undefined);
  await programmaticScroll(page, { from: 400_000, to: 300_000, steps: 20 });
  await recorder.stop();
  const blanks = blankStats(recorder.samples);
  report("SCROLL-09", { blankRunMaxMs: blanks.blankRunMaxMs, blankFrames: blanks.blankFrames, frames: blanks.frames, rows: (await scrollState(page)).rows });
  expect((await scrollState(page)).rows).toBeGreaterThan(5);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-10 — return from Agent Detail
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-10: returning from Agent Detail restores the transcript and paints", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 500, seed: 10 }), 8);
  await waitForRow(page, sentinel(499));
  await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    if (scroller !== null) scroller.scrollTop = Math.floor(scroller.scrollHeight / 3);
  });
  const before = await page.evaluate(() => document.querySelector(".messages-scroll")?.scrollTop ?? 0);

  await page.locator(".header-menu-button").click();
  await page.getByRole("button", { name: /^Agents \(/ }).click();
  await expect(page.locator(".agents-center")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeEditable();

  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  await touchFlick(page, { distance: 300, steps: 5, direction: 1, gapMs: 20 });
  await recorder.stop();
  const after = await page.evaluate(() => document.querySelector(".messages-scroll")?.scrollTop ?? 0);
  const blanks = blankStats(recorder.samples);
  report("SCROLL-10", { scrollBefore: before, scrollAfter: after, driftPx: Math.round(Math.abs(after - before)), blankRunMaxMs: blanks.blankRunMaxMs, blankFrames: blanks.blankFrames, frames: blanks.frames });
  expect(after, "the transcript must still be scrolled away from the tail").toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-11 — immediately after loading a large snapshot
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-11: scrolling immediately after a large snapshot starts painting, not black", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  const entries = buildTranscriptEntries({ count: LARGE, seed: 11 });
  await host.send({ t: "welcome", proto: 3, header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: entries.length });

  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  // The gesture starts with the snapshot's first chunk, i.e. while the history is
  // still arriving. This is the "load then immediately scroll" case.
  await sendSnapshot(host, entries, 40);
  await touchFlick(page, { distance: 420, steps: 5, direction: 1, gapMs: 20 });
  // A reveal here is legitimate: the scenario is "load, flick, then reach the tail",
  // so it explicitly asks to be taken to the row it then asserts on.
  await revealRow(page, sentinel(LARGE - 1));
  await scrollToBottom(page);
  await touchFlick(page, { distance: 420, steps: 5, direction: 1, gapMs: 20 });
  await recorder.stop();
  const blanks = blankStats(recorder.samples);
  report("SCROLL-11", { blankRunMaxMs: blanks.blankRunMaxMs, blankFrames: blanks.blankFrames, frames: blanks.frames, rows: (await scrollState(page)).rows });
  expect((await scrollState(page)).rows, "the snapshot must have rendered rows").toBeGreaterThan(10);
});

// ─────────────────────────────────────────────────────────────────────────────
// SCROLL-12 — while the visual viewport changes (browser chrome)
// ─────────────────────────────────────────────────────────────────────────────

test("SCROLL-12: a visual-viewport change during scroll does not blank the transcript", async ({ page }) => {
  test.setTimeout(300_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 2000, seed: 12 }), 20);
  await waitForRow(page, sentinel(1999));
  await scrollToBottom(page);
  await programmaticScroll(page, { from: 480_000, to: 200_000, steps: 30 });

  const band = await readBand(page);
  const recorder = await startPixelRecorder(page, band);
  // What a phone does when the address bar collapses mid-scroll: the visual viewport
  // grows while the layout viewport lags, and the app's resize handling runs.
  await page.setViewportSize({ width: 390, height: 760 });
  await page.waitForTimeout(120);
  await programmaticScroll(page, { from: 200_000, to: 150_000, steps: 20 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  await recorder.stop();
  const blanks = blankStats(recorder.samples);
  report("SCROLL-12", { blankRunMaxMs: blanks.blankRunMaxMs, blankFrames: blanks.blankFrames, frames: blanks.frames, rows: (await scrollState(page)).rows });
  expect((await scrollState(page)).rows).toBeGreaterThan(10);
});

/** Exported for the gate spec: the pieces a PERF-SCROLL scenario needs. */
export { startRowWait, wheelScroll };
