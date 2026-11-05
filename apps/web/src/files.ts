/**
 * The Files Center's data layer: one entry per changed path, derived from real
 * `toolResult.details` only. Pure, so every honesty rule below is testable
 * without a DOM.
 *
 * What these numbers are, said once because the whole module exists to keep it
 * true: they are **edit events this conversation's transcript recorded**, not
 * workspace state. There is no git access on this transport (no `git`,
 * `child_process`, `execFile` or `spawn(` anywhere in `apps/server`), so the only
 * change a read can prove is "the host reported this edit". Two consequences are
 * load-bearing:
 *
 *  - editing one path twice yields ONE entry with `edits: 2` and
 *    `observedAdditions`/`observedDeletions` as the SUM of the two observed
 *    events. The field names say `observed` because the sum is not the file's net
 *    diff: the second edit may have removed what the first added. Anything that
 *    printed this as "the change to this file" would be inventing a workspace
 *    state from a log.
 *  - `lastDiff` is the most recent diff the host sent for this path, kept for the
 *    viewer. It is one edit's snapshot, never the file's current contents.
 *
 * The +/− arithmetic itself is not here: `diffStats` in the guest seam is the
 * single owner, reused through `fileChangesOf`, so the Files Center and the
 * conversation's own file rows can never disagree about a count.
 */
import { isRecord, str } from "./guest-tools.js";
import { fileChangesOf, type ToolActivityRow, type FileChangeStatus } from "./tool-activity.js";

/** One path's aggregate, in the shape the Files Center renders. */
export interface ChangedFile {
  path: string;
  /** Last path segment; the row's primary label. */
  shortName: string;
  /** Everything before the last segment, `""` for a bare filename. */
  directory: string;
  status: FileChangeStatus;
  /** How many edit events this transcript recorded for the path. */
  edits: number;
  /**
   * How many of those events actually APPLIED. This is the field the Files Center
   * counts, because it is the one the dashboard card's `uniqueFiles` also derives
   * from (`summarizeFileChanges` counts distinct paths among non-failed file
   * changes). Counting `edits` instead made the two screens disagree: one applied
   * edit plus one failed edit read as "2 files" here and "Changed 1 file" there.
   */
  appliedEdits: number;
  /** Sum of the observed events' additions, or `null` when any event lacks counts. */
  observedAdditions: number | null;
  /** Sum of the observed events' deletions, or `null` when any event lacks counts. */
  observedDeletions: number | null;
  /** At least one event for this path failed; nothing the failed event claimed was applied. */
  failed: boolean;
  /** At least one event's diff arrived truncated, so its counts are a floor. */
  truncated: boolean;
  /** The host's own error text, from the most recent event that carried one. */
  errorText: string | null;
  /** The most recent diff the host sent for this path, or `null` if it sent none. */
  lastDiff: string | null;
  /** Pre-move path, only when a move was actually present. Never guessed. */
  moveFrom: string | null;
  /**
   * The raw `details` object (or `perFileResults[i]`) the entry came from, for the
   * viewer's Technical details disclosure. `null` when the host sent nothing.
   */
  rawDetails: unknown;
}

export interface ChangedFilesSummary {
  total: number;
  /**
   * Distinct paths with at least one APPLIED edit — the count the dashboard card
   * prints. Equal to `total` minus the paths whose only events failed, which is
   * why it exists: the two screens must not disagree about how many files changed.
   */
  appliedFiles: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  binary: number;
  unknown: number;
  failed: number;
  /** `null` unless every applied file's counts are known — never a partial sum. */
  observedAdditions: number | null;
  observedDeletions: number | null;
  truncated: boolean;
}

export interface ChangedFileFilter {
  /** Case-insensitive substring over the full path. */
  query?: string;
  status?: "all" | FileChangeStatus;
}

/** The documented, stable orderings the sort control cycles. */
export type ChangedFileSort = "changes" | "path" | "status";
export const CHANGED_FILE_SORTS: readonly ChangedFileSort[] = ["changes", "path", "status"];

export const CHANGED_FILE_SORT_LABELS: Record<ChangedFileSort, string> = {
  changes: "Changes",
  path: "Path",
  status: "Status",
};

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "gap";
  /** Old-file line number, when the host's gutter carried it. Never inferred. */
  oldLine: number | null;
  /** New-file line number, when the host's gutter carried it. Never inferred. */
  newLine: number | null;
  text: string;
}

