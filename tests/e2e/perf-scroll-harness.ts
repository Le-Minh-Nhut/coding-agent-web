/**
 * The instrument for the owner's symptom: a long conversation turns black while
 * scrolling quickly upwards on a phone.
 *
 * Why the measurement looks like this:
 *
 *  - **The claim is about pixels, not the DOM.** Every DOM-level check reports
 *    that the rows are mounted, positioned and styled — which is true, and is why
 *    the previous round's assertions all passed while the owner still saw black.
 *    So the primary instrument is a Chromium **screencast**: the compositor's own
 *    frames, decoded and scanned for a transcript-shaped hole with no ink in it.
 *  - **Blank is defined structurally, not by a colour.** The transcript region is
 *    the band between the header and the composer, and a row of it is blank when it
 *    holds no pixel brighter than the app background (text, card borders, user
 *    bubbles and link ink are all above that floor). A frame is blank when 98% of
 *    its rows are. An assistant-only screen (transparent cards) is therefore *not*
 *    blank: it has glyphs.
 *  - **Gestures are real where it matters.** `scrollTop` assignment measures the
 *    layout/paint path; `mouse.wheel` and CDP `Input.dispatchTouchEvent` flick
 *    trains measure the compositor path the thumb actually drives, including
 *    momentum. Both are run, and reported apart.
 *
 * WebKit has no CDP and no screencast, so it is sampled with
 * `page.screenshot({ animations: "disabled" })` in a parallel loop. That is a real
 * composited capture, but slower per sample, which is why the sample counts differ
 * between browsers and are reported rather than compared.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { decodePng } from "./png.js";
import { buildSnapshotFrames, sentinel, type PerfEntry } from "./perf-fixtures.js";
import { harnessFixture, installMockCollabHost, openSeededConversation, type MockCollabHost } from "./fixture.js";

const COMPOSER = /Send a follow-up…|Turn in flight — send a follow-up…|Read-only/;

export { COMPOSER };

// ─────────────────────────────────────────────────────────────────────────────
// Opening a conversation with a large history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A transcript with the shape the owner's conversation actually has: long Markdown,
 * big fenced code blocks, wide tables, hundreds of tool cards, multi-hundred-line
 * diffs, long prompts. The plain generator produces rows that are one line tall, and
 * a one-line row costs the compositor almost nothing to raster — which is why a
 * blank-region measurement against it comes back clean while the phone is black.
 */
export const HEAVY_TRANSCRIPT = {
  toolEvery: 6,
  withSubagents: true,
  withAdvisorNotes: true,
  bigMarkdown: true,
  bigDiff: true,
  longPromptWords: 40,
} as const;

/**
 * Throttle the renderer's CPU, the way a phone is slower than this machine.
 *
 * CDP has this and WebKit does not, so on WebKit the throttle is skipped and the
 * report says `throttle: null` — a WebKit run is then a *less* throttled measurement
 * than the Chromium one, which is the safe direction for a "did it blank" claim.
 */
export async function setCpuThrottle(page: Page, rate: number): Promise<void> {
  if (!isChromium(page)) return;
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate });
  await client.detach().catch(() => undefined);
}

export async function openWithHost(page: Page): Promise<MockCollabHost> {
  // The long-task observer has to be installed before any app script runs, so it is
  // armed here rather than by the caller after the page has already loaded.
  await installLongTaskProbe(page);
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);
  await expect(page.getByRole("textbox", { name: COMPOSER })).toBeVisible();
  return host;
}

export const welcomeFor = (count: number, streaming = false): Record<string, unknown> => ({
  t: "welcome",
  proto: 3,
  header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" },
  state: { isStreaming: streaming, queuedMessageCount: 0, cwd: "/workspace", participants: [] },
  agents: [],
  entryCount: count,
});

export async function sendSnapshot(host: MockCollabHost, entries: readonly PerfEntry[], chunkCount = 24): Promise<void> {
  await host.send(welcomeFor(entries.length));
  for (const frame of buildSnapshotFrames(entries, { chunkCount })) await host.send({ ...frame });
}

/**
 * Wait until `marker` is MOUNTED AND IN THE VIEWPORT — without scrolling.
 *
 * This is the strict helper, and it is the one a scenario whose premise is *position*
 * must use: "the row the load should have opened on is on screen". It never moves the
 * reader, because a measurement that relocates what it measures is not a measurement —
 * a full-document walk proves only that a row exists somewhere, which is exactly the
 * weaker claim `revealRow` makes (W12).
 */
