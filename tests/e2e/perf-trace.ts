/**
 * The tracing instrument: what the browser actually does while a long transcript
 * is flicked, taken from Chromium's own trace stream.
 *
 * Why a trace and not more screenshots: `Page.startScreencast` and
 * `Page.captureScreenshot` both force a complete raster before they copy the
 * surface. Measured on this machine, that path yields **1 frame per 6 s** during a
 * flick — it is structurally incapable of showing a region the compositor never
 * painted, which is precisely the failure being hunted. The trace's own
 * `Screenshot` events are captured by the GPU process as frames are presented, so
 * they carry the compositor's truth rather than the capture path's repair.
 *
 * Three facts come out of the trace, and they answer different questions:
 *
 *  - **Screenshot frames** — did the presented image contain a transcript? The
 *    pixel detector (`png.ts` decode → ink scan) runs over these.
 *  - **Frame gaps** — how long the compositor went with nothing new to show.
 *  - **Main-thread tasks and raster tasks** — whether the stall is the renderer
 *    walking the DOM or the compositor unable to keep up.
 *
 * The output is aggregated (counts, totals, p95) rather than dumped: a raw trace on
 * this workload is tens of megabytes and proves nothing a reader can check.
 */
import type { Page } from "@playwright/test";

export interface TraceEvent {
  name?: string;
  ph?: string;
  cat?: string;
  ts?: number;
  dur?: number;
  pid?: number;
  tid?: number;
  args?: Record<string, unknown>;
}

/** The categories that matter here, and nothing else. */
const CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  // The compositor's own frames, including the JPEGs the pixel detector reads.
  "disabled-by-default-devtools.screenshot",
  "cc",
  "gpu",
  "blink.user_timing",
  "toplevel",
  "benchmark",
].join(",");

export interface TraceSummary {
  /** Layout/paint/raster work, totals and worst. */
  paint: { count: number; totalMs: number; p95Ms: number; maxMs: number };
  /** Main-thread tasks at or over the long-task threshold, worst first. */
  mainThread: { count: number; totalMs: number; maxMs: number; top: Array<{ name: string; ms: number; start: number }> };
  /** Commit/activation rungs seen on the compositor. */
  composite: { count: number; totalMs: number; maxMs: number };
  /** Compositor frames with their presentation timestamps (µs, trace clock). */
  frames: Array<{ ts: number; jpeg: Buffer }>;
  /** Gaps between consecutive presented frames, ms: p50/p95/max. */
  frameGaps: { p50: number; p95: number; max: number; count: number };
  /** Rows of pure background detected in the transcript band, per frame index. */
  blankFrameIndices: number[];
  /** Every distinct event name with its count — what was available, stated plainly. */
  eventNames: Record<string, number>;
  /** Raw trace size in bytes, so a reader can judge coverage. */
  bytes: number;
}

interface TraceInk {
  blankRowRatio: number;
  blank: boolean;
}

let lastEvents: TraceEvent[] = [];
let lastBytes = 0;

export async function withTrace<T>(
  page: Page,
  options: { categories?: string; maxMs?: number },
  body: () => Promise<T>,
): Promise<{ result: T; chunks: number }> {
  const client = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  let bytes = 0;
  // `ReportEvents` hands each event over as a JSON string on this CDP version, while
  // Playwright's own typing describes the object form. Both shapes are accepted, so
  // neither an upgrade nor a downgrade silently drops events.
  client.on("Tracing.dataCollected", (payload) => {
    const entries: unknown[] = payload.value;
    for (const entry of entries) {
      bytes += typeof entry === "string" ? entry.length : 64;
      if (typeof entry === "string") {
        try {
          const parsed: unknown = JSON.parse(entry.trim().replace(/,$/, ""));
          if (typeof parsed === "object" && parsed !== null) events.push(parsed as TraceEvent);
        } catch {
          // A truncated event; skipping it loses one event, parsing it loses the run.
        }
      } else if (typeof entry === "object" && entry !== null) {
        events.push(entry as TraceEvent);
      }
    }
  });

  await client.send("Tracing.start", {
    categories: options.categories ?? CATEGORIES,
    transferMode: "ReportEvents",
  });
  const result = await body();
  const done = new Promise<void>((resolve) => {
    client.once("Tracing.tracingComplete", () => resolve());
  });
  await client.send("Tracing.end");
  await Promise.race([done, page.waitForTimeout(options.maxMs ?? 30_000)]);
  await client.detach().catch(() => undefined);
  lastEvents = events;
  lastBytes = bytes;
  return { result, chunks: events.length };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return round2(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0);
}

/** Luminance above which a pixel counts as ink against the near-black app background. */
const INK_LUMINANCE = 28;
const BLANK_ROW_FRACTION = 0.98;

/**
 * Read one trace screenshot and decide whether the transcript band held any ink.
 *
 * `decodeFrame` is injected rather than imported so this module has no opinion about
 * image formats, and `band` is in CSS pixels with the frame's own scale supplied —
 * the trace captures at the device pixel ratio, which is 2 on the phone viewport.
 */