export interface Hunk {
  /** The host's own `@@` header, or a synthesized one from recoverable numbers. */
  header: string;
  lines: DiffLine[];
}

/** One edit event observed for one path. */
interface Observation {
  status: FileChangeStatus;
  additions: number | null;
  deletions: number | null;
  diff: string | null;
  moveFrom: string | null;
  failed: boolean;
  truncated: boolean;
  errorText: string | null;
  raw: unknown;
}

/**
 * The host's error text for one entry.
 *
 * OMP names it `error` (`EditToolResult.error`) — a real failed edit carries
 * `{diff, errorKind, error}` and nothing else, so reading only the older
 * `displayErrorText`/`errorText` display fields renders a failure with no reason
 * at all. `errorKind` is the host's classification of the same failure and is
 * therefore the last resort, never a substitute for a message.
 */
function errorTextOf(entry: Record<string, unknown>): string | null {
  return str(entry.error) ?? str(entry.displayErrorText) ?? str(entry.errorText) ?? str(entry.errorKind);
}

/** The per-file entries of one result, in the order the host sent them. */
function rawEntriesOf(details: Record<string, unknown>): Record<string, unknown>[] {
  const perFile = details.perFileResults;
  if (Array.isArray(perFile) && perFile.length > 0) return perFile.filter(isRecord);
  return [details];
}

function truncatedFrom(entry: Record<string, unknown>): boolean {
  if (entry.truncated === true) return true;
  return isRecord(entry.meta) && isRecord(entry.meta.truncation);
}

/**
 * Every edit event one row observed, paired with the path it belongs to.
 *
 * A failed edit is the reason this takes the caller's paired arguments at all:
 * OMP's failure details carry NO `path` (measured over 21,789 edit results — a
 * `file_not_found`/`no_match`/`no_change` failure is `{diff: "", errorKind}` and
 * nothing else, and a validation failure is `{isError, error}`). The file it
 * touched is named only in the call's arguments, so that is where the path comes
 * from — and when neither has one, the event is dropped rather than filed under a
 * path nobody stated.
 */
function observationsOf(row: ToolActivityRow, pairedArgs: ReadonlyMap<string, Record<string, unknown>>): Array<{ path: string; observation: Observation }> {
  const details = row.toolResult?.details;
  if (!isRecord(details)) return [];
  const argumentPath = (): string | null => {
    const args = row.toolArgs ?? (row.toolCallId === undefined ? undefined : pairedArgs.get(row.toolCallId));
    return args === undefined ? null : str(args.path) ?? str(args.file_path);
  };
  const changes = fileChangesOf(row);
  if (changes.length === 0) {
    // `fileChangesOf` deliberately drops a failed row with no per-file results: for
    // the transcript, that row's own error is the whole truth and nothing was
    // applied. The Files Center still has to list the event — a failed edit is an
    // edit this session observed — so it appears with its real error text, status
    // `unknown` (nothing was applied, so the op name would be a claim about the
    // file we cannot make) and no counts.
    const failed = row.isError === true || row.toolResult?.isError === true;
    if (!failed) return [];
    const path = str(details.path) ?? str(details.filePath) ?? argumentPath();
    if (path === null) return [];
    return [
      {
        path,
        observation: {
          status: "unknown",
          additions: null,
          deletions: null,
          diff: null,
          moveFrom: null,
          failed: true,
          truncated: truncatedFrom(details),
          errorText: errorTextOf(details),
          raw: details,
        },
      },
    ];
  }
  const raw = rawEntriesOf(details);
  return changes.map((change) => {
    const entry = raw.find((candidate) => (str(candidate.path) ?? str(candidate.filePath)) === change.path) ?? details;
    return {
      path: change.path,
      observation: {
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        diff: change.diff,
        moveFrom: change.moveFrom ?? null,
        failed: change.failed === true,
        truncated: change.truncated === true,
        errorText: errorTextOf(entry),
        raw: entry,
      },
    };
  });
}

function splitPath(path: string): { shortName: string; directory: string } {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return { shortName: path, directory: "" };
  return { shortName: path.slice(cut + 1), directory: path.slice(0, cut) };
}

/** The last observation satisfying a predicate, or `undefined`. */
function lastWhere<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (predicate(item)) return item;
  }
  return undefined;
}

/**
 * Fold one path's events into its entry.
 *
 * A move wins the status outright: a rename is an identity event, so a later
 * `update` on the destination does not undo it. Everything else reports the LAST
 * observation's status, because that is the most recent thing the host said about
 * the path.
 */
