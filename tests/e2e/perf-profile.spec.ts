/**
 * Where the scroll time actually goes, measured three ways that disagree usefully.
 *
 * The owner's symptom is a black transcript area during a fast upward flick on a
 * phone. Something on the main thread is holding the page for hundreds of
 * milliseconds while the gesture is happening; this spec names it rather than
 * guessing, and it does so with instruments whose blind spots are complementary:
 *
 *  1. **CDP `Performance.getMetrics`** — browser-side script / style / layout wall
 *     time and operation counts. This says *category*.
 *  2. **A V8 CPU profile** — self time per function in the production bundle. This
 *     says *function*, which is the only way to tell one of this app's own effects
 *     from React's reconciler.
 *  3. **A Chromium trace** (`perf-trace.ts`) — raster, composite and main-thread
 *     task facts, i.e. whether the cost is the renderer walking the DOM or the
 *     compositor failing to raster.
 *
 * Nothing here re-runs an interaction to confirm a number it already has, and no
 * memoisation decision is taken from any of these without the profile naming it.
 */
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { requireAppServer } from "./fixture.js";
import { buildTranscriptEntries, sentinel } from "./perf-fixtures.js";
import { HEAVY_TRANSCRIPT, openWithHost, programmaticScroll, scrollState, scrollToBottom, sendSnapshot, setCpuThrottle, touchFlick, waitForRow } from "./perf-scroll-harness.js";
import { summariseTrace, withTrace, type TraceSummary } from "./perf-trace.js";

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

const METRIC_KEYS = ["ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "TaskDuration", "TaskOtherDuration", "LayoutCount", "RecalcStyleCount", "Nodes", "JSEventListeners", "JSHeapUsedSize"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
type Metrics = Record<MetricKey, number>;

const readMetrics = async (cdp: CDPSession): Promise<Metrics> => {
  const result = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
  const map = new Map(result.metrics.map((entry) => [entry.name, entry.value]));
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, map.get(key) ?? 0])) as Metrics;
};

const diffMetrics = (before: Metrics, after: Metrics): Metrics =>
  Object.fromEntries(METRIC_KEYS.map((key) => [key, Math.round((after[key] - before[key]) * 1000) / 1000])) as Metrics;

/** V8 self time in the production bundle, aggregated by function name. */
interface ProfileRow { name: string; selfMs: number; url: string }

async function profileScroll(cdp: CDPSession, body: () => Promise<void>): Promise<ProfileRow[]> {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await body();
  const stopped = (await cdp.send("Profiler.stop")) as {
    profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string } }>; samples?: number[]; timeDeltas?: number[] };
  };
  await cdp.send("Profiler.disable");
  const byId = new Map(stopped.profile.nodes.map((node) => [node.id, node.callFrame]));
  const selfTime = new Map<string, { selfUs: number; url: string }>();
  const samples = stopped.profile.samples ?? [];
  const deltas = stopped.profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const frame = byId.get(samples[index]!);
    if (frame === undefined) continue;
    const fnName = frame.functionName === "" ? "(anonymous)" : frame.functionName;
    const fnFile = frame.url === "" ? "(native)" : frame.url.split("/").pop() ?? "";
    const key = `${fnName}@${fnFile}`;
    const existing = selfTime.get(key) ?? { selfUs: 0, url: frame.url };
    existing.selfUs += deltas[index] ?? 0;
    selfTime.set(key, existing);
  }
  return [...selfTime.entries()]
    .map(([key, value]) => ({ name: key, selfMs: Math.round((value.selfUs / 1000) * 10) / 10, url: value.url }))
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, 25);
}

interface ProfileCase {
  id: string;
  entries: number;
  heavy: boolean;
  throttle?: number;
  /** The gesture under profile: this is the owner's, unless stated. */
  gesture: "flick-up" | "programmatic-up";
}