export function measureFrameInk(frame: Buffer, band: { x: number; y: number; width: number; height: number }, scale: number, decode: (buffer: Buffer) => { width: number; height: number; pixels: Uint8Array }): TraceInk {
  const decoded = decode(frame);
  const x0 = Math.max(0, Math.round(band.x * scale));
  const x1 = Math.min(decoded.width, Math.round((band.x + band.width) * scale));
  const y0 = Math.max(0, Math.round(band.y * scale));
  const y1 = Math.min(decoded.height, Math.round((band.y + band.height) * scale));
  if (x1 <= x0 || y1 <= y0) return { blankRowRatio: 0, blank: false };
  let blankRows = 0;
  const rows = y1 - y0;
  for (let y = y0; y < y1; y += 1) {
    let ink = false;
    for (let x = x0; x < x1; x += 1) {
      const at = (y * decoded.width + x) * 4;
      const luminance = 0.2126 * (decoded.pixels[at] ?? 0) + 0.7152 * (decoded.pixels[at + 1] ?? 0) + 0.0722 * (decoded.pixels[at + 2] ?? 0);
      if (luminance > INK_LUMINANCE) {
        ink = true;
        break;
      }
    }
    if (!ink) blankRows += 1;
  }
  const blankRowRatio = blankRows / rows;
  return { blankRowRatio, blank: blankRowRatio >= BLANK_ROW_FRACTION };
}

export function summariseTrace(): TraceSummary {
  const paintDurations: number[] = [];
  const mainThreadTasks: Array<{ name: string; ms: number; start: number }> = [];
  const compositeDurations: number[] = [];
  const frames: Array<{ ts: number; jpeg: Buffer }> = [];
  const eventNames: Record<string, number> = {};

  for (const event of lastEvents) {
    if (event.name === undefined) continue;
    eventNames[event.name] = (eventNames[event.name] ?? 0) + 1;
    if (event.name === "Screenshot" && typeof event.args?.["snapshot"] === "string") {
      frames.push({ ts: event.ts ?? 0, jpeg: Buffer.from(event.args["snapshot"], "base64") });
      continue;
    }
    if (event.dur === undefined) continue;
    const ms = event.dur / 1000;
    if (["Paint", "PaintArtifactCompositor::Update", "Layerize", "RasterTask", "RasterImpl", "UpdateLayer", "UpdateLayerTree"].includes(event.name)) paintDurations.push(ms);
    else if (["CompositeLayers", "ActivateLayerTree", "Commit"].includes(event.name)) compositeDurations.push(ms);
    // `RunTask` is the top-level task on whichever thread ran it. Only main-thread work
    // at or above the 50 ms long-task threshold is collected: below that it is the
    // scheduler's business, not the user's.
    else if (event.name === "RunTask" && ms >= 50) mainThreadTasks.push({ name: event.name, ms: round2(ms), start: round2((event.ts ?? 0) / 1000) });
  }

  frames.sort((a, b) => a.ts - b.ts);
  const gaps: number[] = [];
  for (let index = 1; index < frames.length; index += 1) gaps.push((frames[index]!.ts - frames[index - 1]!.ts) / 1000);
  const gapSorted = [...gaps].sort((a, b) => a - b);
  const paintSorted = [...paintDurations].sort((a, b) => a - b);
  const mainSorted = [...mainThreadTasks].sort((a, b) => b.ms - a.ms);
  const compositeSorted = [...compositeDurations].sort((a, b) => a - b);

  return {
    paint: {
      count: paintDurations.length,
      totalMs: round2(paintDurations.reduce((sum, value) => sum + value, 0)),
      p95Ms: percentile(paintSorted, 0.95),
      maxMs: round2(paintSorted[paintSorted.length - 1] ?? 0),
    },
    mainThread: {
      count: mainThreadTasks.length,
      totalMs: round2(mainThreadTasks.reduce((sum, value) => sum + value.ms, 0)),
      maxMs: mainSorted[0]?.ms ?? 0,
      top: mainSorted.slice(0, 8),
    },
    composite: {
      count: compositeDurations.length,
      totalMs: round2(compositeDurations.reduce((sum, value) => sum + value, 0)),
      maxMs: round2(compositeSorted[compositeSorted.length - 1] ?? 0),
    },
    frames,
    frameGaps: { p50: percentile(gapSorted, 0.5), p95: percentile(gapSorted, 0.95), max: round2(gapSorted[gapSorted.length - 1] ?? 0), count: gaps.length },
    blankFrameIndices: [],
    eventNames,
    bytes: lastBytes,
  };
}

/** Run the ink check over every trace frame and fill `blankFrameIndices`. */
export function analyseTraceFrames(
  summary: TraceSummary,
  band: { x: number; y: number; width: number; height: number },
  scale: number,
  decode: (buffer: Buffer) => { width: number; height: number; pixels: Uint8Array },
): TraceSummary {
  const blank: number[] = [];
  summary.frames.forEach((frame, index) => {
    try {
      if (measureFrameInk(frame.jpeg, band, scale, decode).blank) blank.push(index);
    } catch {
      // An undecodable frame is not evidence of a blank one; it is skipped and counted
      // by `frames.length` against the number of indices here.
    }
  });
  return { ...summary, blankFrameIndices: blank };
}
