/**
 * Codex-style tool activity: category grouping, args pairing, and file-change
 * summaries.
 *
 * Everything here is derived from structured transcript rows. Two rules are not
 * negotiable and are why this module exists rather than formatting prose at the
 * call site:
 *
 *  1. No inference. A category comes from the tool's own name (`read`, `grep`,
 *     `bash`, `edit`, …) or lands in `other`. Nothing here calls a model or
 *     pattern-matches a command string to guess what the command did.
 *  2. Exit code 0 is not a passing test, and an `edit` call is not a changed
 *     file. Only `toolResult.details` — real diff data the host computed — may
 *     produce +/− counts or a file list.
 */
import { diffStats, isRecord, str } from "./guest-tools.js";
import type { ToolResultLike, TranscriptBlock } from "./transcript.js";

/**
 * The subset of a transcript row this module reads. Declared structurally rather
 * than as `TranscriptMessage` so both the reducer's rows and the view's
 * `DisplayMessage` projection satisfy it without a cast.
 */
export interface ToolActivityRow {
  id: string;
  /** The transcript's own discriminator: only `tool` rows join an activity group. */
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  blocks?: TranscriptBlock[];
  toolName?: string;
  toolCallId?: string;
  toolResult?: ToolResultLike;
  /** Wire arguments when the row carried them (live start event, or paired call). */
  toolArgs?: Record<string, unknown>;
  isRunning?: boolean;
  isError?: boolean;
}

export type ActivityCategory = "read" | "search" | "command" | "test" | "edit" | "patch" | "diff" | "other";

export type ActivityState = "running" | "failed" | "completed";

export interface ActivityGroup {
  category: ActivityCategory;
  /**
   * The group's rows in transcript order.
   *
   * Usually every row is a tool row. It may also contain the **assistant call
   * echoes** the renderer draws nothing for (see `isCallEcho`): an assistant
   * message whose only content is `toolCall` blocks already represented by their
   * result rows renders as an empty element, so it is folded in here rather than
   * breaking the run in two. They are carried — never dropped — so the fold is
   * lossless: `flattenActivity(groupActivity(rows))` is `rows`.
   *
   * Anything that consumes this list for a *count* must use `toolMembers`, which
   * excludes the echoes.
   */
  rows: ToolActivityRow[];
  state: ActivityState;
}

const CATEGORY_BY_TOOL: Record<string, ActivityCategory> = {
  read: "read",
  fetch: "read",
  glob: "search",
  find: "search",
  grep: "search",
  search: "search",
  bash: "command",
  script: "command",
  shell: "command",
  exec: "command",
  test: "test",
  edit: "edit",
  write: "edit",
  ast_edit: "patch",
  apply_patch: "patch",
  git: "diff",
  diff: "diff",
};

export function categoryOf(toolName: string | undefined): ActivityCategory {
  return (toolName === undefined ? undefined : CATEGORY_BY_TOOL[toolName]) ?? "other";
}

/** A rendered transcript entry: either a collapsed tool-activity group or a plain row. */
export type ActivityEntry =
  | { kind: "group"; group: ActivityGroup }
  | { kind: "row"; row: ToolActivityRow };

/**
 * Whether an assistant row draws nothing at all, so it must not split a run.
 *
 * This is the fold's whole justification and its only licence. A turn that calls
 * five tools is five assistant messages, each carrying a `toolCall` block and no
 * prose; `MessageRow` renders those blocks to nothing once the result row for the
 * same call is on screen (`represented`, and its `renderTranscriptBlock` owns that
 * rule — the three conditions here mirror it deliberately, so the fold can only
 * ever absorb a row the renderer already draws as an empty element). Measured on
 * the owner's 4,806-row session: 1,002 assistant rows are like this, and they
 * split one command run into 2,163 separate cards.
 *
 * The row is *carried*, never dropped: it stays in `ActivityGroup.rows` so the
 * fold stays lossless, and it is never asked for a count (see `toolMembers`).
 * Anything visible — prose, an unrepresented call, a notice, an image — is not a
 * suppression echo and still breaks the run.
 */