export async function assertRowInView(page: Page, marker: string, timeout = 30_000): Promise<void> {
  await expect.poll(() => page.evaluate((want) => {
    const scroller = document.querySelector(".messages-scroll");
    const band = scroller?.getBoundingClientRect();
    if (scroller === null || band === undefined) return false;
    for (const element of Array.from(scroller.querySelectorAll("*"))) {
      if (!(element.textContent ?? "").includes(want)) continue;
      // Innermost carrier only: a parent reports its child's text.
      if (Array.from(element.children).some((child) => (child.textContent ?? "").includes(want))) continue;
      const box = element.getBoundingClientRect();
      if (box.height <= 0) continue;
      // Intersecting the transcript band, not merely the page.
      if (box.bottom > band.top + 1 && box.top < band.bottom - 1) return true;
    }
    return false;
  }, marker), {
    message: `row ${marker} must be mounted AND inside the transcript viewport, without any scrolling`,
    timeout,
    intervals: [16, 32, 64, 128, 256],
  }).toBe(true);
}

/**
 * Walk the transcript until `marker` is mounted and readable, then centre it.
 *
 * This RELOCATES the reader. Use it only where the scenario explicitly wants a
 * reveal/reachability claim; use `assertRowInView` where the claim is about position.
 */
export async function revealRow(page: Page, marker: string, timeout = 180_000): Promise<void> {
  // A windowed transcript only holds the rows near the viewport, so "is this row in
  // the document" is no longer the same question as "can the reader reach this row".
  // This helper answers the second one: it looks for the row where it is, and if it
  // is not mounted it walks the transcript until the window brings it in — which is
  // also the assertion the brief actually cares about (nothing becomes unreachable).
  //
  // The walk is a real scroll through the whole document, so a row that is genuinely
  // dropped fails here instead of passing on an attachment that only ever held when
  // every row was mounted.
  const deadline = Date.now() + timeout;
  // "Reachable" now means *readable*, not merely present: text inside a collapsed
  // activity group is genuinely not in the document, so a row that is mounted but
  // folded away must be opened before it can be said to have been found. That is the
  // documented information contract of the fold (every operation is one tap away), and
  // the harness pays that tap rather than pretending the text was on screen.
  // Any element, not only `.message-card`: a tool result renders inside an activity
  // group's body, which is deliberately not a message card (an ungrouped request and a
  // grouped execution are different objects), and a reachability probe that can only
  // see cards would report a perfectly reachable tool row as lost.
  const find = (): Promise<boolean> => page.evaluate((want) => {
    const root = document.querySelector(".messages-scroll");
    if (root === null) return false;
    const deepest: Element[] = [];
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (!(element.textContent ?? "").includes(want)) continue;
      // Only the innermost carrier: if a child already carries the text, the parent
      // is reporting its child's content, and checking the parent would pass on a
      // zero-height wrapper.
      const inner = Array.from(element.children).some((child) => (child.textContent ?? "").includes(want));
      if (!inner) deepest.push(element);
    }
    return deepest.some((element) => element.getBoundingClientRect().height > 0);
  }, marker);
  const openFoldedGroups = (): Promise<number> => page.evaluate(() => {
    // Only groups inside the transcript, and only the ones the window mounted.
    const heads = Array.from(document.querySelectorAll(".messages-scroll .activity-group-head"))
      .filter((head) => head.getAttribute("aria-expanded") !== "true");
    for (const head of heads) (head as HTMLElement).click();
    return heads.length;
  });
  /**
   * Open every group in the transcript, walking as needed.
   *
   * A row that lives inside a collapsed group is only readable once that group is
   * open, and the window only mounts the groups near the viewport — so on a long
   * transcript, "open what is mounted" repeatedly, moving forward each time, is the
   * only way to prove the whole document is still reachable. This is the harness
   * paying the documented one-tap cost of the fold, not the app hiding anything.
   */
  const openEveryGroup = async (): Promise<number> => {
    let total = 0;
    for (let pass = 0; pass < 40; pass += 1) {
      const openedNow = await openFoldedGroups();
      total += openedNow;
      if (openedNow > 0) {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
      } else break;
    }
    return total;
  };

  /**
   * Wait for the transcript to MOUNT before looking for anything in it.
   *
   * `find()` answers "is this row rendered right now", and a transcript that has not
   * mounted yet answers `false` instantly — which sent this helper straight into a
   * 40-pass group-opening loop over an empty document, and then into a walk over a
   * zero-height scroller. Measured as an intermittent "row was not reachable anywhere in
   * the transcript" for a row that was mounted the whole time, on the same heavy
   * 4,075-entry fixture that passed on the next run.
   */
  await expect.poll(() => page.evaluate(() => document.querySelectorAll(".transcript-entry").length), {
    message: "the transcript must mount before a row can be looked for",
    timeout: Math.min(timeout, 120_000),
    intervals: [16, 32, 64, 128, 256],
  }).toBeGreaterThan(0);
  /**
   * Let the LOAD settle before hunting, not just the first paint.
   *
   * A chunked snapshot arrives over ~2s and the document grows the whole time (measured
   * on the heavy 4,075-entry fixture: 191,807px -> 1,466,130px across ten 250ms samples,
   * with the newest row only painted at the end). Starting a walk at 0.5s therefore
   * scrolls through a document that is still being rebuilt and re-pinned to the tail,
   * and intermittently reports a row that is about to be mounted as unreachable.
   *
   * Settling is defined by the scroller's own height, not by a sleep: the document has
   * stopped changing when the same `scrollHeight` is observed on three consecutive
   * frames. A load that never settles still falls through after the cap and the walk
   * below decides, so this cannot mask a genuinely unreachable row.
   */
  await page.evaluate(async () => {
    const scroller = document.querySelector(".messages-scroll");
    if (scroller === null) return;
    let stable = 0;
    let previous = -1;
    for (let frame = 0; frame < 600 && stable < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
      const height = scroller.scrollHeight;
      if (height === previous) stable += 1;
      else { stable = 0; previous = height; }
    }
  }).catch(() => undefined);
  if (await find()) return;
  await openEveryGroup();
  if (await find()) return;

  // One in-page walk. A long transcript is thousands of viewports tall, and doing that
  // as thousands of round-trips cannot finish inside a test budget — measured: a
  // 1.41M-pixel document is ~2,070 steps, each paying a protocol hop. Inside the page
  // it is a frame-paced loop with no protocol cost, and it steps by two viewports
  // because the window mounts 800px of overscan on each side of a 682px viewport.
  const walked = await page.evaluate(async ({ want }) => {
    const scroller = document.querySelector(".messages-scroll");
    if (scroller === null) return false;
    // Detach from the tail FIRST. If the view is still following the newest message, any
    // document growth re-pins it to the bottom, so a walk that starts at 0 gets dragged
    // back — measured as "row was not reachable anywhere in the transcript" on a heavy
    // 4,075-entry transcript whose tail row was mounted the whole time.
    scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(120, scroller.clientHeight));
    await new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
    const innermost = (want: string): HTMLElement | null => {
      for (const element of Array.from(scroller.querySelectorAll("*"))) {
        if (!(element.textContent ?? "").includes(want)) continue;
        // Innermost carrier only: a parent reports its child's text, and a zero-height
        // wrapper would otherwise pass for a row.
        if (Array.from(element.children).some((child) => (child.textContent ?? "").includes(want))) continue;
        if (element.getBoundingClientRect().height > 0) return element as HTMLElement;
      }
      return null;
    };
    const frame = (): Promise<void> => new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
    const stepPx = Math.max(200, scroller.clientHeight) * 2;
    for (let top = 0; top <= scroller.scrollHeight; top += stepPx) {
      scroller.scrollTop = top;
      await frame();
      await frame();
      const hit = innermost(want);
      if (hit !== null) {

        // Leave the reader where the row is, not at the end of the walk.
        hit.scrollIntoView({ block: "center" });
        return true;
      }
    }
    return false;
  }, { want: marker }).catch(() => false);
  if (walked) return;

  await expect(
    page.locator(".messages-scroll .message-card").filter({ hasText: marker }).first(),
    `row ${marker} was not reachable anywhere in the transcript`,
  ).toBeAttached({ timeout: 5_000 });
}

