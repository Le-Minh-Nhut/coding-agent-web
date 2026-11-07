/**
 * The pre-implementation decision experiment: is the whole history's DOM/layout/
 * raster actually what stalls the scroll?
 *
 * The brief's instruction is explicit — implement bounded ("windowed") transcript
 * rendering *if and only if* profiling shows the whole history's DOM/layout/raster
 * is material. This is that measurement, and it is a controlled A/B on the same
 * page, the same fixture and the same gesture, with one variable: whether the
 * historical rows are still laid out and rastered by the browser.
 *
 * The two arms
 *
 *  - **mounted** — the shipping build, every row in flow.
 *  - **cheap-dom** — the same rows in the same order with
 *    `content-visibility: auto` + `contain-intrinsic-size` applied. That is the
 *    native mechanism for "keep the element, skip its layout and paint until it is
 *    near the viewport". It is *not* a candidate fix on its own (the previous round
 *    measured it and rejected the whole-history case), it is the probe that answers
 *    "how much of the stall belongs to the history at all".
 *
 * If the gaps collapse under the probe, the history's own layout/raster is the
 * cost, and bounding *what is rendered* is the fix. If they do not move, the cost
 * is elsewhere and windowing would be an unearned rewrite.
 *
 * Frame gaps are measured in-page by a rAF loop, never by a Node round trip, and the
 * gesture is pure CDP touch input so nothing on the harness side walks the DOM during
 * the measurement.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { requireAppServer } from "./fixture.js";
import { buildTranscriptEntries, sentinel } from "./perf-fixtures.js";
import { HEAVY_TRANSCRIPT, openWithHost, scrollToBottom, sendSnapshot, setCpuThrottle, waitForRow } from "./perf-scroll-harness.js";

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

interface GapStats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over100: number;
  over250: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function gapStats(gaps: number[]): GapStats {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (fraction: number) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0) * 100) / 100;
  return {
    frames: gaps.length,
    p50: at(0.5),
    p95: at(0.95),
    max: round2(sorted[sorted.length - 1] ?? 0),
    over100: gaps.filter((value) => value > 100).length,
    over250: gaps.filter((value) => value > 250).length,
  };
}

/** Start the in-page rAF gap probe. Returns nothing; `readGaps` collects. */
const startGaps = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const w = window as unknown as { __gapStart?: number; __gaps?: number[] };
    w.__gaps = [];
    w.__gapStart = performance.now();
    let last = performance.now();
    const tick = (): void => {
      const now = performance.now();
      w.__gaps?.push(now - last);
      last = now;
      if ((w.__gapStart ?? 0) > 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const readGaps = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const w = window as unknown as { __gaps?: number[]; __gapStart?: number };
    w.__gapStart = 0;
    return (w.__gaps ?? []).slice(1);
  });

/**
 * An upward flick train through raw CDP touch input.
 *
 * `direction: 1` is the owner's gesture: the finger drags *down* the glass and the
 * viewport travels toward older content. Momentum is included as a decaying tail,
 * because that is what a phone does after the finger lifts and it is exactly when a
 * compositor with nothing rastered shows background.
 */
async function flickUp(page: Page, options: { flicks?: number; distance?: number; gapMs?: number } = {}): Promise<void> {
  const { flicks = 8, distance = 420, gapMs = 60 } = options;
  const client: CDPSession = await page.context().newCDPSession(page);
  const size = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const x = Math.round(size.w / 2);
  for (let flick = 0; flick < flicks; flick += 1) {
    let y = Math.round(size.h * 0.7);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    for (let step = 1; step <= 6; step += 1) {
      y += (distance / 6) * (step / 6);
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(y), id: 1 }] });
    }
    for (let tail = 0; tail < 4; tail += 1) {
      y += (distance / 6) * 0.6 ** tail;
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(y), id: 1 }] });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    if (gapMs > 0) await page.waitForTimeout(gapMs);
  }
  await client.detach().catch(() => undefined);
}

/** The probe style: keep every element, let the engine skip off-screen layout/paint. */
const PROBE_CSS = `
.messages-scroll .message-card, .messages-scroll .activity-group {
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}`;

