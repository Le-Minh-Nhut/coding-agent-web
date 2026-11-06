/**
 * Deterministic synthetic transcripts for the mobile performance gate (PERF-01..12).
 *
 * WHY generated and not committed: the measured conversation is ~4,075 entries and
 * ~12 MB, and that much text in the repo would be reviewed by nobody and diffed by
 * nobody. A seeded PRNG gives the same bytes on every run, which is the only reason
 * a number from one build can be compared with the number from the next.
 *
 * Everything here is pure: no browser object, no clock, no I/O, so the fixture can be
 * measured in Node (`approximateBytes`) as well as driven through the mock host.
 * Rows are built by the same helpers every other E2E spec uses (`./fixture.js`), so a
 * shape change there moves this fixture with it instead of drifting away from it.
 */
import { createAssistantMessageEntry, createToolResultEntry, createUserMessageEntry } from "./fixture.js";

export type PerfEntry = Record<string, unknown>;

/** The frame the mock host sends for one slice of a snapshot. */
export type SnapshotFrame = { t: "snapshot-chunk"; entries: PerfEntry[]; final: boolean };

/** mulberry32: 32-bit state, no dependency, and the same sequence in every runtime. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The tag every generated row's text starts with.
 *
 * A spec asserts a *specific* row is on screen by this tag, which is what makes a
 * virtualization mistake that silently drops the middle of the history fail instead
 * of quietly rendering a shorter conversation.
 */
export const sentinel = (index: number): string => `PERF-${index}-`;

/** Distinct subagent ids, carried on tool call ids so the rows name a real agent. */
export const SUBAGENT_IDS = ["subagent-scout-01", "subagent-test-02", "subagent-fix-03", "subagent-docs-04"] as const;

/** Enough vocabulary for 10,000 words without a dictionary file. */
const VOCAB = [
  "transcript", "virtualization", "optimistic", "listener", "budget", "measure", "sentinel", "gutter",
  "snapshot", "reconnect", "keystroke", "threshold", "frame", "identity", "retention", "reducer",
] as const;

/** A long user prompt, `words` words, deterministic per `seed`. */
export function buildLongPrompt(words = 10_000, seed = 1): string {
  const random = mulberry32(seed);
  const out: string[] = [];
  for (let index = 0; index < words; index += 1) out.push(VOCAB[Math.floor(random() * VOCAB.length * 0.999)]!);
  return `Task: ${out.join(" ")}`;
}

/**
 * A long assistant body: headings, a list, a wide markdown table, a fenced code
 * block and trailing prose — the mix that makes markdown parsing and layout cost
 * real, and the mix a naive "split on newline" renderer corrupts.
 */
export function buildLongMarkdown(index: number, seed = 1, tableRows = 40): string {
  const random = mulberry32(seed + index);
  const rows: string[] = [];
  for (let row = 0; row < tableRows; row += 1) {
    rows.push(`| node-${index}-${row} | ${Math.round(random() * 1000)} ms | ${Math.round(random() * 100)} MB | healthy |`);
  }
  return [
    `### Section ${index}`,
    "",
    "- first item",
    "- second item",
    `- third item with a long value ${"x".repeat(60)}`,
    "",
    "| node | latency | rss | state |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "```ts",
    `export function reconcile${index}(input: string): string {`,
    `  return input.repeat(${(index % 7) + 1});`,
    "}",
    "```",
    "",
    "Trailing paragraph explaining the migration window. ".repeat(6),
  ].join("\n");
}

const PATCH_SOURCE = "const value = compute(input, options, { retries: 3, timeoutMs: 5000 });";

/**
 * A large patch, in the form OMP actually sends: the **gutter** payload
 * (` 12|code`, `-7|old`, `+9|new`, blank line between hunks).
 *
 * Deliberately NOT a unified diff. `FileDiffView` draws gutter hunks
 * (`apps/web/src/files.ts:parseGutterDiff`, `GUTTER_RE` at :408), so a unified
 * fixture would render every `@@`/`+`/`-` line as plain context and prove a code
 * path no session takes — the same reasoning as `files-center.spec.ts`, which seeds
 * gutter payloads for the same reason. "Several hundred lines" is what the size
 * budget asks for, not the wire format.
 */
export function buildGutterPatch(lines = 300, seed = 1): string {
  const random = mulberry32(seed);
  const out: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    // A gap line closes a hunk: without one, every hunk in the file would be a
    // single giant block and the viewer's hunk navigation would have nowhere to go.
    if (index > 0 && index % 40 === 0) out.push("");
    const marker = index % 7 === 3 ? "-" : index % 7 === 4 ? "+" : " ";
    out.push(`${marker}${index + 1}|${PATCH_SOURCE} /* ${Math.floor(random() * 100000)} */`);
  }
  return out.join("\n");
}

