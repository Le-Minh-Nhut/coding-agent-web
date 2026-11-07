/**
 * Validation of the pixel instrument itself, before any number from it is used.
 *
 * The failure this round hunts is a black transcript region during a fast scroll.
 * `Page.startScreencast` and `Page.captureScreenshot` both have a known caveat: the
 * capture path can force a complete raster before it reads the surface, in which
 * case an un-rastered (checkerboarded) region arrives at the instrument already
 * painted and the detector never fires. Two questions follow, and this spec answers
 * both with a controlled fault rather than an argument:
 *
 *  1. **Detection sensitivity** — when the transcript band is *known* to be
 *     background-coloured, does `blankStats` report a blank run for the right
 *     duration? (Injected with a fixed overlay, so the ground truth is exact.)
 *  2. **Detector false-positive rate** — on the real app, painted and untouched,
 *     does it report zero? A detector that always says "blank" measures nothing.
 *
 * A third question — sample coverage, whether the screencast drops frames exactly
 * when the main thread is blocked — is answered by comparing the number of screencast
 * frames against the number of rAF frames over the same window.
 */
import { expect, test } from "@playwright/test";
import { requireAppServer } from "./fixture.js";
import { buildTranscriptEntries, sentinel } from "./perf-fixtures.js";
import { blankStats, openWithHost, readBand, readFrameProbe, sendSnapshot, startFrameProbe, startPixelRecorder, waitForRow, wheelScroll } from "./perf-scroll-harness.js";

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("PIXELS: the blank detector fires on a known-black band and stays silent on a painted one", async ({ page }) => {
  test.setTimeout(180_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 400, seed: 1 }), 8);
  await waitForRow(page, sentinel(399));

  const band = await readBand(page);
  expect(band.height, "the band must be real").toBeGreaterThan(50);

  // Ground truth 1: the app is painted, nothing injected. Any blank here is a
  // false positive, and a detector with false positives cannot be evidence.
  await startFrameProbe(page);
  const clean = await startPixelRecorder(page, band);
  await wheelScroll(page, { deltaY: 120, times: 10, gapMs: 20 });
  await clean.stop();
  const cleanStats = blankStats(clean.samples);

  // Ground truth 2: an opaque background-coloured overlay over exactly the band.
  // The pixels are now known to contain no ink, so a blank run is the right answer.
  await page.evaluate((rect) => {
    const overlay = document.createElement("div");
    overlay.id = "blank-detector-ground-truth";
    overlay.style.cssText = `position:fixed;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;background:#050505;z-index:2147483647`;
    document.body.append(overlay);
  }, band);
  await page.waitForTimeout(200);
  const injected = await startPixelRecorder(page, band);
  await page.waitForTimeout(700);
  const injectedStats = blankStats(injected.samples);
  await page.evaluate(() => document.querySelector("#blank-detector-ground-truth")?.remove());

  console.log(`PERF_JSON ${JSON.stringify({
    id: "PIXEL-DETECTOR",
    sampler: clean.kind,
    bandHeightPx: Math.round(band.height),
    cleanFrames: cleanStats.frames,
    cleanBlankFrames: cleanStats.blankFrames,
    injectedFrames: injectedStats.frames,
    injectedBlankFrames: injectedStats.blankFrames,
    injectedBlankRunMaxMs: injectedStats.blankRunMaxMs,
  })}`);

  expect(cleanStats.frames, "the recorder must have produced samples on the painted page").toBeGreaterThan(2);
  expect(cleanStats.blankFrames, "false positives: a painted transcript must not be reported blank").toBe(0);
  expect(injectedStats.frames, "the recorder must have produced samples while the overlay was up").toBeGreaterThan(0);
  expect(injectedStats.blankFrames, "the detector must fire when the band is known to be background-coloured").toBeGreaterThan(0);
});

test("PIXELS: screencast frame coverage against rAF frames on the same window", async ({ page }) => {
  test.setTimeout(180_000);
  const host = await openWithHost(page);
  await sendSnapshot(host, buildTranscriptEntries({ count: 400, seed: 2 }), 8);
  await waitForRow(page, sentinel(399));
  const band = await readBand(page);

  await startFrameProbe(page);
  const recorder = await startPixelRecorder(page, band);
  await wheelScroll(page, { deltaY: 200, times: 20, gapMs: 15 });
  await recorder.stop();
  const frames = await readFrameProbe(page);

  const samples = recorder.samples;
  const window = samples.length > 1 ? (samples[samples.length - 1]!.t - samples[0]!.t) : 1;
  const rafInWindow = frames.scrollTopSeries.filter((point) => point.t >= (samples[0]?.t ?? 0) && point.t <= (samples[samples.length - 1]?.t ?? 0)).length;
  console.log(`PERF_JSON ${JSON.stringify({
    id: "PIXEL-COVERAGE",
    sampler: recorder.kind,
    screencastFrames: samples.length,
    rafFramesInWindow: rafInWindow,
    windowMs: Math.round(window),
    coverage: rafInWindow === 0 ? null : Math.round((samples.length / rafInWindow) * 100) / 100,
  })}`);

  expect(samples.length, "the screencast must produce frames at all").toBeGreaterThan(1);
  expect(rafInWindow, "rAF must have run during the window").toBeGreaterThan(1);
});