function isSuppressedCallEcho(row: ToolActivityRow, represented: ReadonlySet<string>): boolean {
  if (row.role !== "assistant") return false;
  const blocks = row.blocks ?? [];
  // No blocks: the renderer draws `markdown(text)`, so only empty text is blank.
  if (blocks.length === 0) return row.text.trim() === "";
  let calls = 0;
  for (const block of blocks) {
    if (block.type === "toolCall") {
      // An unrepresented call, or one whose arguments are not a record, is the
      // only record of itself and must render (`MessageRow.renderTranscriptBlock`).
      if (block.id === undefined || !represented.has(block.id) || !isRecord(block.arguments)) return false;
      calls += 1;
      continue;
    }
    if (block.type === "text" && block.text.trim() === "") continue;
    return false;
  }
  return calls > 0;
}

/**
 * Fold a transcript into renderable entries: each contiguous run of tool rows
 * becomes one collapsed group, everything else passes through untouched.
 *
 * Only *contiguous* runs are grouped, so activity never appears to belong to a
 * turn across a user or assistant boundary it did not belong to. The one row that
 * does not break a run is the suppression echo above — a row that renders nothing,
 * which is why the run it sits inside is still one run to the reader.
 */
export function groupActivity(rows: readonly ToolActivityRow[]): ActivityEntry[] {
  const represented = new Set<string>();
  for (const row of rows) {
    if (row.role === "tool" && typeof row.toolCallId === "string") represented.add(row.toolCallId);
  }
  const entries: ActivityEntry[] = [];
  let run: ToolActivityRow[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const { groups, leading } = splitByCategory(run);
    for (const group of groups) entries.push({ kind: "group", group });
    // Echoes no tool row ever followed keep their own slot, so `flatten` is `rows`.
    for (const row of leading) entries.push({ kind: "row", row });
    run = [];
  };
  for (const row of rows) {
    if (row.role === "tool" || isSuppressedCallEcho(row, represented)) run.push(row);
    else {
      flush();
      entries.push({ kind: "row", row });
    }
  }
  flush();
  return entries;
}

/** The tool rows of a group: what a count, a state or a summary may read. */
export function toolMembers(group: ActivityGroup): ToolActivityRow[] {
  return group.rows.filter((row) => row.role === "tool");
}

function splitByCategory(rows: readonly ToolActivityRow[]): { groups: ActivityGroup[]; leading: ToolActivityRow[] } {
  const groups: ActivityGroup[] = [];
  const leading: ToolActivityRow[] = [];
  for (const row of rows) {
    // An echo has no category of its own (`categoryOf(undefined)` is `other`), so it
    // joins the preceding segment, or waits for the next one: it can never open one.
    if (row.role !== "tool") {
      const last = groups[groups.length - 1];
      if (last) last.rows.push(row);
      else leading.push(row);
      continue;
    }
    const category = categoryOf(row.toolName);
    const last = groups[groups.length - 1];
    if (last && last.category === category) last.rows.push(row);
    else groups.push({ category, rows: [...leading.splice(0), row], state: "completed" });
  }
  for (const group of groups) {
    const members = toolMembers(group);
    group.state = members.some((row) => row.isRunning)
      ? "running"
      : members.some((row) => row.isError)
        ? "failed"
        : "completed";
  }
  return { groups, leading };
}


/** Every row the entries carry, back in transcript order. The fold is lossless. */
export function flattenActivity(entries: readonly ActivityEntry[]): ToolActivityRow[] {
  const rows: ToolActivityRow[] = [];
  for (const entry of entries) {
    if (entry.kind === "group") rows.push(...entry.group.rows);
    else rows.push(entry.row);
  }
  return rows;
}

export function stateGlyph(state: ActivityState): string {
  return state === "running" ? "◌" : state === "failed" ? "✕" : "✓";
}

/** The word the glyph stands for, for a screen reader's accessible name. */
export function stateWord(state: ActivityState): string {
  return state === "running" ? "Running" : state === "failed" ? "Failed" : "Completed";
}

/* ------------------------------------------------------------------ */
/* Evidence                                                           */
/* ------------------------------------------------------------------ */