/**
 * Historical name for `revealRow`, kept so existing callers keep their (weaker, but
 * still meaningful) reachability guarantee. New scenarios that care about POSITION
 * must use `assertRowInView` instead — see W12.
 */
export const waitForRow = revealRow;

/** Arm an in-page wait for the frame that first shows `marker`; resolves elapsed ms or -1. */
export function startRowWait(page: Page, marker: string, timeoutMs = 120_000): Promise<number> {
  return page.evaluate(
    ({ want, timeout }) => new Promise<number>((resolve) => {
      const start = performance.now();
      const check = (): void => {
        for (const row of Array.from(document.querySelectorAll(".messages-scroll .message-card"))) {
          if (!(row.textContent ?? "").includes(want)) continue;
          if (row.getBoundingClientRect().height > 0) {
            requestAnimationFrame(() => resolve(performance.now() - start));
            return;
          }
        }
        if (performance.now() - start > timeout) {
          resolve(-1);
          return;
        }
        requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    }),
    { want: marker, timeout: timeoutMs },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Long tasks and the scroll timeline
// ─────────────────────────────────────────────────────────────────────────────

export interface LongTask { duration: number; start: number }

export async function installLongTaskProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as unknown as { __scrollLongTasks?: LongTask[]; __loaf?: Array<{ duration: number; blocking: number }> };
    const tasks: LongTask[] = [];
    target.__scrollLongTasks = tasks;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) tasks.push({ duration: entry.duration, start: entry.startTime });
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Chromium-only; the blank-frame numbers carry the claim elsewhere.
    }
    const loaf: Array<{ duration: number; blocking: number }> = [];
    target.__loaf = loaf;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const value = entry as PerformanceEntry & { duration: number; blockingDuration?: number };
          loaf.push({ duration: value.duration, blocking: value.blockingDuration ?? 0 });
        }
      }).observe({ type: "long-animation-frame", buffered: true });
    } catch {
      // Not every Chromium build exposes LoAF; the longtask list is the fallback.
    }
  });
}

