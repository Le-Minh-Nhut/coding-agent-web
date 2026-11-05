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
    case "edit": return `Edit ${count} file${plural}`;
    case "patch": return `Apply ${count} patch${plural}`;
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
  truncated?: boolean;
}

export interface FileChangeSummary {
  files: FileChange[];
  additions: number | null;
  deletions: number | null;
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

function fileChangeFrom(entry: Record<string, unknown>, fallbackPath: string | null): FileChange | null {
  const path = str(entry.path) ?? str(entry.filePath) ?? fallbackPath;
  if (path === null) return null;
  const diff = str(entry.diff);
  const moveFrom = str(entry.move) ?? str(entry.moveFrom);
  const stats = diff === null ? null : diffStats(diff);
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
    ...(entry.truncated === true ? { truncated: true } : {}),
  };
}

/** One row's file changes, read from `toolResult.details` only. */
export function fileChangesOf(row: ToolActivityRow): FileChange[] {
  const details = row.toolResult?.details;
  if (!isRecord(details)) return [];
  const files: FileChange[] = [];
  if (Array.isArray(details.perFileResults)) {
    for (const entry of details.perFileResults) {
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
 * The same file changed twice stays two rows: merging them would claim a change
 * set the transport never proved, and the second edit's counts are not the final
 * workspace diff.
 */
export function summarizeFileChanges(rows: readonly ToolActivityRow[]): FileChangeSummary | null {
  const files: FileChange[] = [];
  for (const row of rows) files.push(...fileChangesOf(row));
  if (files.length === 0) return null;
  const counted = files.filter((file) => file.additions !== null && file.deletions !== null);
  const complete = counted.length === files.length;
  return {
    files,
    additions: complete ? counted.reduce((sum, file) => sum + (file.additions ?? 0), 0) : null,
    deletions: complete ? counted.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : null,
    note: complete
      ? `Changed ${files.length} file${files.length === 1 ? "" : "s"}`
      : `Changed ${files.length} file${files.length === 1 ? "" : "s"} · counts incomplete`,
  };
}

/** `{content, details, isError}` in the shape the guest renderers consume. */
export function guestResultOf(row: ToolActivityRow): ToolResultLike | undefined {
  if (row.toolResult === undefined) return undefined;
  return { ...row.toolResult, ...(row.isError === true ? { isError: true } : {}) };
}