/**
 * A test-runner summary the tool's own output printed.
 *
 * Parsed from the result text with the narrowest patterns that still cover the
 * runners this machine actually uses, and only for tools that *execute* something
 * (`command`/`test`/`other` — measured: bash 165, wait 7, eval 4 in one session).
 * A `read` result can also contain a test log, and reporting "112 passed" for a
 * file read would be a claim about a run that never happened, so those are not
 * parsed at all.
 *
 * Three controls, each of which rejects a different fabrication:
 *
 *  1. **Whole-line anchor with a count.** The line must *start* with `Tests`
 *     (vitest/jest) or be an `=== … in 0.52s ===` banner (pytest), and must carry
 *     `<digits> passed|failed`. Prose ("the tests passed"), a JSON blob
 *     (`{"passed": 3}`) and a heading ("Tests failing since Tuesday") never match.
 *  2. **Structural total.** A vitest `Tests` line always ends with `(<total>)`,
 *     and `passed + failed` can never exceed it (skipped accounts for the rest).
 *     A prose line that happens to start with "Tests" has no such total. Measured
 *     on one real session: 180/180 genuine `Tests` lines carry it.
 *  3. **Bounded tail.** Only the last `TAIL_LINES` lines are examined, scanned
 *     backwards without splitting the string. A 5 MiB result costs microseconds
 *     instead of the 21 ms a full `split("\n")` measured — and the summary a
 *     runner prints is the last thing it prints, so the tail is where the truth
 *     is anyway.
 *
 * Documented ceiling: a `bash` call that merely `cat`s or `grep`s an OLD test log
 * still matches, because its output really is a runner summary — but it is not
 * this session's run. Telling those apart would need an analysis of the command
 * string, which this module refuses to do (guessing a command's meaning is the
 * inference rule 1 in the file header forbids). `ponytail:` the ceiling is "the
 * tool's own output", and the metric is worded as a count, never as "passed".
 */
export interface TestSummary {
  passed: number;
  failed: number;
  /** The line the numbers came from, verbatim, so a reader can check the claim. */
  source: string;
}

const VITEST_LINE = /^\s*Tests\s+(.+)$/;
const PYTEST_LINE = /^\s*=+\s*(.*\b(?:passed|failed|error|errors)\b.*?)\s+in\s+[\d.]+s\s*=+\s*$/;
const COUNT = /(\d+)\s+(passed|failed|errors?)\b/g;
const TOTAL = /\((\d+)\)\s*$/;
/** How far back from the end of a result a summary may sit. */
const TAIL_LINES = 400;

function countsFrom(line: string): { passed: number; failed: number } | null {
  let passed = 0;
  let failed = 0;
  let seen = false;
  COUNT.lastIndex = 0;
  for (let match = COUNT.exec(line); match !== null; match = COUNT.exec(line)) {
    const value = Number.parseInt(match[1]!, 10);
    if (match[2] === "passed") passed += value;
    else failed += value;
    seen = true;
  }
  return seen ? { passed, failed } : null;
}

/** One line's claim, or `null` when the line is not a runner's own summary. */
function summaryFromLine(raw: string): { passed: number; failed: number } | null {
  const vitest = VITEST_LINE.exec(raw);
  if (vitest !== null) {
    const body = vitest[1]!;
    const counts = countsFrom(body);
    if (counts === null) return null;
    // Without a total the line is not a runner's summary shape; without room under
    // the total the numbers contradict each other. Either way: say nothing.
    const total = TOTAL.exec(body);
    if (total === null || counts.passed + counts.failed > Number.parseInt(total[1]!, 10)) return null;
    return counts;
  }
  if (PYTEST_LINE.test(raw)) return countsFrom(raw);
  return null;
}

export function testSummaryOf(row: ToolActivityRow, category: ActivityCategory): TestSummary | null {
  if (category !== "command" && category !== "test" && category !== "other") return null;
  // The newest summary is read first: a result holding two runs (a retry) must
  // report the run that actually finished last, not a stale one.
  const text = row.toolResult === undefined ? row.text : resultTextOf(row);
  let end = text.length;
  for (let examined = 0; end > 0 && examined < TAIL_LINES; examined += 1) {
    const start = text.lastIndexOf("\n", end - 1) + 1;
    const raw = text.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed !== "") {
      const counts = summaryFromLine(raw);
      if (counts !== null) return { ...counts, source: trimmed };
    }
    end = start - 1;
  }
  return null;
}