export const markLongTasks = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __scrollLongTasks: LongTask[] }).__scrollLongTasks.length);

export const longTasksSince = (page: Page, mark: number): Promise<LongTask[]> =>
  page.evaluate((from) => (window as unknown as { __scrollLongTasks: LongTask[] }).__scrollLongTasks.slice(from), mark);

export const loafSince = (page: Page, mark: number): Promise<Array<{ duration: number; blocking: number }>> =>
  page.evaluate((from) => (window as unknown as { __loaf: Array<{ duration: number; blocking: number }> }).__loaf.slice(from), mark);

/**
 * A rAF record of `scrollTop` and painted frame timestamps.
 *
 * The main-thread half of the claim: "the offset moved and no frame was produced
 * for N ms". It cannot see a compositor-only blank (that is the screencast's job),
 * but it can prove a stalled main thread, which is a distinct failure.
 */
export interface FrameGap {
  /** Milliseconds between consecutive rAF callbacks, worst first. */
  gaps: number[];
  scrollTopSeries: Array<{ t: number; top: number }>;
}

export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { __frames?: FrameGap; __frameLoop?: number };
    const record: FrameGap = { gaps: [], scrollTopSeries: [] };
    target.__frames = record;
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      record.gaps.push(now - last);
      last = now;
      const scroller = document.querySelector(".messages-scroll");
      if (scroller !== null) record.scrollTopSeries.push({ t: now, top: scroller.scrollTop });
      target.__frameLoop = requestAnimationFrame(tick);
    };
    target.__frameLoop = requestAnimationFrame(tick);
  });
}

export const readFrameProbe = (page: Page): Promise<FrameGap> =>
  page.evaluate(() => {
    const target = window as unknown as { __frames?: FrameGap; __frameLoop?: number };
    if (target.__frameLoop !== undefined) cancelAnimationFrame(target.__frameLoop);
    return target.__frames ?? { gaps: [], scrollTopSeries: [] };
  });

// ─────────────────────────────────────────────────────────────────────────────
// Pixel sampling: trace screenshots on Chromium, page screenshots on WebKit
// ─────────────────────────────────────────────────────────────────────────────

/** Luminance above which a pixel counts as ink against the near-black app background. */
const INK_LUMINANCE = 28;
/** Rows of the transcript band that must be ink-free for the frame to be blank. */
const BLANK_ROW_FRACTION = 0.98;

export interface PixelSample {
  /** Page-clock ms when the frame was presented (trace: the frame's own timestamp). */
  t: number;
  blank: boolean;
  /** Rows in the transcript band that held no ink, over the band's total rows. */
  blankRowRatio: number;
  /** Scroll offset the page reported nearest this sample, for correlation. */
  scrollTop: number | null;
  /**
   * Entries the window held when this frame was captured.
   *
   * A blank frame has two very different causes: an empty window (nothing mounted —
   * a rendering fault) or a window whose rows all sit outside the band (a measurement
   * fault). Without this number the pixels cannot tell them apart.
   */
  mounted?: number;
  /** The scroll range at capture time, so a collapsed document is visible. */
  scrollHeight?: number | null;
  /** Mounted entries whose box actually intersects the transcript band. */
  visibleEntries?: number;
  /** Lowest and highest entry rank mounted at capture time. */
  posRange?: [number | null, number | null] | null;
}

export interface PixelRecorder {
  samples: PixelSample[];
  /** How the samples were captured, so a reader never compares two instruments. */
  kind: "trace" | "screenshot";
  stop(): Promise<void>;
}

async function transcriptBand(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    const band = scroller?.getBoundingClientRect();
    if (band === undefined || band === null) return { x: 0, y: 0, width: 0, height: 0 };
    // Inset by a pixel so the scroll container's own edges cannot supply ink, and
    // trimmed at the bottom so the sticky composer's border is never counted.
    return { x: band.left, y: band.top + 1, width: band.width, height: Math.max(0, band.height - 3) };
  });
}

/** Does this decoded frame show ink in the transcript band? */
function frameHasInk(
  frame: { width: number; height: number; pixels: Uint8Array },
  band: { x: number; y: number; width: number; height: number },
  scale: number,
): { blank: boolean; blankRowRatio: number } {
  const x0 = Math.max(0, Math.round(band.x * scale));
  const x1 = Math.min(frame.width, Math.round((band.x + band.width) * scale));
  const y0 = Math.max(0, Math.round(band.y * scale));
  const y1 = Math.min(frame.height, Math.round((band.y + band.height) * scale));
  if (x1 <= x0 || y1 <= y0) return { blank: false, blankRowRatio: 0 };
  let blankRows = 0;
  const rows = y1 - y0;
  for (let y = y0; y < y1; y += 1) {
    let ink = false;
    for (let x = x0; x < x1; x += 1) {
      const at = (y * frame.width + x) * 4;
      const luminance = 0.2126 * (frame.pixels[at] ?? 0) + 0.7152 * (frame.pixels[at + 1] ?? 0) + 0.0722 * (frame.pixels[at + 2] ?? 0);
      if (luminance > INK_LUMINANCE) {
        ink = true;
        break;
      }
    }
    if (!ink) blankRows += 1;
  }
  const blankRowRatio = blankRows / rows;
  return { blank: blankRowRatio >= BLANK_ROW_FRACTION, blankRowRatio };
}