/** Longer than any real turn's text, for the streaming path. */
export function buildStreamingText(sections = 12, seed = 7): string {
  const random = mulberry32(seed);
  const out: string[] = [];
  for (let index = 0; index < sections; index += 1) {
    out.push(`Part ${index}: ${VOCAB[Math.floor(random() * VOCAB.length * 0.999)]} chunk for the streaming transcript.`);
  }
  return out.join("\n");
}

/**
 * One advisor row, in the shape OMP writes and `apps/web/src/advisor.ts:64` reads:
 * a `custom_message` with `customType: "advisor"`, `display: true` (an advisor note
 * reaches a human only when OMP says so) and `details.notes[]` of
 * `{ note, severity, advisor, turnsAgo }`. Structurally typed, so no import of the
 * app's own module is needed and the shape is checkable at a glance.
 */
function advisorRow(index: number, timestamp: number, seed: number): PerfEntry {
  const severities = ["nit", "concern", "blocker"] as const;
  const advisors = ["adversarial-review", "spec-auditor", "perf-review"] as const;
  const random = mulberry32(seed + index);
  return {
    id: `advisor-${index}`,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    type: "custom_message",
    customType: "advisor",
    content: `${sentinel(index)}Advisor notes`,
    display: true,
    details: {
      notes: [
        {
          note: `${sentinel(index)}The retry path can resubmit a prompt the host already accepted.`,
          severity: severities[Math.floor(random() * severities.length * 0.999)]!,
          advisor: advisors[Math.floor(random() * advisors.length * 0.999)]!,
          turnsAgo: Math.floor(random() * 4),
        },
      ],
    },
  };
}

/**
 * One `edit` tool result carrying a real per-file gutter diff, in the host's shape.
 *
 * `content` MUST be an array of blocks and `details` must sit on the message:
 * `transcript.ts` builds a row's `toolResult` through `toToolResult`, which returns
 * `undefined` for a plain string `content` — and with no `toolResult` there is no
 * `details`, so the Files Center and the file rows would see no edit at all. This is
 * the same shape `files-center.spec.ts` seeds, for the same reason.
 */
function editRow(index: number, toolIndex: number, timestamp: number, patchLines: number, callId: string): PerfEntry {
  const path = `apps/web/src/perf/file-${String(toolIndex).padStart(3, "0")}.ts`;
  const diff = buildGutterPatch(patchLines, index);
  return {
    id: `t-${index}`,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "edit",
      content: [{ type: "text", text: `${sentinel(index)}Edited ${path}` }],
      details: { path, op: "update", diff, perFileResults: [{ path, op: "update", diff }] },
      isError: false,
      timestamp,
    },
  };
}

export interface TranscriptFixtureOptions {
  count: number;
  /** Emit one tool call/result row every N entries; 0 disables tool traffic. */
  toolEvery: number;
  withSubagents: boolean;
  withAdvisorNotes: boolean;
  bigMarkdown: boolean;
  /** Tool rows carry a ~300-line gutter patch (`buildGutterPatch`). */
  bigDiff: boolean;
  /** Words per user prompt; 0 emits a short one. `buildLongPrompt` is the 10k case. */
  longPromptWords: number;
  seed: number;
}

export const DEFAULT_FIXTURE_OPTIONS: TranscriptFixtureOptions = {
  count: 500,
  toolEvery: 0,
  withSubagents: false,
  withAdvisorNotes: false,
  bigMarkdown: false,
  bigDiff: false,
  longPromptWords: 0,
  seed: 1,
};

/** How long a large patch is, in gutter lines. */
export const BIG_PATCH_LINES = 300;

/**
 * A transcript with the shape that makes this app slow: many rows, real tool
 * traffic, long text, large diffs, advisor cards and subagent call ids.
 *
 * Every row's text starts with `PERF-<index>-` (`sentinel`), so a spec asserts a
 * specific row *by name* rather than counting rows and hoping.
 */
