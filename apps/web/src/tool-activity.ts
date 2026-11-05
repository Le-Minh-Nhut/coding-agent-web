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
  /** Rows in this category, in transcript order. */
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
 * Fold a transcript into renderable entries: each contiguous run of tool rows
 * becomes one collapsed group, everything else passes through untouched.
 *
 * Only *contiguous* runs are grouped, so activity never appears to belong to a
 * turn across a user or assistant boundary it did not belong to.
 */
export function groupActivity(rows: readonly ToolActivityRow[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let run: ToolActivityRow[] = [];
  const flush = () => {
    if (run.length === 0) return;
    for (const group of splitByCategory(run)) entries.push({ kind: "group", group });
    run = [];
  };
  for (const row of rows) {
    if (row.role === "tool") run.push(row);
    else {
      flush();
      entries.push({ kind: "row", row });
    }
  }
  flush();
  return entries;
}

function splitByCategory(rows: readonly ToolActivityRow[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const row of rows) {
    const category = categoryOf(row.toolName);
    const last = groups[groups.length - 1];
    if (last && last.category === category) last.rows.push(row);
    else groups.push({ category, rows: [row], state: "completed" });
  }
  for (const group of groups) {
    group.state = group.rows.some((row) => row.isRunning)
      ? "running"
      : group.rows.some((row) => row.isError)
        ? "failed"
        : "completed";
  }
  return groups;
}


export function stateGlyph(state: ActivityState): string {
  return state === "running" ? "◌" : state === "failed" ? "✕" : "✓";
}

export function categoryLabel(category: ActivityCategory, count: number): string {
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
      if (block.type === "toolCall" && block.id !== undefined && isRecord(block.arguments)) byId.set(block.id, block.arguments);
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