function nearestScrollTop(series: Array<{ t: number; top: number }>, ts: number): number | null {
  if (series.length === 0) return null;
  let best = series[0]!;
  for (const point of series) if (Math.abs(point.t - ts) < Math.abs(best.t - ts)) best = point;
  return best.top;
}

/**
 * WebKit fallback: `screenshot` in a parallel loop for the duration of the gesture.
 *
 * WebKit has no CDP, so there is no trace and no screencast, and this is the only
 * capture path available. It is a genuine composited capture; it is simply slower per
 * sample, which is why the sample counts differ between browsers and are reported
 * rather than compared.
 */
async function startScreenshotSampler(page: Page, intervalMs = 60): Promise<PixelRecorder> {
  const samples: PixelSample[] = [];
  let stopped = false;
  const run = (async () => {
    while (!stopped) {
      const band = await transcriptBand(page);
      if (band.width <= 0 || band.height <= 0) break;
      // Sampled BEFORE the screenshot, so a blank frame is correlated with the offset
      // that produced it rather than with a later one.
      const at = await page.evaluate(() => {
        const scroller = document.querySelector(".messages-scroll");
        const band = scroller?.getBoundingClientRect();
        const entries = Array.from(scroller?.querySelectorAll(".transcript-entry") ?? []);
        const visible = entries.filter((entry) => {
          const box = (entry.firstElementChild ?? entry).getBoundingClientRect();
          return box.bottom > (band?.top ?? 0) && box.top < (band?.bottom ?? 0);
        }).length;
        // The role and the position live on the entry's REAL BOX (its first element child),
  // not on the `display: contents` wrapper: measured in Chromium's accessibility tree,
  // ARIA on the unboxed wrapper never reached the tree (see `PERF-A11Y-01`).
  const boxOf = (entry: Element): Element => entry.firstElementChild ?? entry;
  const positions = entries.map((entry) => Number(boxOf(entry).getAttribute("aria-posinset")));
        return {
          t: performance.now(),
          top: scroller?.scrollTop ?? null,
          visible,
          bandTop: band?.top ?? null,
          minPos: positions.length === 0 ? null : Math.min(...positions),
          maxPos: positions.length === 0 ? null : Math.max(...positions),
        };
      });
      let buffer: Buffer;
      try {
        buffer = await page.screenshot({ animations: "allow" });
      } catch {
        break;
      }
      let decoded;
      try {
        decoded = decodePng(buffer);
      } catch {
        continue;
      }
      // What the DOM held AT THE MOMENT the frame was captured. A blank frame is only
      // diagnosable with this: an empty window and a window whose rows are all outside
      // the band look identical in pixels, and they are different bugs.
      const viewport = await page.evaluate(() => {
        const scroller = document.querySelector(".messages-scroll");
        return {
          w: window.innerWidth,
          mounted: document.querySelectorAll(".transcript-entry").length,
          scrollTop: scroller?.scrollTop ?? null,
          scrollHeight: scroller?.scrollHeight ?? null,
        };
      });
      const verdict = frameHasInk(decoded, band, decoded.width / viewport.w, );
      samples.push({ t: at.t, ...verdict, scrollTop: at.top, mounted: viewport.mounted, scrollHeight: viewport.scrollHeight, visibleEntries: at.visible, posRange: at.minPos === null ? null : [at.minPos, at.maxPos] });
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    samples,
    kind: "screenshot",
    async stop() {
      stopped = true;
      await run;
      samples.sort((a, b) => a.t - b.t);
    },
  };
}

export const isChromium = (page: Page): boolean => page.context().browser()?.browserType().name() === "chromium";

/** The band rect, so the spec can assert the region it scanned was real. */
export const readBand = transcriptBand;

function decodeFrame(buffer: Buffer): { width: number; height: number; pixels: Uint8Array } {
  return decodePng(buffer);
}

/**
 * Start pixel sampling for the duration of a gesture.
 *
 * On Chromium this is the **trace**, not `Page.startScreencast`. Measured on this
 * machine, the screencast delivers **1 frame per 6 s** during a flick train: it is
 * ack-gated and its capture path forces a re-raster, which is exactly the repair that
 * would hide an unpainted region. The trace's own `Screenshot` events are taken by the
 * GPU process as frames are presented, so they carry what the user saw.
 *
 * The trace is started here and stopped in `stop()`, which then decodes and scores
 * every frame after the gesture — so decoding never competes with the scroll for the
 * main thread.
 */
/**
 * Start pixel sampling for the duration of a gesture.
 *
 * **One instrument on both engines, deliberately.** Chromium has two faster-looking
 * options and both were measured and rejected on this machine:
 *
 *  - `Page.startScreencast` is ack-gated and re-rasters before it copies: measured at
 *    **1 frame per 6 s** during a flick train, whatever the format, size or DPR. A
 *    capture path that repaints what it captures is structurally unable to see a
 *    region the compositor never painted — which is the bug.
 *  - Trace `devtools.screenshot` frames arrive from the presented frame and are the
 *    right *idea*, but on this Chrome build the category emitted **1 screenshot for a
 *    30-step flick**, so they cannot support a per-frame verdict either.
 *
 * `page.screenshot` is slower per sample, but it is real, it works on both engines, and
 * it is the same measurement on both — so a Chromium and a WebKit number mean the same
 * thing. Sample counts are reported, never compared.
 */
export async function startPixelRecorder(page: Page, band: { x: number; y: number; width: number; height: number }): Promise<PixelRecorder> {
  void band;
  return startScreenshotSampler(page);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blank-frame statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface PixelBlankStats {
  frames: number;
  blankFrames: number;
  /** Total ms covered by samples. */
  spanMs: number;
  /** ms in the longest uninterrupted run of blank frames. */
  longestBlankMs: number;
  /** ms in all blank runs, p50/p95/max of the individual runs. */
  blankRunP50Ms: number;
  blankRunP95Ms: number;
  blankRunMaxMs: number;
  blankMs: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

/**
 * Blank runs, in milliseconds.
 *
 * A run is measured from the timestamp of its first blank frame to the timestamp of
 * the first frame after it that shows ink again — the duration the user was looking
 * at nothing. When a run is still blank at the end of the recording it is measured
 * to the last sample, which under-reports rather than inventing an end.
 */
export function blankStats(samples: PixelSample[]): PixelBlankStats {
  const runs: number[] = [];
  let runStart: number | null = null;
  let blankFrames = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (sample.blank) {
      blankFrames += 1;
      if (runStart === null) runStart = sample.t;
      continue;
    }
    if (runStart !== null) {
      runs.push(sample.t - runStart);
      runStart = null;
    }
  }
  if (runStart !== null) runs.push((samples[samples.length - 1]?.t ?? runStart) - runStart);
  const sorted = [...runs].sort((a, b) => a - b);
  const first = samples[0]?.t ?? 0;
  const last = samples[samples.length - 1]?.t ?? 0;
  return {
    frames: samples.length,
    blankFrames,
    spanMs: round2(last - first),
    longestBlankMs: round2(sorted[sorted.length - 1] ?? 0),
    blankRunP50Ms: round2(percentile(sorted, 0.5)),
    blankRunP95Ms: round2(percentile(sorted, 0.95)),
    blankRunMaxMs: round2(sorted[sorted.length - 1] ?? 0),
    blankMs: round2(runs.reduce((sum, value) => sum + value, 0)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gestures
// ─────────────────────────────────────────────────────────────────────────────

/** The scroll container's state, as one value a spec can assert on. */
export interface ScrollState {
  top: number;
  height: number;
  client: number;
  /** Rows the browser is holding. A windowed transcript keeps this bounded. */
  rows: number;
  domElements: number;
  /**
   * The transcript's own total, as it reports it to assistive technology.
   * `null` for a list that mounts everything (no `aria-setsize` is emitted there).
   * This is the number that must equal the conversation's size: the mounted count is
   * a rendering decision, this one is the document's claim about the conversation.
   */
  entries: number | null;
}

export const scrollState = (page: Page): Promise<ScrollState> =>
  page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    return {
      top: scroller?.scrollTop ?? -1,
      height: scroller?.scrollHeight ?? -1,
      client: scroller?.clientHeight ?? -1,
      rows: document.querySelectorAll(".messages-scroll .message-card").length,
      domElements: document.querySelectorAll("*").length,
      entries: Number(document.querySelector(".messages-scroll [aria-setsize]")?.getAttribute("aria-setsize") ?? Number.NaN) || null,
    };
  });

/**
 * Where a marked row sits right now, WITHOUT moving anything.
 *
 * The windowed list may or may not have the row mounted. This reports both facts —
 * its viewport position when it is mounted, and `null` when it is not — so a test can
 * assert anchoring without invoking the walking reachability helper, which by design
 * relocates the reader. Measurement that moves what it measures is not measurement.
 */
export async function rowPosition(page: Page, marker: string): Promise<{ top: number; scrollTop: number } | null> {
  return page.evaluate((want) => {
    const scroller = document.querySelector(".messages-scroll");
    const root = scroller ?? document;
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (!(element.textContent ?? "").includes(want)) continue;
      if (Array.from(element.children).some((child) => (child.textContent ?? "").includes(want))) continue;
      if (element.getBoundingClientRect().height <= 0) continue;
      return { top: element.getBoundingClientRect().top, scrollTop: scroller?.scrollTop ?? -1 };
    }
    return null;
  }, marker);
}

/** Jump to the newest row, the way the user starts: at the bottom of the conversation. */
export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    if (scroller !== null) scroller.scrollTop = scroller.scrollHeight;
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
}

/** Explicit offset assignment in `steps`, with one painted frame between each. */
export async function programmaticScroll(page: Page, options: { from: number; to: number; steps: number }): Promise<void> {
  await page.evaluate(async ({ from, to, steps }) => {
    const scroller = document.querySelector(".messages-scroll");
    if (scroller === null) return;
    const limit = scroller.scrollHeight - scroller.clientHeight;
    for (let step = 0; step <= steps; step += 1) {
      const fraction = step / steps;
      scroller.scrollTop = Math.min(limit, Math.max(0, from + (to - from) * fraction));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
  }, options);
}

/** Wheel input through the browser's own event path — what a trackpad or a mouse sends. */
export async function wheelScroll(page: Page, options: { deltaY: number; times: number; gapMs?: number }): Promise<void> {
  for (let index = 0; index < options.times; index += 1) {
    await page.mouse.wheel(0, options.deltaY);
    if (options.gapMs !== undefined && options.gapMs > 0) await page.waitForTimeout(options.gapMs);
  }
}

export interface FlickOptions {
  /** Total travel per flick, in CSS px. */
  distance: number;
  /** How many movement events the flick is spread over; fewer means higher velocity. */
  steps?: number;
  /** How many flicks in the train. */
  repeats?: number;
  /**
   * Which way the *viewport* travels: `1` toward older content (the finger drags
   * down the glass, `scrollTop` decreases — the owner's reported gesture from the
   * bottom of a conversation), `-1` toward newer content.
   */
  direction?: -1 | 1;
  /** Pause between flicks, ms. */
  gapMs?: number;
}

/**
 * A touch flick through CDP `Input.dispatchTouchEvent`, with momentum.
 *
 * A finger drags *down* the screen to scroll *up* through the history, so
 * `direction: 1` moves the viewport toward older content. The movement is
 * accelerated within the flick and then releases with a decaying tail, which is
 * what a phone's fling actually produces and what a compositor-only blank shows
 * up under.
 */
export async function touchFlick(page: Page, options: FlickOptions): Promise<void> {
  const { distance, steps = 6, repeats = 1, direction = 1, gapMs = 40 } = options;
  const sign = direction === 1 ? 1 : -1;
  if (!isChromium(page)) {
    // WebKit has no CDP, `mouse.wheel` is unsupported in mobile WebKit, and Playwright's
    // touchscreen has no drag gesture, so the only gesture available is a direct offset
    // assignment with the same travel and the same per-step frame budget. A WebKit
    // number is therefore a *layout-path* measurement where Chromium's is a
    // compositor-path one, and the report's `sampler`/`gesture` fields keep them apart.
    await page.evaluate(async ({ travel, stepCount, sign: direction, pause }) => {
      const scroller = document.querySelector(".messages-scroll");
      if (scroller === null) return;
      const limit = scroller.scrollHeight - scroller.clientHeight;
      for (let repeat = 0; repeat < 6; repeat += 1) {
        for (let step = 0; step < stepCount; step += 1) {
          scroller.scrollTop = Math.min(limit, Math.max(0, scroller.scrollTop - direction * (travel / stepCount)));
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        }
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }, { travel: distance, stepCount: steps, sign, pause: gapMs }).catch(() => undefined);
    return;
  }
  const client = await page.context().newCDPSession(page);
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const startX = Math.round(size.w / 2);
  const startY = Math.round(size.h * 0.65);
  try {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      let y = startY;
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: startX, y, id: 1 }] });
      for (let step = 1; step <= steps; step += 1) {
        // Accelerating drag: the per-step travel grows, which is what a thumb
        // producing a fling looks like to the compositor. The finger follows the
        // direction the *viewport* should travel, so `direction: 1` drags downward.
        y += sign * (distance / steps) * (step / steps);
        await client.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: startX, y: Math.round(y), id: 1 }],
        });
      }
      // Lift with a decaying momentum tail: the fling the compositor continues on
      // its own, which is where a paint-only-during-scroll path falls over.
      for (let tail = 0; tail < 4; tail += 1) {
        y += sign * (distance / steps) * (0.6 ** tail);
        await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: startX, y: Math.round(y), id: 1 }] });
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      if (gapMs > 0) await page.waitForTimeout(gapMs);
    }
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/** How far the transcript moved between two states. */
export async function scrollDelta(page: Page, before: number): Promise<number> {
  const after = await page.evaluate(() => document.querySelector(".messages-scroll")?.scrollTop ?? 0);
  return round2(Math.abs(after - before));
}

