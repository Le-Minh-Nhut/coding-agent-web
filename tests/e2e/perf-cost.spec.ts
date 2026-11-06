import { expect, test, type Page } from "@playwright/test";
import {
  createAssistantMessageEntry,
  createToolResultEntry,
  createUserMessageEntry,
  harnessFixture,
  installMockCollabHost,
  openSeededConversation,
  requireAppServer,
  type MockCollabHost,
} from "./fixture.js";

/**
 * The round's decision instrument: browser-side cost only.
 *
 * Every earlier attempt in this round was contaminated, and the contamination was
 * always the same shape — `page.evaluate` brackets count the CDP round trip and
 * Playwright's own work, and a V8 profile reports "idle" for layout, style and
 * paint because they are not JavaScript. Both errors point the same way: the
 * number must come from the browser's own counters, and the harness must not be
 * inside the measured interval.
 *
 * So:
 *  - LOAD cost is read from CDP `Performance` counters (script / style / layout
 *    wall time, plus cumulative counts) sampled either side of the snapshot.
 *  - UPDATE cost is a burst of frames sent back-to-back with no per-frame wait,
 *    so the client finishes chewing after Node has finished sending; the values
 *    that matter are the browser's own layout/style/script deltas for the burst.
 *  - FROZEN time is the longest main-thread task, which is what the user feels.
 *
 * The transcript shape is the reported one: 4075 entries with real tool traffic.
 */

const LARGE = 4075;

const KEYS = ["ScriptDuration", "RecalcStyleDuration", "LayoutDuration", "TaskDuration", "LayoutCount", "RecalcStyleCount"] as const;
type Key = (typeof KEYS)[number];
type Metrics = Record<Key, number>;

function buildEntries(count: number): unknown[] {
  const entries: unknown[] = [];
  const base = 1_700_000_000_000;
  for (let index = 0; index < count; index += 1) {
    const at = base + index;
    switch (index % 4) {
      case 0:
        entries.push(createUserMessageEntry(`u-${index}`, `PERF-${index}-user prompt number ${index}`, at));
        break;
      case 1:
        entries.push(createAssistantMessageEntry(`a-${index}`, `PERF-${index}-assistant\n\n## Section ${index}\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst v${index} = ${index};\n\`\`\`\n\n${"paragraph text ".repeat(12)}`, at));
        break;
      case 2:
        entries.push(createToolResultEntry(`t-${index}`, `call-${index}`, "bash", `PERF-${index}-tool\n$ echo ${index}\n${"output line\n".repeat(6)}`, false, at));
        break;
      default:
        entries.push(createAssistantMessageEntry(`a-${index}`, `PERF-${index}-short answer ${index}`, at));
    }
  }
  return entries;
}

async function metrics(cdp: { send: (method: string, params?: object) => Promise<unknown> }): Promise<Metrics> {
  const result = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
  const out = {} as Metrics;
  for (const key of KEYS) out[key] = result.metrics.find((metric) => metric.name === key)?.value ?? 0;
  return out;
}

function diff(before: Metrics, after: Metrics): Metrics {
  const out = {} as Metrics;
  for (const key of KEYS) {
    const raw = after[key] - before[key];
    out[key] = key.endsWith("Count") ? raw : Math.round(raw * 1000 * 10) / 10;
  }
  return out;
}

/** Wait for the whole snapshot to be mounted, without bracketing the wait in page time. */
async function waitForRows(page: Page, rows: number, timeout = 180_000): Promise<void> {
  await page.evaluate(
    ({ rows, timeout }) =>
      new Promise<void>((resolve, reject) => {
        const started = performance.now();
        const check = () => {
          if (document.querySelectorAll(".messages-content > *").length >= rows) return resolve();
          if (performance.now() - started > timeout) return reject(new Error(`never reached ${rows} rows`));
          requestAnimationFrame(check);
        };
        check();
      }),
    { rows, timeout },
  );
}

async function loadLarge(page: Page, host: MockCollabHost): Promise<void> {
  const entries = buildEntries(LARGE);
  const size = Math.ceil(LARGE / 24);
  await host.send({
    t: "welcome", proto: 3,
    header: { type: "session", id: "native-1", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" },
    state: { isStreaming: true, queuedMessageCount: 0, cwd: "/workspace", participants: [] },
    agents: [], entryCount: LARGE,
  });
  for (let start = 0; start < LARGE; start += size) {
    await host.send({ t: "snapshot-chunk", entries: entries.slice(start, start + size), final: start + size >= LARGE });
  }
  await waitForRows(page, LARGE);
}

/** The longest main-thread task during a burst, in ms. This is the felt freeze. */
async function longestTask(page: Page, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { __longestTask?: number };
    w.__longestTask = 0;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const w2 = window as unknown as { __longestTask?: number };
          w2.__longestTask = Math.max(w2.__longestTask ?? 0, Math.round(entry.duration));
        }
      }).observe({ type: "longtask" });
    } catch {
      // Chromium-only.
    }
  });
  await action();
  await page.waitForTimeout(800);
  return page.evaluate(() => Math.round((window as unknown as { __longestTask?: number }).__longestTask ?? 0));
}

test.beforeEach(async ({ request }) => {
  await requireAppServer(request);
});