function aggregate(path: string, observations: readonly Observation[]): ChangedFile {
  const last = observations[observations.length - 1]!;
  const moved = lastWhere(observations, (item) => item.moveFrom !== null);
  const counted = observations.every((item) => item.additions !== null && item.deletions !== null);
  const errored = lastWhere(observations, (item) => item.errorText !== null);
  const diffed = lastWhere(observations, (item) => item.diff !== null);
  const { shortName, directory } = splitPath(path);
  return {
    path,
    shortName,
    directory,
    status: moved === undefined ? last.status : "renamed",
    edits: observations.length,
    appliedEdits: observations.filter((item) => !item.failed).length,
    observedAdditions: counted ? observations.reduce((sum, item) => sum + (item.additions ?? 0), 0) : null,
    observedDeletions: counted ? observations.reduce((sum, item) => sum + (item.deletions ?? 0), 0) : null,
    failed: observations.some((item) => item.failed),
    truncated: observations.some((item) => item.truncated),
    errorText: errored?.errorText ?? null,
    lastDiff: diffed?.diff ?? null,
    moveFrom: moved?.moveFrom ?? null,
    rawDetails: last.raw ?? null,
  };
}

/**
 * One entry per distinct path, in first-seen order.
 *
 * First-seen order is the transcript's own order: a list that reordered itself as
 * edits arrived would move rows under the user's thumb.
 *
 * `pairedArgs` is the caller's `pairToolArguments(rows)` map, needed only so a
 * failed edit — whose details carry no path (see `observationsOf`) — can be listed
 * under the file its call named. Without it a failure with no details path is
 * omitted rather than guessed at.
 */
export function collectChangedFiles(
  rows: readonly ToolActivityRow[],
  pairedArgs: ReadonlyMap<string, Record<string, unknown>> = new Map(),
): ChangedFile[] {
  const order: string[] = [];
  const byPath = new Map<string, Observation[]>();
  for (const row of rows) {
    for (const { path, observation } of observationsOf(row, pairedArgs)) {
      const existing = byPath.get(path);
      if (existing === undefined) {
        byPath.set(path, [observation]);
        order.push(path);
      } else existing.push(observation);
    }
  }
  return order.map((path) => aggregate(path, byPath.get(path)!));
}

/**
 * Per-status counts, plus the two totals.
 *
 * `observedAdditions`/`observedDeletions` are `null` unless every *applied* file
 * has known counts — the same rule `summarizeFileChanges` applies, kept identical
 * on purpose: a failed file has no counts by definition, so its presence must not
 * turn a complete sum into a permanent "unavailable".
 *
 * `appliedFiles` is the other half of that agreement: the status counts include
 * every entry (a failed edit is a real event worth showing), but the number a
 * screen prints as "how many files changed" is `appliedFiles`, which is what
 * `summarizeFileChanges(...).uniqueFiles` computes over the same rows.
 */
export function summarizeChangedFiles(files: readonly ChangedFile[]): ChangedFilesSummary {
  const statusCount = (status: FileChangeStatus): number => files.filter((file) => file.status === status).length;
  const applied = files.filter((file) => !file.failed);
  const complete = applied.length > 0 && applied.every((file) => file.observedAdditions !== null && file.observedDeletions !== null);
  return {
    total: files.length,
    appliedFiles: files.filter((file) => file.appliedEdits > 0).length,
    modified: statusCount("modified"),
    added: statusCount("added"),
    deleted: statusCount("deleted"),
    renamed: statusCount("renamed"),
    binary: statusCount("binary"),
    unknown: statusCount("unknown"),
    failed: files.filter((file) => file.failed).length,
    observedAdditions: complete ? applied.reduce((sum, file) => sum + (file.observedAdditions ?? 0), 0) : null,
    observedDeletions: complete ? applied.reduce((sum, file) => sum + (file.observedDeletions ?? 0), 0) : null,
    truncated: files.some((file) => file.truncated),
  };
}

/** The status word a screen reader gets, and the empty-state text uses. */
export const CHANGED_FILE_STATUS_LABELS: Record<FileChangeStatus, string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  binary: "binary",
  unknown: "unverified",
};

/**
 * The `+/−` text for one entry, or the reason there is none.
 *
 * A failed file is `not applied` — it changed nothing, so a count would be a
 * claim about the file rather than about the failure. An entry whose counts are
 * missing says so rather than printing a partial sum.
 */