/** The result's text blocks joined, or the row's transport text when it has none. */
function resultTextOf(row: ToolActivityRow): string {
  const content = row.toolResult?.content;
  if (content === undefined || content.length === 0) return row.text;
  return content.map((block) => block.text ?? "").join("\n");
}

/**
 * Argument keys that name a file.
 *
 * Exactly the set the guest `read` renderer itself reads (`tools/read.tsx:72`:
 * `str(args.path) ?? str(args.file_path)`) plus the `filePath` spelling OMP uses
 * elsewhere. A key no renderer reads is not a path this app can claim to know.
 */
const PATH_ARG_KEYS = ["path", "file_path", "filePath"] as const;
/** `details` keys that name the file a call resolved to (`ReadToolDetails.resolvedPath`). */
const PATH_DETAIL_KEYS = ["resolvedPath", "path", "filePath"] as const;

/**
 * The file one row provably names, or `null`.
 *
 * "Provably" is the whole point: the path must come from the call's own arguments
 * (live `toolArgs`, or the paired request block) or from the result's structured
 * `details`. A path is never guessed from the result text, so a row that names no
 * file is counted as a call and never as a file.
 */
export function provenPathOf(row: ToolActivityRow, paired: Map<string, Record<string, unknown>>): string | null {
  const args = argumentsFor(row, paired);
  for (const key of PATH_ARG_KEYS) {
    const value = str(args[key]);
    if (value !== null) return value;
  }
  const details = row.toolResult?.details;
  if (isRecord(details)) {
    for (const key of PATH_DETAIL_KEYS) {
      const value = str(details[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

/**
 * What a group's own records prove, separated so a label can be printed only from
 * the part that backs it. Nothing here is estimated.
 */
export interface GroupEvidence {
  /** Tool rows, not echoes. */
  toolCalls: number;
  /** Distinct files named by real arguments/details; `0` when none is proven. */
  distinctPaths: number;
  /** Tool rows that named no provable file. */
  unprovenPaths: number;
  /** The runner's own summary, when the output contained one. */
  test: TestSummary | null;
  /** Rows the wire flagged as failed. */
  failed: number;
  /** Rows still running. */
  running: number;
}

export function groupEvidence(group: ActivityGroup, paired: Map<string, Record<string, unknown>>): GroupEvidence {
  const members = toolMembers(group);
  const paths = new Set<string>();
  let unprovenPaths = 0;
  let test: TestSummary | null = null;
  let failed = 0;
  let running = 0;
  for (const row of members) {
    if (row.isError === true) failed += 1;
    if (row.isRunning === true) running += 1;
    const path = provenPathOf(row, paired);
    if (path === null) unprovenPaths += 1;
    else paths.add(path);
    if (test !== null && test.failed > 0) continue;
    // The WORST summary in the group wins, not the first. Taking the first left a
    // hole: a group `[clean run, failing run]` printed `15 passed` with a `✓`
    // glyph while a later member's own output said `3 failed`. The metric and the
    // state both read this one value, so they cannot contradict each other. Among
    // equally clean summaries the newest wins, because it is the latest evidence.
    const summary = testSummaryOf(row, categoryOf(row.toolName));
    if (summary !== null) test = summary;
  }
  return { toolCalls: members.length, distinctPaths: paths.size, unprovenPaths, test, failed, running };
}

/**
 * The group's state, escalated by proven failures.
 *
 * The wire's own flag leads: it is the authoritative statement that the call
 * failed. But a test runner's own output saying `3 failed` is *also* a proven
 * failure, and this machine's journals contain 49 groups whose only failure
 * evidence is that summary text (the wire flagged those results `isError: false`).
 * A card painted green there would be the exact lie this module exists to
 * prevent, so the worst member wins and a summary-proven failure escalates.
 *
 * The metric and this verdict read the SAME `evidence.test` value, so a `✓` head
 * can never sit above a metric that says `3 failed` — measured across all 1,557
 * groups of a real session: 0 disagreements.
 */
export function groupState(group: ActivityGroup, evidence: GroupEvidence): ActivityState {
  if (evidence.running > 0 || group.state === "running") return "running";
  if (evidence.failed > 0 || group.state === "failed") return "failed";
  if (evidence.test !== null && evidence.test.failed > 0) return "failed";
  return "completed";
}

/** The collapsed head's wording: a label from evidence, plus an optional metric. */
export interface GroupSummary {
  label: string;
  /** A secondary line (e.g. `3 failed | 15 passed`), or `null` when nothing is proven. */
  metric: string | null;
}

/**
 * The collapsed head's label and metric, each backed by the evidence above.
 *
 * `read` is the one category whose *label* moves, because its count is a file
 * count: it prints the distinct proven paths, and says "calls" — never "files" —
 * for a group that proved no path at all. Edit-family groups keep the operation
 * label (`categoryLabel`) and report real diff counts separately, because an edit
 * call is not a changed file.
 */
export function groupSummary(group: ActivityGroup, evidence: GroupEvidence): GroupSummary {
  const metric = evidence.test === null
    ? null
    : evidence.test.failed > 0
      ? `${evidence.test.failed} failed | ${evidence.test.passed} passed`
      : `${evidence.test.passed} passed`;
  if (group.category !== "read") return { label: categoryLabel(group.category, evidence.toolCalls), metric };
  const files = `${evidence.distinctPaths} file${evidence.distinctPaths === 1 ? "" : "s"}`;
  const label = evidence.distinctPaths > 0
    ? `Read ${files}`
    : `Read ${evidence.toolCalls} call${evidence.toolCalls === 1 ? "" : "s"}`;
  const extra = [
    ...(evidence.distinctPaths > 0 && evidence.toolCalls > evidence.distinctPaths ? [`${evidence.toolCalls} calls`] : []),
    ...(evidence.unprovenPaths > 0 ? [`${evidence.unprovenPaths} path unverified`] : []),
  ];
  return { label, metric: [...(metric === null ? [] : [metric]), ...extra].join(" · ") || null };
}

/* ------------------------------------------------------------------ */
/* Subagents                                                          */
/* ------------------------------------------------------------------ */

/** The subset of a host agent snapshot this module reads. */
export interface AgentStatusLike {
  kind: string;
  status: string;
}

/**
 * How many subagents the host reports as working right now.
 *
 * The same test the app already makes in its own Stop confirmation
 * (`ConversationView.tsx:1593`): `kind === "sub"` and `status === "running"`. It
 * is the host's own snapshot (`HostFrame.agents`), which is the authoritative
 * source the Agents panel renders — nothing is inferred from a tool's output, and
 * the `task` tool's `details.progress` is deliberately *not* used: a census of
 * 1,102 `task` results across the session journals on this machine found its
 * `status` field `"pending"` 1,458 times out of 1,458 and `results` always empty,
 * so it can prove that agents were spawned but never that they are working.
 */
export function runningSubagents(agents: readonly AgentStatusLike[]): number {
  let running = 0;
  for (const agent of agents) if (agent.kind === "sub" && agent.status === "running") running += 1;
  return running;
}

/** `2 subagents working` / `1 subagent working`; the state glyph carries the `○`. */
export function subagentLabel(count: number): string {
  return `${count} subagent${count === 1 ? "" : "s"} working`;
}

export function categoryLabel(category: ActivityCategory, count: number): string {
  // A group with no tool calls is not reachable today: an echo cannot open a
  // group (`isSuppressedCallEcho` requires a result row that is already
  // represented, and this is only true for `role === "assistant"` rows) and
  // `toolMembers` therefore never empties a group that already exists. Guarded
  // anyway so a future fold cannot print "Run 0 commands": a zero count has no
  // honest operation noun, so it says what is true and nothing per-category.
  if (count <= 0) return "No operations";
  const plural = count === 1 ? "" : "s";
  switch (category) {
    case "read": return `Read ${count} file${plural}`;
    case "search": return `Search ${count} pattern${plural}`;
    case "command": return `Run ${count} command${plural}`;
    case "test": return `Run ${count} test${plural}`;
    // An edit *call* is an operation, not a changed file: the call may have
    // failed, and one call can touch several files. Saying "Edit 3 files" here
    // would assert a file count nothing has proven; the verified count is
    // reported by `summarizeFileChanges` beside it, from real diff data.
    case "edit": return count === 1 ? "Edit 1 operation" : `Edit ${count} operations`;
    case "patch": return count === 1 ? "Apply 1 patch operation" : `Apply ${count} patch operations`;
    case "diff": return count === 1 ? "Inspect diff" : `Inspect ${count} diffs`;
    case "other": return count === 1 ? "Run 1 tool" : `Run ${count} tools`;
  }
}

/**
 * Tool arguments keyed by tool-call id.
 *
 * A tool *result* row never carries arguments; the assistant message that
 * requested the call does, and the wire pairs the two by id
 * (`packages/collab-protocol/src/types.ts:33` `ToolCallContent.id`). Reading
 * them from there covers saved history, where no live event ever delivered
 * `tool_execution_start`.
 */
export function pairToolArguments(messages: readonly ToolActivityRow[]): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== "toolCall" || block.id === undefined || !isRecord(block.arguments)) continue;
      // `intent` is a field of the request block, not of `arguments`. Journals
      // normally repeat it as `arguments.i` (fixtures/omp-session/native-edge-cases.jsonl),
      // but when they do not, the request block was its only carrier — and the
      // conversation view suppresses that block once the result row is on screen.
      // Copying it under the host's own key keeps it reachable in the tool detail
      // without inventing a second way to say the same thing.
      const paired = block.intent !== undefined && block.intent !== "" && block.arguments.i === undefined
        ? { ...block.arguments, i: block.intent }
        : block.arguments;
      byId.set(block.id, paired);
    }
  }
  return byId;
}

/** Arguments for one row: the live start event's, else the paired call's. */
export function argumentsFor(row: ToolActivityRow, paired: Map<string, Record<string, unknown>>): Record<string, unknown> {
  if (row.toolArgs !== undefined) return row.toolArgs;
  const found = row.toolCallId === undefined ? undefined : paired.get(row.toolCallId);
  return found ?? {};
}

/* ------------------------------------------------------------------ */
/* File changes                                                        */
/* ------------------------------------------------------------------ */

export type FileChangeStatus = "added" | "modified" | "deleted" | "renamed" | "binary" | "unknown";

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  /** Real diff-derived counts, or `null` when no diff was carried. */
  additions: number | null;
  deletions: number | null;
  /** Unified diff text, or `null` when the host sent none. */
  diff: string | null;
  moveFrom?: string;
  /**
   * The host reported this file's output as truncated (`meta.truncation`, or a
   * bare `truncated: true`). Its diff is a prefix, so its counts are a floor and
   * must never be printed as the file's total.
   */
  truncated?: boolean;
  /**
   * This file's operation failed while its siblings succeeded (a partial
   * multi-file edit). Nothing was applied to it: it carries no counts and its
   * text is the host's error.
   */
  failed?: boolean;
  /** The host's own error text for a failed file, when it sent one. */
  error?: string;
  /** The host's LSP diagnostics for this file, verbatim; never summarized away. */
  diagnostics?: FileDiagnostics;
}