export function buildTranscriptEntries(options: Partial<TranscriptFixtureOptions> & { count: number }): PerfEntry[] {
  const { count, toolEvery, withSubagents, withAdvisorNotes, bigMarkdown, bigDiff, longPromptWords, seed } =
    { ...DEFAULT_FIXTURE_OPTIONS, ...options };
  const entries: PerfEntry[] = [];
  const base = 1_700_000_000_000;
  let toolIndex = 0;
  for (let index = 0; index < count; index += 1) {
    const at = base + index;
    const tag = sentinel(index);
    if (withAdvisorNotes && index % 13 === 12) {
      entries.push(advisorRow(index, at, seed));
      continue;
    }
    if (toolEvery > 0 && index % toolEvery === toolEvery - 1) {
      const subagent = withSubagents ? SUBAGENT_IDS[toolIndex % SUBAGENT_IDS.length]! : null;
      const callId = subagent === null ? `call-${index}` : `call-${index}-${subagent}`;
      entries.push(
        bigDiff
          ? editRow(index, toolIndex, at, BIG_PATCH_LINES, callId)
          : createToolResultEntry(`t-${index}`, callId, "bash", `${tag}\n$ echo ${index}\n${"output line\n".repeat(6)}`, false, at),
      );
      toolIndex += 1;
      continue;
    }
    const mode = index % 4;
    if (mode === 0) {
      const text = longPromptWords > 0 ? `${tag}${buildLongPrompt(longPromptWords, seed + index)}` : `${tag}user prompt number ${index}`;
      entries.push(createUserMessageEntry(`u-${index}`, text, at));
    } else if (mode === 1) {
      entries.push(
        createAssistantMessageEntry(
          `a-${index}`,
          bigMarkdown ? `${tag}assistant\n\n${buildLongMarkdown(index, seed)}` : `${tag}assistant answer ${index}`,
          at,
        ),
      );
    } else {
      entries.push(createAssistantMessageEntry(`a-${index}`, `${tag}short answer ${index}`, at));
    }
  }
  return entries;
}

/** Split entries into the snapshot frames the host would send, last one `final`. */
export function buildSnapshotFrames(entries: readonly PerfEntry[], options: { chunkCount?: number } = {}): SnapshotFrame[] {
  const chunkCount = Math.max(1, options.chunkCount ?? 24);
  const size = Math.max(1, Math.ceil(entries.length / chunkCount));
  const frames: SnapshotFrame[] = [];
  for (let start = 0; start < entries.length; start += size) {
    frames.push({ t: "snapshot-chunk", entries: entries.slice(start, start + size), final: start + size >= entries.length });
  }
  return frames;
}

/** Serialized size of a frame list — the number the ~12 MB preset is stated in. */
export function approximateBytes(frames: readonly SnapshotFrame[]): number {
  return JSON.stringify(frames).length;
}

/** The sizes the gate runs at: small, medium, the reported conversation, and 2x it. */
export const ENTRY_COUNTS = [100, 500, 2000, 4075, 8000] as const;

/**
 * The ~12 MB snapshot.
 *
 * MEASURED (Node, authoring run 2026-11-06):
 *   approximateBytes(buildSnapshotFrames(buildTranscriptEntries(SNAPSHOT_12MB), { chunkCount: 40 }))
 *   = 12,641,997 bytes = 12.06 MiB.
 *
 * The entry count is 1,400 rather than the reported conversation's 4,075 because the
 * density differs, not the payload: a real session's 4,075 entries average ~3 KB,
 * while this mix carries a ~300-line patch every sixth row plus wide markdown
 * tables, averaging ~9 KB. Byte size is what PERF-08 measures (parsing, render, peak
 * memory), so the preset is tuned to the bytes. Within ~1% of 12 MiB.
 *
 * `SNAPSHOT_12MB_BYTES` is the same measurement as a constant, checked by the spec so
 * a generator change that moves the size by more than ~10% fails loudly instead of
 * silently measuring a different conversation.
 */
export const SNAPSHOT_12MB: TranscriptFixtureOptions = {
  count: 1400,
  toolEvery: 6,
  withSubagents: true,
  withAdvisorNotes: true,
  bigMarkdown: true,
  bigDiff: true,
  longPromptWords: 40,
  seed: 12,
};

/** See `SNAPSHOT_12MB`. Bytes, not KiB. */
export const SNAPSHOT_12MB_BYTES = 12_641_997;