export const nowInPage = (page: Page): Promise<number> => page.evaluate(() => performance.now());

/** p50/p95/max of a sample set. Named so consumers do not publish `ReturnType`. */
export interface Percentiles {
  p50: number;
  p95: number;
  max: number;
}

export function percentiles(samples: number[]): Percentiles {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  return { p50: round2(at(0.5)), p95: round2(at(0.95)), max: round2(sorted[sorted.length - 1] ?? 0) };
}


export interface EnvironmentDescription {
  browser: string;
  browserVersion: string;
  channel: string;
  cpuThrottleRate: number | null;
  viewport: { width: number; height: number } | null;
  fixtureName: string;
  entryCount: number;
  snapshotSizeBytes: number;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  warmColdState: "warm" | "cold";
  repetitionCount: number;
  userAgent: string;
}

export interface DescribeEnvironmentOptions {
  cpuThrottleRate?: number | null;
  fixtureName?: string;
  entryCount?: number;
  snapshotSizeBytes?: number;
  warmColdState?: "warm" | "cold";
  repetitionCount?: number;
}

export async function describeEnvironment(
  page: Page,
  options?: DescribeEnvironmentOptions,
): Promise<EnvironmentDescription> {
  const browser = page.context().browser();
  const browserType = browser?.browserType().name() ?? (isChromium(page) ? "chromium" : "webkit");
  const browserVersion = browser?.version() ?? "unknown";
  const channel = process.env.CAW_E2E_CHANNEL ?? (isChromium(page) ? "chrome" : "bundled");
  const viewport = page.viewportSize();

  let hardwareConcurrency: number | null = null;
  let deviceMemory: number | null = null;
  let userAgent = "unknown";

  try {
    const nav = await page.evaluate(() => {
      interface NavWithMemory { deviceMemory?: number }
      const navMem = navigator as NavWithMemory;
      return {
        concurrency: typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : null,
        memory: typeof navMem.deviceMemory === "number" ? navMem.deviceMemory : null,
        ua: navigator.userAgent ?? "unknown",
      };
    });
    hardwareConcurrency = nav.concurrency;
    deviceMemory = nav.memory;
    userAgent = nav.ua;
  } catch {
    // page context unreadable / closing
  }

  return {
    browser: browserType,
    browserVersion,
    channel,
    cpuThrottleRate: options?.cpuThrottleRate !== undefined ? options.cpuThrottleRate : (isChromium(page) ? 1 : null),
    viewport,
    fixtureName: options?.fixtureName ?? "default",
    entryCount: options?.entryCount ?? 0,
    snapshotSizeBytes: options?.snapshotSizeBytes ?? 0,
    hardwareConcurrency,
    deviceMemory,
    warmColdState: options?.warmColdState ?? "warm",
    repetitionCount: options?.repetitionCount ?? 1,
    userAgent,
  };
}