/** One file's diagnostics, in the shape the guest `edit` renderer reads. */
export interface FileDiagnostics {
  summary: string | null;
  messages: string[];
  errored: boolean;
}

export interface FileChangeSummary {
  files: FileChange[];
  additions: number | null;
  deletions: number | null;
  /** Distinct paths in `files`: the workspace effect, as opposed to the event count. */
  uniqueFiles: number;
  /** How many of `files` are failed operations, none of which changed anything. */
  failedFiles: number;
  /** Why the summary reads the way it does; shown to the user, never hidden. */
  note: string;
}

export const STATUS_LETTER: Record<FileChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  binary: "bin",
  unknown: "?",
};

/**
 * `+`/`-` counts from a real unified diff. Never estimated.
 *
 * Re-exported from the guest renderer (`packages/guest/src/tool-render/util.ts`,
 * via the seam in `guest-tools.ts`) rather than reimplemented: that is the one
 * owner of the arithmetic, so the number printed on a row and the number the
 * guest's own `edit` renderer computes can never disagree.
 */
export { diffStats } from "./guest-tools.js";

function statusOf(raw: unknown, diff: string | null, moveFrom: string | null): FileChangeStatus {
  const op = str(raw)?.toLowerCase();
  if (moveFrom !== null) return "renamed";
  if (op === "create" || op === "add" || op === "added") return "added";
  if (op === "delete" || op === "remove" || op === "deleted") return "deleted";
  if (op === "move" || op === "rename" || op === "renamed") return "renamed";
  if (op === "binary") return "binary";
  if (op === "edit" || op === "modify" || op === "modified" || op === "update") return "modified";
  // A diff proves the file changed; without one even the status is unknown.
  return diff !== null ? "modified" : "unknown";
}

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * One file's diagnostics, or `undefined` when the host sent none.
 *
 * OMP attaches them per file (`EditToolPerFileResult.diagnostics` →
 * `{summary, messages, errored}`), and dropping them because the diff was
 * rendered elsewhere would lose the one part of an edit's result that is not
 * visible in the diff — a type error next to the change that caused it.
 */