export function changedFileCountsText(file: ChangedFile): string {
  if (file.failed) return "not applied";
  if (file.observedAdditions === null || file.observedDeletions === null) return "counts unavailable";
  return `+${file.observedAdditions} −${file.observedDeletions}`;
}

export function filterChangedFiles(files: readonly ChangedFile[], filter: ChangedFileFilter): ChangedFile[] {
  const query = (filter.query ?? "").trim().toLowerCase();
  const status = filter.status ?? "all";
  return files.filter(
    (file) => (status === "all" || file.status === status) && (query === "" || file.path.toLowerCase().includes(query)),
  );
}

const STATUS_ORDER: Record<FileChangeStatus, number> = {
  modified: 0,
  added: 1,
  deleted: 2,
  renamed: 3,
  binary: 4,
  unknown: 5,
};

function byPath(a: ChangedFile, b: ChangedFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * The documented orderings. Every one ends in a path comparison, so the order is
 * total and stable no matter what the input order was.
 *
 * - `changes`: observed additions desc, then observed deletions desc, then path.
 *   A file whose counts the host never proved sorts last (`-1`), below a real
 *   zero, rather than being presented as "no changes".
 * - `path`: full path ascending.
 * - `status`: the fixed status order above (modified, added, deleted, renamed,
 *   binary, unknown), then path.
 */
export function sortChangedFiles(files: readonly ChangedFile[], key: ChangedFileSort): ChangedFile[] {
  const sorted = [...files];
  switch (key) {
    case "path":
      return sorted.sort(byPath);
    case "status":
      return sorted.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || byPath(a, b));
    case "changes":
      return sorted.sort(
        (a, b) =>
          (b.observedAdditions ?? -1) - (a.observedAdditions ?? -1) ||
          (b.observedDeletions ?? -1) - (a.observedDeletions ?? -1) ||
          byPath(a, b),
      );
  }
}

/** ` 12|text` / `-7|text` / `+9|text` — the host's gutter. */
const GUTTER_RE = /^([ +-])(\d+)\|(.*)$/;

/** Separators between hunks — an empty line, or the host's `…` — carry no code. */
const GAP_LINES: Record<string, true> = { "": true, "…": true, "...": true };
/**
 * Parse the host's gutter-format diff into hunks.
 *
 * OMP does not send unified diffs: a line is ` 12|code`, `-7|old`, `+9|new`, and
 * collapsed unchanged context is a bare empty line. The two gutter numbers mean
 * different sides — a `+` line carries its NEW-file number, a ` `/`-` line its
 * OLD-file number — and a context line carries only the old side, so the other
 * gutter is left `null` rather than computed with an offset the host never sent.
 *
 * A gap is a separator, not content: it closes the hunk it follows (carried as
 * that hunk's final `gap` line) which is what makes hunk navigation mean
 * something. Malformed input is never an error — an unparseable line becomes a
 * context line with no numbers, and every line the input had is represented.
 */
export function parseGutterDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  const push = (line: DiffLine): void => {
    if (current === null) {
      current = { header: "", lines: [] };
      hunks.push(current);
    }
    current.lines.push(line);
  };
  const rawLines = diff.split("\n");
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]!;
    // CRLF: the `\r` is a line terminator, not part of the code on that line.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // The empty final segment is the terminator's artifact, not a gap.
    if (line === "" && index === rawLines.length - 1) continue;
    if (GAP_LINES[line.trim()] === true) {
      if (current !== null && current.lines.length > 0 && current.lines[current.lines.length - 1]!.kind !== "gap") {
        current.lines.push({ kind: "gap", oldLine: null, newLine: null, text: "" });
      }
      // A gap is where the host stopped showing unchanged lines, so it CLOSES the
      // hunk: without that, every hunk in a gutter diff would be one giant block
      // and "next hunk" would have nowhere to go.
      current = null;
      continue;
    }
    if (line.startsWith("@@")) {
      current = { header: line.trim(), lines: [] };
      hunks.push(current);
      continue;
    }
    // Unified file framing. A gutter line can never look like this (the character
    // after the marker would have to be a digit), so skipping is unambiguous.
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const matched = GUTTER_RE.exec(line);
    if (matched !== null) {
      const marker = matched[1]!;
      const number = Number(matched[2]);
      const text = matched[3]!;
      if (marker === "+") push({ kind: "add", oldLine: null, newLine: number, text });
      else if (marker === "-") push({ kind: "del", oldLine: number, newLine: null, text });
      else push({ kind: "ctx", oldLine: number, newLine: null, text });
      continue;
    }
    push({ kind: "ctx", oldLine: null, newLine: null, text: line });
  }
  return hunks.filter((hunk) => hunk.lines.length > 0);
}