export interface BudgetOptions {
  id: string;
  measuredMs: number;
  budgetMs: number;
  blocking: boolean;
  samples?: number[];
  failures?: number;
  env: EnvironmentDescription;
  sampler?: "screencast" | "screenshot" | "trace" | "compositor" | "layout";
  extra?: Record<string, unknown>;
}

export interface BudgetResult {
  id: string;
  measuredMs: number;
  budgetMs: number;
  verdict: "MET" | "OVER_BUDGET";
  samples: number[];
  p50: number;
  p95: number;
  max: number;
  failures: number;
  env: EnvironmentDescription;
  sampler?: "screencast" | "screenshot" | "trace" | "compositor" | "layout";
  [key: string]: unknown;
}

export function budget(options: BudgetOptions): BudgetResult {
  const { id, measuredMs, budgetMs, blocking, env, sampler, extra } = options;
  const samples = options.samples && options.samples.length > 0 ? options.samples : [measuredMs];
  const p = percentiles(samples);
  const verdict: "MET" | "OVER_BUDGET" = measuredMs <= budgetMs ? "MET" : "OVER_BUDGET";
  const failures = options.failures !== undefined ? options.failures : (measuredMs > budgetMs ? 1 : 0);

  const result: BudgetResult = {
    id,
    measuredMs: round2(measuredMs),
    budgetMs,
    verdict,
    samples: samples.map(round2),
    p50: p.p50,
    p95: p.p95,
    max: p.max,
    failures,
    env,
    ...(sampler ? { sampler } : {}),
    ...(extra ?? {}),
  };

  console.log(`PERF_JSON ${JSON.stringify(result)}`);

  if (verdict === "OVER_BUDGET") {
    if (blocking) {
      expect(measuredMs, `${id} ${measuredMs}ms exceeds blocking budget of ${budgetMs}ms`).toBeLessThanOrEqual(budgetMs);
    } else {
      try {
        test.info().annotations.push({
          type: "performance",
          description: `${id} ${measuredMs}ms exceeds advisory budget of ${budgetMs}ms (verdict: OVER_BUDGET)`,
        });
      } catch {
        /* test.info() might not be active if called outside test runner */
      }
    }
  }

  return result;
}
export { round2, sentinel };