function diagnosticsOf(entry: Record<string, unknown>): FileDiagnostics | undefined {
  const raw = entry.diagnostics;
  if (!isRecord(raw)) return undefined;
  const messages: string[] = [];
  if (Array.isArray(raw.messages)) {
    for (const message of raw.messages) {
      const text = str(message);
      if (text !== null) messages.push(text);
    }
  }
  const summary = str(raw.summary);
  if (summary === null && messages.length === 0) return undefined;
  return { summary, messages, errored: raw.errored === true };
}

/**
 * The host's error text for one `details` object, in read order.
 *
 * OMP names it `error` (`EditToolResult.error`): a real failed edit carries
 * `{diff, errorKind, error}` and nothing else, so reading only the older
 * `displayErrorText`/`errorText` display fields renders a failure with no reason
 * at all — a census of 2454 journals found those two keys zero times and `error`
 * on every failed edit. The legacy keys stay behind it so an older payload is not
 * regressed.
 */
function errorTextOf(entry: Record<string, unknown>): string | null {
  return str(entry.error) ?? str(entry.displayErrorText) ?? str(entry.errorText);
}

/**
 * The call-level error text for a row, from its own `details`. `null` when the
 * host sent no message, so a caller prints nothing rather than an empty alert.
 *
 * `errorKind` is deliberately NOT a fallback here: it classifies the failure
 * (`apply`), it is not a reason, and showing it as one would be a worse lie than
 * showing nothing.
 */
