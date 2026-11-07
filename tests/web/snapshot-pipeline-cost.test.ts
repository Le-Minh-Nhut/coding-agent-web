import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { buildTranscriptEntries, buildSnapshotFrames, SNAPSHOT_12MB, type PerfEntry } from "../e2e/perf-fixtures.js";
import { createTranscriptState, reduceHostFrame, type HostFrame } from "../../apps/web/src/transcript.js";
import { groupActivity, pairToolArguments, summarizeFileChanges } from "../../apps/web/src/tool-activity.js";
import { collectChangedFiles } from "../../apps/web/src/files.js";
import { summarizeAdvisorNotes } from "../../apps/web/src/advisor.js";
import {
  buildOffsets,
  computeWindow,
  estimateHeights,
  fallbackHeightFor,
  entryKey,
  DEFAULT_OVERSCAN_PX,
} from "../../apps/web/src/transcript-window.js";
import type { DisplayMessage } from "../../apps/web/src/components/MessageRow.js";

/**
 * Phase 5 pipeline stage measurement.
 *
 * Measures initial snapshot load latency stage by stage:
 *   1. JSON parse of snapshot frames
 *   2. Transcript reducer / state accumulation (reduceHostFrame)
 *   3. Derived view model (summaries, groupings, pairings)
 *   4. Virtualized window (heights, offsets, computeWindow)
 *   5. First-paint window slice (cost if derived model only processed visible window)
 */

interface StageStats {
  median: number;
  p95: number;
  max: number;
  n: number;
  notes: string;
}

function calculateStats(samples: number[], notes: string): StageStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const median = sorted[Math.floor(n / 2)]!;
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))]!;
  const max = sorted[n - 1]!;
  return { median, p95, max, n, notes };
}