/**
 * Unified headers for a whole diff, one per hunk, `""` where unverifiable.
 *
 * The new-side start is NOT the hunk's own old start. Gutter numbers on the old
 * side are ORIGINAL-file numbers, and every preceding hunk shifts the mapping by
 * its own `adds − dels`, so a later hunk's new start is `oldStart + accumulated
 * delta`. Measured on this machine's journals: of 18,306 real diffs 12,752 are
 * multi-hunk, and printing `+oldStart` is wrong for 28.9% of the synthesized
 * headers — a real case is hunk0 `-50,14 +50,11` (delta −3) followed by hunk1 at
 * old 116, whose true new start is 113. That is why this takes the whole diff
 * rather than one hunk: the delta a hunk needs is not visible inside it.
 *
 * The numbers are verified, never assumed. The walk checks EVERY line of the hunk
 * against the predicted positions on both sides, and a single disagreement yields
 * no header for that hunk — a wrong line number in a patch is worse than none.
 * The delta still advances by the hunk's structural counts when a header is
 * refused, because the counts come from the `+`/`-` markers, not from the
 * numbers that failed to verify.
 */
export function hunkHeadersOf(hunks: readonly Hunk[]): string[] {
  const headers: string[] = [];
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.header !== "") {
      // The host sent its own header: it is authoritative, and the delta it
      // implies is derived from the same counts as below.
      headers.push(hunk.header);
    } else {
      const body = hunk.lines.filter((line) => line.kind !== "gap");
      const first = body.find((line) => line.oldLine !== null || line.newLine !== null);
      // A hunk that opens with insertions states no old-file position: an add's
      // gutter carries its NEW number, and there is nothing to derive the old one
      // from. Refuse rather than print a guess.
      if (first === undefined || first.kind === "add") {
        headers.push("");
      } else {
        const oldStart = first.oldLine ?? first.newLine!;
        const newStart = oldStart + delta;
        let old = oldStart;
        let next = newStart;
        let verified = true;
        for (const line of body) {
          if (line.kind === "ctx") {
            if (line.oldLine !== null && line.oldLine !== old) { verified = false; break; }
            if (line.newLine !== null && line.newLine !== next) { verified = false; break; }
            old++;
            next++;
          } else if (line.kind === "del") {
            if (line.oldLine !== null && line.oldLine !== old) { verified = false; break; }
            old++;
          } else {
            if (line.newLine !== null && line.newLine !== next) { verified = false; break; }
            next++;
          }
        }
        const oldCount = body.filter((line) => line.kind === "ctx" || line.kind === "del").length;
        const newCount = body.filter((line) => line.kind === "ctx" || line.kind === "add").length;
        headers.push(verified ? `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` : "");
      }
    }
    const body = hunk.lines.filter((line) => line.kind !== "gap");
    delta += body.filter((line) => line.kind === "add").length - body.filter((line) => line.kind === "del").length;
  }
  return headers;
}

/**
 * A copyable patch rebuilt from the last observed diff.
 *
 * The host's gutter form is not a patch, so the gutters are translated back to
 * `+`/`-`/` ` and the hunks re-anchored with `@@`. When a hunk's line numbers are
 * not recoverable the text says so instead of printing an invented header —
 * a wrong line number in a patch is worse than no patch.
 */
export function patchTextOf(file: ChangedFile): string {
  const head = `--- a/${file.path}\n+++ b/${file.path}`;
  if (file.lastDiff === null) return `${head}\n# The host sent no diff for this path, so there is nothing to copy.`;
  const hunks = parseGutterDiff(file.lastDiff);
  const headers = hunkHeadersOf(hunks);
  const bodies: string[] = [];
  let recoverable = true;
  hunks.forEach((hunk, index) => {
    const header = headers[index] ?? "";
    if (header === "") recoverable = false;
    const body = hunk.lines
      .filter((line) => line.kind !== "gap")
      .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`);
    bodies.push([...(header === "" ? [] : [header]), ...body].join("\n"));
  });
  const note = recoverable
    ? []
    : ["# At least one hunk carries no recoverable line numbers, so no @@ header is printed for it."];
  return [...note, head, ...bodies].join("\n");
}