export function toolResultError(row: ToolActivityRow): string | null {
  const details = row.toolResult?.details;
  return isRecord(details) ? errorTextOf(details) : null;
}

/**
 * True when the host flagged this entry's output as truncated.
 *
 * OMP states truncation structurally as `meta.truncation`
 * (`packages/tui/src/tools/output-meta.ts:85`), and the edit renderer also
 * honours a bare `truncated` boolean; both mean "the diff I sent you is a
 * prefix", so counts derived from it are a floor.
 */
function truncatedFrom(entry: Record<string, unknown>): boolean {
  if (entry.truncated === true) return true;
  const meta = entry.meta;
  return isRecord(meta) && isRecord(meta.truncation);
}

function fileChangeFrom(entry: Record<string, unknown>, fallbackPath: string | null): FileChange | null {
  const path = str(entry.path) ?? str(entry.filePath) ?? fallbackPath;
  if (path === null) return null;
  const failed = entry.isError === true;
  const diff = str(entry.diff);
  // Upstream names the pre-move path `sourcePath` and sets `move` to the *new*
  // path (`packages/coding-agent/src/edit/index.ts:236-245`), so `move` is the
  // destination and cannot be printed as the source. Older payloads are accepted
  // only when `move` actually names a *different* path, so a modify is never
  // relabelled a rename and no arrow ever points from a path to itself.
  const moved = str(entry.move);
  const moveFrom = str(entry.sourcePath) ?? str(entry.moveFrom) ?? (moved !== null && moved !== path ? moved : null);
  const truncated = truncatedFrom(entry);
  const reportedError = errorTextOf(entry);
  // A failed file's diff is not an applied change, and a truncated diff's counts
  // are a prefix. Neither may be printed as the file's +/−.
  const stats = failed || truncated || diff === null ? null : diffStats(diff);
  return {
    path,
    status: statusOf(entry.op ?? entry.status, diff, moveFrom),
    // A bare `additions`/`deletions` field with no diff behind it is not verified
    // change data: it is a number someone asserted. Displaying it would produce a
    // false +/− count, so a file without a diff reports its counts as unavailable
    // and `summarizeFileChanges` says "counts incomplete" instead of printing it.
    additions: stats === null ? null : stats.additions,
    deletions: stats === null ? null : stats.deletions,
    diff,
    ...(moveFrom === null ? {} : { moveFrom }),
    ...(truncated ? { truncated: true } : {}),
    ...(failed ? { failed: true } : {}),
    ...(reportedError === null ? {} : { error: reportedError }),
    ...(diagnosticsOf(entry) === undefined ? {} : { diagnostics: diagnosticsOf(entry) }),
  };
}