function formatTable(title: string, stats: Record<string, StageStats>): string {
  const lines = [
    `\n### ${title}`,
    `| stage | median | p95 | max | n | notes |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const [stage, s] of Object.entries(stats)) {
    lines.push(
      `| ${stage} | ${s.median.toFixed(2)} ms | ${s.p95.toFixed(2)} ms | ${s.max.toFixed(2)} ms | ${s.n} | ${s.notes} |`,
    );
  }
  return lines.join("\n");
}

function measurePipeline(entries: readonly PerfEntry[], chunkCount = 40, runs = 7) {
  const frames = buildSnapshotFrames(entries, { chunkCount });
  const frameStrings = frames.map((f) => JSON.stringify(f));
  const totalBytes = frameStrings.reduce((acc, s) => acc + s.length, 0);
  const welcomeFrame: HostFrame = {
    t: "welcome",
    agents: [],
    readOnly: false,
    entryCount: entries.length,
    state: { isStreaming: false, model: { id: "test" } },
  };
  const welcomeString = JSON.stringify(welcomeFrame);

  const samples = {
    jsonParse: [] as number[],
    reducer: [] as number[],
    derivedViewModel: [] as number[],
    virtualWindow: [] as number[],
    firstPaintWindowOnly: [] as number[],
    totalPurePipeline: [] as number[],
  };

  // Warmup run
  {
    const parsedWelcome = JSON.parse(welcomeString) as HostFrame;
    const parsedChunks = frameStrings.map((s) => JSON.parse(s) as HostFrame);
    let state = createTranscriptState();
    state = reduceHostFrame(state, parsedWelcome);
    for (const chunk of parsedChunks) state = reduceHostFrame(state, chunk);
    const msgs = state.messages;
    const rows: DisplayMessage[] = msgs.map((m) => ({
      ...m,
      source: m.source ?? "entry",
      toolResult: m.toolResult,
      isError: m.isError,
    }));
    summarizeAdvisorNotes(msgs.map((m) => ({ customType: m.customType, details: m.customDetails })));
    summarizeFileChanges(rows);
    collectChangedFiles(rows);
    const entriesList = groupActivity(rows);
    pairToolArguments(rows);
    const keys = entriesList.map(entryKey);
    const fallbacks = entriesList.map(fallbackHeightFor);
    const heights = estimateHeights(new Array(keys.length), fallbacks);
    const offsets = buildOffsets(heights, 0);
    computeWindow({
      offsets,
      scrollTop: offsets[offsets.length - 1]! - 667,
      viewportPx: 667,
      overscanPx: DEFAULT_OVERSCAN_PX,
    });
  }

  for (let iter = 0; iter < runs; iter += 1) {
    // Stage 1: JSON Parse
    const t0 = performance.now();
    const parsedWelcome = JSON.parse(welcomeString) as HostFrame;
    const parsedChunks = frameStrings.map((s) => JSON.parse(s) as HostFrame);
    const t1 = performance.now();

    // Stage 2: Reducer replay & state accumulation
    let state = createTranscriptState();
    state = reduceHostFrame(state, parsedWelcome);
    for (const chunk of parsedChunks) {
      state = reduceHostFrame(state, chunk);
    }
    const t2 = performance.now();

    // Stage 3: Derived view model
    const msgs = state.messages;
    summarizeAdvisorNotes(msgs.map((m) => ({ customType: m.customType, details: m.customDetails })));
    const rows: DisplayMessage[] = msgs.map((m) => ({
      ...m,
      source: m.source ?? "entry",
      toolResult: m.toolResult,
      isError: m.isError,
    }));
    summarizeFileChanges(rows);
    collectChangedFiles(rows);
    const entriesList = groupActivity(rows);
    pairToolArguments(rows);
    const t3 = performance.now();

    // Stage 4: Virtualized window
    const keys = entriesList.map(entryKey);
    const fallbacks = entriesList.map(fallbackHeightFor);
    const heights = estimateHeights(new Array(keys.length), fallbacks);
    const offsets = buildOffsets(heights, 0);
    computeWindow({
      offsets,
      scrollTop: offsets[offsets.length - 1]! - 667,
      viewportPx: 667,
      overscanPx: DEFAULT_OVERSCAN_PX,
    });
    const t4 = performance.now();

    // First paint window slice (e.g. last 40 entries needed for viewport)
    const windowSlice = rows.slice(-40);
    const t5_0 = performance.now();
    groupActivity(windowSlice);
    pairToolArguments(windowSlice);
    const t5_1 = performance.now();

    samples.jsonParse.push(t1 - t0);
    samples.reducer.push(t2 - t1);
    samples.derivedViewModel.push(t3 - t2);
    samples.virtualWindow.push(t4 - t3);
    samples.firstPaintWindowOnly.push(t5_1 - t5_0);
    samples.totalPurePipeline.push(t4 - t0);
  }

  const mb = (totalBytes / (1024 * 1024)).toFixed(2);
  const stats = {
    "1. JSON parse of frames": calculateStats(samples.jsonParse, `JSON.parse of welcome + ${frames.length} chunk frames (${mb} MB)`),
    "2. Reducer accumulation": calculateStats(samples.reducer, `reduceHostFrame welcome + ${frames.length} chunks + addEntriesBatch`),
    "3. Derived view model": calculateStats(samples.derivedViewModel, `advisor, file summaries, groupActivity, pairToolArguments`),
    "4. Virtualized window": calculateStats(samples.virtualWindow, `estimateHeights, buildOffsets, computeWindow`),
    "Total pure pipeline": calculateStats(samples.totalPurePipeline, `Sum of stages 1..4`),
    "First paint window slice": calculateStats(samples.firstPaintWindowOnly, `groupActivity + pairToolArguments for ~40 visible rows`),
  };

  return { entriesCount: entries.length, totalBytes, framesCount: frames.length, stats };
}

describe("Initial snapshot load pipeline instrumentation (Phase 5)", () => {
  it("measures 4,075 entries (the owner's real size)", () => {
    const entries = buildTranscriptEntries({ count: 4075 });
    const { stats, totalBytes, framesCount } = measurePipeline(entries, 40, 7);
    const table = formatTable(`4,075 entries (${(totalBytes / (1024 * 1024)).toFixed(2)} MB, ${framesCount} chunks)`, stats);
    console.log(table);

    expect(stats["Total pure pipeline"].median).toBeLessThan(100);
    expect(stats["1. JSON parse of frames"].median).toBeLessThan(50);
    expect(stats["2. Reducer accumulation"].median).toBeLessThan(50);
  });

  it("measures 4,075 entries with heavy tools/diffs (worst-case payload)", () => {
    const entries = buildTranscriptEntries({
      count: 4075,
      toolEvery: 6,
      withSubagents: true,
      withAdvisorNotes: true,
      bigMarkdown: true,
      bigDiff: true,
      longPromptWords: 40,
    });
    const { stats, totalBytes, framesCount } = measurePipeline(entries, 40, 7);
    const table = formatTable(`4,075 heavy entries (${(totalBytes / (1024 * 1024)).toFixed(2)} MB, ${framesCount} chunks)`, stats);
    console.log(table);

    expect(stats["Total pure pipeline"].median).toBeLessThan(350);
  });

  it("measures 12 MB snapshot (SNAPSHOT_12MB preset)", () => {
    const entries = buildTranscriptEntries(SNAPSHOT_12MB);
    const { stats, totalBytes, framesCount } = measurePipeline(entries, 40, 7);
    const table = formatTable(`12 MB snapshot (${(totalBytes / (1024 * 1024)).toFixed(2)} MB, ${framesCount} chunks, ${entries.length} entries)`, stats);
    console.log(table);

    expect(stats["Total pure pipeline"].median).toBeLessThan(200);
  });

  it("measures 8,000 entries (2x reported size)", () => {
    const entries = buildTranscriptEntries({ count: 8000 });
    const { stats, totalBytes, framesCount } = measurePipeline(entries, 40, 7);
    const table = formatTable(`8,000 entries (${(totalBytes / (1024 * 1024)).toFixed(2)} MB, ${framesCount} chunks)`, stats);
    console.log(table);

    expect(stats["Total pure pipeline"].median).toBeLessThan(150);
  });
});