async function runCase(page: Page, options: ProfileCase): Promise<void> {
  const host = await openWithHost(page);
  if (options.throttle !== undefined) await setCpuThrottle(page, options.throttle);
  await sendSnapshot(host, buildTranscriptEntries({ count: options.entries, seed: 3, ...(options.heavy ? HEAVY_TRANSCRIPT : {}) }), 40);
  await waitForRow(page, sentinel(options.entries - 1));
  await scrollToBottom(page);
  const before = await scrollState(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const trace = await withTrace(page, {}, async () => {
    const metricsBefore = await readMetrics(cdp);
    const profile = await profileScroll(cdp, async () => {
      if (options.gesture === "flick-up") {
        for (let flick = 0; flick < 6; flick += 1) await touchFlick(page, { distance: 420, steps: 6, direction: 1, gapMs: 30 });
      } else {
        await programmaticScroll(page, { from: before.height - before.client, to: 0, steps: 100 });
      }
    });
    const metricsAfter = await readMetrics(cdp);
    lastProfile = profile;
    lastMetrics = { before: metricsBefore, after: metricsAfter, delta: diffMetrics(metricsBefore, metricsAfter) };
  });
  await cdp.detach().catch(() => undefined);
  const after = await scrollState(page);
  const summary: TraceSummary = summariseTrace();

  console.log(`PERF_JSON ${JSON.stringify({
    id: options.id,
    entries: options.entries,
    heavy: options.heavy,
    throttle: options.throttle ?? 1,
    gesture: options.gesture,
    domElements: after.domElements,
    rowsMounted: after.rows,
    scrollHeightPx: after.height,
    metrics: lastMetrics.delta,
    topFunctions: lastProfile.slice(0, 12),
    trace: {
      paintTasks: summary.paint.count,
      paintTotalMs: summary.paint.totalMs,
      paintP95Ms: summary.paint.p95Ms,
      paintMaxMs: summary.paint.maxMs,
      mainThreadTasks: summary.mainThread.count,
      mainThreadTotalMs: summary.mainThread.totalMs,
      mainThreadMaxMs: summary.mainThread.maxMs,
      mainThreadTop: summary.mainThread.top.slice(0, 5),
      compositeCount: summary.composite.count,
      compositeTotalMs: summary.composite.totalMs,
      compositorFrames: summary.frames.length,
      compositorFrameGapP50Ms: summary.frameGaps.p50,
      compositorFrameGapP95Ms: summary.frameGaps.p95,
      compositorFrameGapMaxMs: summary.frameGaps.max,
      traceBytes: summary.bytes,
      events: Object.entries(summary.eventNames).sort((a, b) => b[1] - a[1]).slice(0, 12),
    },
  })}`);
}

let lastProfile: ProfileRow[] = [];
let lastMetrics: { before: Metrics; after: Metrics; delta: Metrics } = {
  before: {} as Metrics,
  after: {} as Metrics,
  delta: {} as Metrics,
};

test("PROFILE-01: plain 4075-entry transcript, programmatic bottom → top", async ({ page }) => {
  test.setTimeout(400_000);
  await runCase(page, { id: "PROFILE-01", entries: 4075, heavy: false, gesture: "programmatic-up" });
  expect(lastProfile.length, "the profiler must have sampled something").toBeGreaterThan(0);
});

test("PROFILE-02: heavy 4075-entry transcript, programmatic bottom → top", async ({ page }) => {
  test.setTimeout(400_000);
  await runCase(page, { id: "PROFILE-02", entries: 4075, heavy: true, gesture: "programmatic-up" });
  expect(lastProfile.length).toBeGreaterThan(0);
});

test("PROFILE-03: heavy 4075-entry transcript, real upward flicks", async ({ page }) => {
  test.setTimeout(400_000);
  await runCase(page, { id: "PROFILE-03", entries: 4075, heavy: true, gesture: "flick-up" });
  expect(lastProfile.length).toBeGreaterThan(0);
});

test("PROFILE-04: heavy 8000-entry transcript at 4x CPU throttle, real upward flicks", async ({ page }) => {
  test.setTimeout(600_000);
  await runCase(page, { id: "PROFILE-04", entries: 8000, heavy: true, throttle: 4, gesture: "flick-up" });
  expect(lastProfile.length).toBeGreaterThan(0);
});