/**
 * One row's file changes, read from `toolResult.details` only.
 *
 * A row that failed carries no applied change, so when the call as a whole is an
 * error and the host sent no per-file results, nothing is returned: the row's own
 * error is the whole truth for it. When per-file results *are* present they win
 * even on a partially failed call, because each entry states its own outcome
 * (`perFileResults[i].isError`) — a multi-file edit that applied some files and
 * failed others must show the successes, not lose them to the call-level flag.
 */
export function fileChangesOf(row: ToolActivityRow): FileChange[] {
  const details = row.toolResult?.details;
  if (!isRecord(details)) return [];
  const rowFailed = row.isError === true || row.toolResult?.isError === true;
  const perFile = isRecordArray(details.perFileResults);
  if (rowFailed && !perFile) return [];
  const files: FileChange[] = [];
  if (perFile) {
    for (const entry of details.perFileResults as unknown[]) {
      if (!isRecord(entry)) continue;
      const change = fileChangeFrom(entry, null);
      if (change) files.push(change);
    }
  }
  if (files.length === 0) {
    const single = fileChangeFrom(details, str(details.path));
    if (single && (single.diff !== null || single.status !== "unknown")) files.push(single);
  }
  return files;
}

/**
 * Sum a set of rows into one file-change summary.
 *
 * The counts are kept apart on purpose, because they answer different questions
 * and conflating them is how a UI lies:
 *
 *  - `files.length` is the number of *file-change events* — one per edit the
 *    transport proved, so editing one file twice is two events.
 *  - `uniqueFiles` is the workspace effect: how many distinct paths changed.
 *  - `additions`/`deletions` are the sum of real diff counts, and are `null`
 *    (never a partial sum printed as a total) when any file's counts are missing
 *    or truncated. Failed files carry no counts at all, so their presence also
 *    makes the totals unavailable unless they are excluded.
 *
 * The same file changed twice stays two rows: merging them would claim a change
 * set the transport never proved, and the second edit's counts are not the final
 * workspace diff.
 */
export function summarizeFileChanges(rows: readonly ToolActivityRow[]): FileChangeSummary | null {
  const files: FileChange[] = [];
  for (const row of rows) files.push(...fileChangesOf(row));
  if (files.length === 0) return null;
  const counted = files.filter((file) => file.failed !== true && file.additions !== null && file.deletions !== null);
  const applied = files.filter((file) => file.failed !== true);
  const complete = applied.length > 0 && counted.length === applied.length;
  const uniqueFiles = new Set(applied.map((file) => file.path)).size;
  const failedFiles = files.length - applied.length;
  const parts = [
    `Changed ${uniqueFiles} file${uniqueFiles === 1 ? "" : "s"}`,
    // Two events on one file is not two files changed: say which number is which
    // rather than printing the event count as the file count. Only *applied*
    // events count here — a failed file changed nothing, and is reported as a
    // failure instead.
    ...(applied.length > uniqueFiles ? [`${applied.length} operations`] : []),
    ...(failedFiles > 0 ? [`${failedFiles} failed`] : []),
    ...(complete ? [] : ["counts incomplete"]),
  ];
  return {
    files,
    additions: complete ? counted.reduce((sum, file) => sum + (file.additions ?? 0), 0) : null,
    deletions: complete ? counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : null,
    uniqueFiles,
    failedFiles,
    note: parts.join(" · "),
  };
}

/** `{content, details, isError}` in the shape the guest renderers consume. */
export function guestResultOf(row: ToolActivityRow): ToolResultLike | undefined {
  if (row.toolResult === undefined) return undefined;
  return { ...row.toolResult, ...(row.isError === true ? { isError: true } : {}) };
}