test("PERF-COST: browser-side load and streaming cost at 4075 entries", async ({ page }) => {
  test.slow();
  test.setTimeout(600_000);
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  await openSeededConversation(page);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");

  const loadBefore = await metrics(cdp);
  const loadTask = await longestTask(page, () => loadLarge(page, host));
  const loadAfter = await metrics(cdp);
  const load = diff(loadBefore, loadAfter);
  const dom = await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    rows: document.querySelectorAll(".messages-content > *").length,
    // Row height is the check that catches `contain: size` (which reports cheap
    // layout because it collapsed the rows to nothing).
    firstRowHeight: Math.round((document.querySelector(".messages-content > *") as HTMLElement | null)?.getBoundingClientRect().height ?? 0),
    scrollHeight: Math.round(document.querySelector<HTMLElement>(".messages-scroll")?.scrollHeight ?? 0),
    heapMb: typeof (performance as unknown as { memory?: object }).memory === "object"
      ? Math.round(((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) * 10) / 10
      : null,
  }));

  console.log(`PERF_COST_LOAD ${JSON.stringify({ ...load, loadTask, ...dom })}`);

  // A burst: frames sent with no per-frame wait, so the client is the bottleneck.
  const UPDATES = 30;
  const before = await metrics(cdp);
  const streamTask = await longestTask(page, async () => {
    for (let index = 0; index < UPDATES; index += 1) {
      await host.send({
        t: "event",
        event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "streaming sentence number ".repeat(3).repeat(index + 1) }], stopReason: null } },
      });
    }
  });
  const after = await metrics(cdp);
  const stream = diff(before, after);
  console.log(`PERF_COST_STREAM ${JSON.stringify({ ...stream, streamTask, perUpdate: {
    script: Math.round((stream.ScriptDuration / UPDATES) * 100) / 100,
    style: Math.round((stream.RecalcStyleDuration / UPDATES) * 100) / 100,
    layout: Math.round((stream.LayoutDuration / UPDATES) * 100) / 100,
  } })}`);

  expect(dom.rows, "the whole transcript must stay in the document").toBeGreaterThan(LARGE / 2);
  expect(dom.firstRowHeight, "a row must still have real height").toBeGreaterThan(20);
});

/**
 * The reported symptom, split into its two real shapes — because the clean
 * instrument just showed they cost nothing alike.
 *
 *  (a) *updates* to a streaming message: React coalesces them, one layout pass,
 *      0.44ms of layout per frame, no long task. Cheap.
 *  (b) *appends* of new rows while streaming (the realistic case: tool calls,
 *      results, new turns): each append changes the document's geometry.
 *
 * Both are re-measured at 4x CPU throttle, because a laptop hides exactly this,
 * and with a longer burst than fits in one frame.
 */
test("PERF-COST-THROTTLED: updates vs appends into a full history, 4x CPU", async ({ page }) => {
  test.slow();
  test.setTimeout(600_000);
  const fixture = harnessFixture();
  const host = await installMockCollabHost(page, { conversationId: fixture.seededConversationId });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Performance.enable");
  await openSeededConversation(page);
  await loadLarge(page, host);

  const UPDATES = 60;

  // (a) updates to the streaming message
  const beforeUpdates = await metrics(cdp);
  const updateTask = await longestTask(page, async () => {
    for (let index = 0; index < UPDATES; index += 1) {
      await host.send({
        t: "event",
        event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "streaming sentence number ".repeat(4).repeat(index + 1) }], stopReason: null } },
      });
    }
  });
  const afterUpdates = await metrics(cdp);
  const updates = diff(beforeUpdates, afterUpdates);
  console.log(`PERF_THROTTLED_UPDATES ${JSON.stringify({ ...updates, longestTask: updateTask, perUpdate: {
    script: Math.round((updates.ScriptDuration / UPDATES) * 100) / 100,
    layout: Math.round((updates.LayoutDuration / UPDATES) * 100) / 100,
    task: Math.round((updates.TaskDuration / UPDATES) * 100) / 100,
  } })}`);

  // (b) appends: new tool rows arriving while the agent works
  const APPENDS = 60;
  const beforeAppends = await metrics(cdp);
  const appendTask = await longestTask(page, async () => {
    for (let index = 0; index < APPENDS; index += 1) {
      await host.send({
        t: "event",
        event: { type: "tool_execution_end", toolCallId: `perf-append-${index}`, toolName: "bash", result: `PERF-APPEND-${index}\n$ run ${index}\n`, isError: false },
      });
    }
  });
  const afterAppends = await metrics(cdp);
  const appends = diff(beforeAppends, afterAppends);
  console.log(`PERF_THROTTLED_APPENDS ${JSON.stringify({ ...appends, longestTask: appendTask, perAppend: {
    script: Math.round((appends.ScriptDuration / APPENDS) * 100) / 100,
    layout: Math.round((appends.LayoutDuration / APPENDS) * 100) / 100,
    task: Math.round((appends.TaskDuration / APPENDS) * 100) / 100,
  } })}`);

  const dom = await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    rows: document.querySelectorAll(".messages-content > *").length,
    heapMb: Math.round(((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) * 10) / 10,
  }));
  console.log(`PERF_THROTTLED_DOM ${JSON.stringify(dom)}`);
});