async function applyProbe(page: Page): Promise<void> {
  // A constructed stylesheet, not a `<style>` tag: the app's own Content-Security-Policy
  // is `style-src 'self'`, which blocks an injected inline `<style>` element outright
  // (Playwright's `addStyleTag` fails on it), while `adoptedStyleSheets` is exempt
  // because it is not inline text. Verified on this build before use.
  await page.evaluate((css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }, PROBE_CSS);
  // One frame per changed box: the estimate and the real box are reconciled by the
  // engine, and starting the measurement before that settles would blame the probe.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))));
}

interface Arm { label: string; gaps: GapStats; domElements: number; scrollHeight: number; scrollTopAfter: number; commits: number }

async function measureArm(page: Page, label: string, entries: number): Promise<Arm> {
  await startGaps(page);
  const before = await page.evaluate(() => {
    const scroller = document.querySelector(".messages-scroll");
    return { dom: document.querySelectorAll("*").length, height: scroller?.scrollHeight ?? -1, commits: (window as unknown as { __commits?: number[] }).__commits?.length ?? -1 };
  });
  await flickUp(page, { flicks: 8 });
  await page.waitForTimeout(400);
  const gaps = await readGaps(page);
  return {
    label,
    gaps: gapStats(gaps),
    domElements: before.dom,
    scrollHeight: before.height,
    scrollTopAfter: await page.evaluate(() => document.querySelector(".messages-scroll")?.scrollTop ?? -1),
    commits: (await page.evaluate((base) => ((window as unknown as { __commits?: number[] }).__commits?.length ?? 0) - base, before.commits)) as number,
  };
}

test("A/B: does the mounted history's layout and raster cost cause the scroll stall?", async ({ page }) => {
  test.setTimeout(900_000);
  const entries = 2000;
  const throttle = 4;

  // A React commit counter, installed before any app script, so "is React re-rendering
  // the whole list on every frame" is answered by measurement rather than by reading
  // the code and hoping.
  await page.addInitScript(() => {
    const w = window as unknown as { __commits?: number[] };
    w.__commits = [];
    interface Renderer { id: number }
    const hook = {
      renderers: new Map<number, Renderer>(),
      supportsFiber: true,
      onCommitFiberRoot() { w.__commits?.push(performance.now()); },
      onCommitFiberUnmount() {},
      inject(renderer: Renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    };
    Object.defineProperty(w, "__REACT_DEVTOOLS_GLOBAL_HOOK__", { value: hook, configurable: true });
  });

  const host = await openWithHost(page);
  // Load at full speed, then throttle only for the gesture. Throttling the load too
  // would spend the whole budget on the snapshot and measure nothing about scrolling.
  await sendSnapshot(host, buildTranscriptEntries({ count: entries, seed: 21, ...HEAVY_TRANSCRIPT }), 40);
  await waitForRow(page, sentinel(entries - 1));
  await scrollToBottom(page);
  await setCpuThrottle(page, throttle);

  const mounted = await measureArm(page, "mounted", entries);

  // Back to the tail for the second arm, so both gestures start from the same place.
  await scrollToBottom(page);
  await applyProbe(page);
  const probed = await measureArm(page, "cheap-dom", entries);

  console.log(`PERF_JSON ${JSON.stringify({
    id: "SCROLL-AB",
    entries,
    throttle,
    gapThresholdsMs: { over100: 100, over250: 250 },
    arms: [mounted, probed],
    reduction: {
      gapP95Percent: mounted.gaps.p95 === 0 ? null : Math.round((1 - probed.gaps.p95 / mounted.gaps.p95) * 100),
      gapMaxPercent: mounted.gaps.max === 0 ? null : Math.round((1 - probed.gaps.max / mounted.gaps.max) * 100),
      over250Count: `${mounted.gaps.over250} -> ${probed.gaps.over250}`,
    },
  })}`);

  // The experiment must be a real one: both arms scrolled, and both had rows to show.
  expect(mounted.gaps.frames, "the mounted arm must have produced frame samples").toBeGreaterThan(20);
  expect(probed.gaps.frames, "the probed arm must have produced frame samples").toBeGreaterThan(20);
  expect(mounted.scrollTopAfter, "the mounted arm must actually have moved the transcript").toBeGreaterThan(0);
  expect(probed.scrollTopAfter, "the probed arm must actually have moved the transcript").toBeGreaterThan(0);
});
