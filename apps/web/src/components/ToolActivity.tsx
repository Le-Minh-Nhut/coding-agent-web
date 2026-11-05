/**
 * Tool activity UI: the per-turn category summary and the expanded tool card.
 *
 * Two levels of disclosure, and the split is deliberate. A collapsed card states
 * only what the transport proved (state glyph, tool name, verified effect);
 * opening it mounts the body. An `edit` row's body is FLAT — one line per file,
 * no nested card and no second copy of the diff inside the conversation, because
 * the diff belongs to the dedicated viewer the file row opens. Every other tool
 * keeps its guest body. The raw transport record is never dropped: it is one
 * disclosure further down, and for a tool with no dedicated renderer it *is* the
 * body.
 */
import { memo, useState } from "react";
import { Badges, DiffBlock, PathText } from "../guest-tools.js";
import { hasGuestRenderer, resolveGuestRenderer } from "../guest-tools.js";
import {
  argumentsFor,
  categoryLabel,
  fileChangesOf,
  guestResultOf,
  stateGlyph,
  STATUS_LETTER,
  summarizeFileChanges,
  toolResultError,
  type ActivityGroup,
  type FileChange,
} from "../tool-activity.js";
import type { ToolActivityRow } from "../tool-activity.js";

/** One-line state suffix; never asserts a verified outcome it does not have. */
function stateSuffix(row: ToolActivityRow): string {
  if (row.isRunning) return "◌ Running…";
  if (row.isError) return "✕ failed — View output";
  return "✓ completed";
}

function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {
    /* Clipboard permission is optional; the text stays selectable. */
  });
}

/**
 * The raw wire record: the transport text and the arguments the call carried.
 *
 * Present behind its own control whenever a structured result exists (so an
 * interpreted row is still inspectable), and shown directly when it is all there
 * is. Nothing here is summarized or trimmed — this is the "nothing was dropped"
 * end of the drill-down.
 */
function RawRecord({ row, pairedArgs }: { row: ToolActivityRow; pairedArgs: Map<string, Record<string, unknown>> }) {
  const args = argumentsFor(row, pairedArgs);
  const hasArgs = Object.keys(args).length > 0;
  return (
    <>
      {hasArgs && (
        <pre className="tool-args-json"><code>{JSON.stringify(args, null, 2)}</code></pre>
      )}
      <pre className="tool-raw-output"><code>{row.text}</code></pre>
      <button type="button" className="ghost" onClick={() => copyText(row.text)}>Copy output</button>
    </>
  );
}

/**
 * A file's `+/−`, or why it has none.
 *
 * Shared by both file-row shapes (`edit`'s flat row and the accordion every other
 * change-bearing tool keeps) because the claim it makes — a failed file was not
 * applied, a truncated diff's counts are a floor, a diff-less row has no counts —
 * must be identical in both.
 */
function FileCounts({ file }: { file: FileChange }) {
  if (file.failed === true) return <span className="tv-file-counts tv-file-counts--unknown">not applied</span>;
  if (file.truncated === true) return <span className="tv-file-counts tv-file-counts--unknown">counts partial</span>;
  if (file.additions === null || file.deletions === null) {
    return <span className="tv-file-counts tv-file-counts--unknown">counts unavailable</span>;
  }
  return (
    <span className="tv-file-counts">
      <span className="tv-count-add">+{file.additions}</span>{" "}
      <span className="tv-count-del">−{file.deletions}</span>
    </span>
  );
}

/**
 * One file-change row: filename, status, `+/−`, and its own disclosure.
 *
 * Level one is a single line. Opening it mounts that file's diff, its host
 * diagnostics, and — for a failed file — the host's error instead of a diff.
 * Nothing here renders another file's diff: a multi-file edit is an accordion,
 * not a wall. This shape serves tools with no dedicated viewer; `edit` uses the
 * flat `EditFileRow` instead.
 */
function FileChangeRow({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(false);
  const diag = file.diagnostics;
  const expandable = file.diff !== null || file.error !== undefined || file.truncated === true || diag !== undefined;
  return (
    <li className={`tv-file-change${file.failed === true ? " tv-file-change--failed" : ""}`}>
      <button
        type="button"
        className="tv-file-change-head"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={`tv-file-status tv-file-status--${file.failed === true ? "failed" : file.status}`} aria-hidden="true">
          {file.failed === true ? "✕" : STATUS_LETTER[file.status]}
        </span>
        <span className="tv-file-path">
          {/* A rename reads source → destination. `move` alone is the destination,
              so the source is what must lead the arrow. */}
          {file.moveFrom === undefined ? null : <><PathText path={file.moveFrom} /> → </>}
          <PathText path={file.path} />
        </span>
        <FileCounts file={file} />
        {expandable && <span className="tv-file-chevron" aria-hidden="true">{open ? "▾" : "›"}</span>}
      </button>
      {open && (
        <div className="tv-file-change-body">
          {file.failed === true ? (
            file.error === undefined ? null : <pre className="tv-file-error"><code>{file.error}</code></pre>
          ) : file.diff === null || file.diff.length === 0 ? null : (
            <>
              <div className="tool-diff-head">
                <PathText path={file.path} />
                <button type="button" className="ghost" onClick={() => copyText(file.diff ?? "")}>Copy patch</button>
              </div>
              <DiffBlock diff={file.diff} maxLines={200} />
            </>
          )}
          {/* Diagnostics are not a diff concern and survive whether or not one was
              drawn: the host's own LSP verdict on this file, shown verbatim. */}
          {diag?.summary != null && (
            <p className={`tv-note${diag.errored ? " tv-note--err" : ""}`}>{diag.summary}</p>
          )}
          {diag !== undefined && diag.messages.length > 0 && (
            <pre className={`tv-file-error${diag.errored ? " tv-file-error--err" : ""}`}><code>{diag.messages.join("\n")}</code></pre>
          )}
        </div>
      )}
    </li>
  );
}

/** Per-file change rows: the compact list the guest renderer has no equivalent for at this level. */
function FileChangeList({ files }: { files: FileChange[] }) {
  return (
    <ul className="tv-file-changes">
      {files.map((file, index) => (
        <FileChangeRow key={`${file.path}:${index}`} file={file} />
      ))}
    </ul>
  );
}

/**
 * One file of a flattened edit: the whole row is one button.
 *
 * Primary label is the short name, secondary is the directory with the filename
 * stripped and ellipsised from the left, so an absolute path is never printed
 * twice and the part that distinguishes two files is the part that survives. It
 * opens the dedicated diff viewer; this list never draws the diff itself.
 */
function EditFileRow({ file, onOpenFile }: { file: FileChange; onOpenFile: (path: string) => void }) {
  const cut = file.path.lastIndexOf("/");
  const name = cut < 0 ? file.path : file.path.slice(cut + 1);
  // A rename leads with the source's *name*, not its path: the destination is
  // this row's primary label, and repeating a shared directory twice is noise.
  const fromCut = file.moveFrom === undefined ? -1 : file.moveFrom.lastIndexOf("/");
  const fromName = file.moveFrom === undefined ? null : fromCut < 0 ? file.moveFrom : file.moveFrom.slice(fromCut + 1);
  const fromDir = fromCut < 0 ? "" : file.moveFrom!.slice(0, fromCut);
  const dir = cut < 0 ? "" : file.path.slice(0, cut);
  // Both directories, but only when the move actually crossed one: an identical
  // `src → src` would be a line of pure noise, and dropping the source directory
  // would hide where the file came from.
  const dirLine = fromName !== null && fromDir !== dir ? `${fromDir} → ${dir}` : dir;
  const diag = file.diagnostics;
  return (
    <li className={`tv-file-change${file.failed === true ? " tv-file-change--failed" : ""}`}>
      <button type="button" className="tv-file-change-head" onClick={() => onOpenFile(file.path)}>
        <span className={`tv-file-status tv-file-status--${file.failed === true ? "failed" : file.status}`} aria-hidden="true">
          {file.failed === true ? "✕" : STATUS_LETTER[file.status]}
        </span>
        <span className="tv-file-titles">
          <span className="tv-file-name">
            {fromName === null ? null : <>{fromName} → </>}
            {name}
          </span>
          <span className="tv-file-dir">{dirLine}</span>
        </span>
        <FileCounts file={file} />
      </button>
      {/* The host's LSP verdict is not diff content, and flattening the list must
          not drop it: a type error next to the change that caused it is the one
          part of an edit result a diff cannot show. Plain text, no second
          disclosure — the row stays one level. */}
      {diag?.summary != null && (
        <p className={`tv-note${diag.errored ? " tv-note--err" : ""}`}>{diag.summary}</p>
      )}
      {diag !== undefined && diag.messages.length > 0 && (
        <pre className={`tv-file-error${diag.errored ? " tv-file-error--err" : ""}`}><code>{diag.messages.join("\n")}</code></pre>
      )}
    </li>
  );
}

/**
 * The edit body: a flat list of file rows, the failure reason, then the raw
 * record behind one disclosure.
 *
 * There is deliberately no second level here. The diff is the dedicated viewer's
 * job (`onOpenFile`), so this body never mounts a `DiffBlock` — an edit expanded
 * in the conversation is a list of what changed, not a wall of patch.
 */
function EditBody({ row, changes, pairedArgs, onOpenFile }: {
  row: ToolActivityRow;
  changes: readonly FileChange[];
  pairedArgs: Map<string, Record<string, unknown>>;
  onOpenFile: (path: string) => void;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  // Every reason the host gave, not just the first: a partial multi-file edit can
  // fail several files for different causes, and showing one would silently drop
  // the others. The call-level reason leads; each failed file follows, labelled by
  // the path it belongs to.
  const callError = toolResultError(row);
  const fileErrors = changes
    .filter((file) => file.failed === true && file.error !== undefined)
    .map((file) => `${file.path}: ${file.error}`);
  const reasons = [
    ...(callError === null ? [] : [callError]),
    ...fileErrors,
  ];
  return (
    <div className="tool-body">
      {reasons.length === 0 ? null : (
        <div className="tool-body-error" role="alert">
          {reasons.map((reason, index) => <p key={index}>{reason}</p>)}
        </div>
      )}
      {changes.length > 0 && (
        <ul className="tv-file-changes">
          {changes.map((file, index) => (
            <EditFileRow key={`${file.path}:${index}`} file={file} onOpenFile={onOpenFile} />
          ))}
        </ul>
      )}
      {changes.length > 0 && changes.every((file) => file.diff === null && file.failed !== true) && (
        <p className="tool-body-note">
          The host sent no diff for this operation, so no added/removed counts are shown.
        </p>
      )}
      {/* A `<details>` so the payload is one tap away, with its content mounted
          only once opened: an always-mounted record would put every edit's full
          transport text in the DOM of an expanded row. */}
      <details className="tool-raw-details" onToggle={(event) => setRawOpen(event.currentTarget.open)}>
        <summary>View technical details</summary>
        {rawOpen && <RawRecord row={row} pairedArgs={pairedArgs} />}
      </details>
    </div>
  );
}

/**
 * Expanded body for every tool that is not `edit`.
 *
 * Order matters. Verified change data first (real diffs, one per file), then the
 * guest renderer's view. The guest `edit` body re-reads the same `details` we
 * just listed, so when this row has already rendered every per-file diff the
 * guest body is not mounted a second time — the diagnostics and raw record it
 * would have added are rendered here instead. With no structured result there is
 * nothing verified to render, so the raw text is shown in full: that is the
 * "View tool details" path, and it is first-class rather than a footnote, because
 * a row we cannot interpret must not look like an empty success.
 */
function ToolBody({ row, pairedArgs }: { row: ToolActivityRow; pairedArgs: Map<string, Record<string, unknown>> }) {
  const [showRaw, setShowRaw] = useState(false);
  const result = guestResultOf(row);
  const changes = fileChangesOf(row);
  const renderer = row.toolName === undefined ? undefined : resolveGuestRenderer(row.toolName);
  const args = argumentsFor(row, pairedArgs);
  const structured = result !== undefined;
  // The guest body would render the same per-file diffs this body already
  // rendered from the same `details`, so for a change-bearing row it is skipped
  // rather than duplicated. Bound to a local so the narrowing survives.
  const GuestBody = changes.some((file) => file.diff !== null) ? undefined : renderer?.Body;
  const showGuestBody = structured && GuestBody !== undefined;

  return (
    <div className="tool-body">
      {changes.length > 0 && (
        <div className="tool-body-section">
          {/* Provenance: a file row with a real diff is verified change data for
              this tool call. A row without one only proves the operation was
              attempted, so the list is labelled as workspace state rather than
              as changes this agent made. */}
          <div className="tool-body-heading">
            {changes.some((file) => file.diff !== null) ? "Changes" : "Workspace changes"}
            {changes.some((file) => file.truncated === true) ? " · statistics partial" : ""}
            {changes.some((file) => file.failed === true) ? " · some files failed" : ""}
          </div>
          <FileChangeList files={changes} />
          {changes.every((file) => file.diff === null && file.failed !== true) && (
            <p className="tool-body-note">
              File operation completed · Diff unavailable — the host sent no diff for this
              operation, so no added/removed counts are shown. Use “View tool details” for the raw
              result.
            </p>
          )}
        </div>
      )}

      {showGuestBody && (
        <div className="tool-body-section">
          <GuestBody name={row.toolName ?? "tool"} args={args} result={result} running={row.isRunning} />
          {row.toolName === undefined || !hasGuestRenderer(row.toolName) ? (
            <p className="tool-body-note">
              No dedicated view for <code>{row.toolName ?? "this tool"}</code>; showing the raw result.
            </p>
          ) : null}
        </div>
      )}

      {/* Full raw transport text. Present whenever there is no structured result
          to render instead, and available behind one tap otherwise. */}
      {!structured ? (
        <div className="tool-body-section">
          <RawRecord row={row} pairedArgs={pairedArgs} />
        </div>
      ) : (
        <div className="tool-body-section">
          <button type="button" className="ghost" onClick={() => setShowRaw((value) => !value)}>
            {showRaw ? "Hide tool details" : "View tool details"}
          </button>
          {showRaw && <RawRecord row={row} pairedArgs={pairedArgs} />}
        </div>
      )}
    </div>
  );
}

/** Default for hosts that have not wired a viewer: the row still renders, and the
 * tap is a no-op rather than a throw. */
const noopOpenFile = (): void => undefined;

/**
 * One tool card. Collapsed by default; the header is the summary line, so the
 * transcript reads as `✓ Edited 1 file` until the user drills in.
 *
 * `onOpenFile` is the seam to the dedicated diff viewer: an `edit` row's body is
 * a flat list of files, each one a tap into that viewer, so the conversation
 * never mounts a patch.
 */
export const ToolRow = memo(function ToolRow({ row, pairedArgs, onOpenFile = noopOpenFile }: {
  row: ToolActivityRow;
  pairedArgs: Map<string, Record<string, unknown>>;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const result = guestResultOf(row);
  const renderer = row.toolName === undefined ? undefined : resolveGuestRenderer(row.toolName);
  const args = argumentsFor(row, pairedArgs);
  const changes = fileChangesOf(row);
  const isEdit = row.toolName === "edit";
  // One summary implementation for every change-bearing row, so a row and its
  // group can never disagree and "counts incomplete" means the same thing in both
  // — and `null` when any contributing file lacks counts, so the badges below
  // print no total rather than a partial one. Only the label differs.
  const summary = changes.length > 0 ? summarizeFileChanges([row]) : null;

  return (
    <div className={`tool-row${row.isError === true ? " tool-row--error" : ""}`}>
      <button
        type="button"
        className="tool-row-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="tool-row-state" aria-label={row.isRunning ? "running" : row.isError ? "failed" : "completed"}>
          {stateGlyph(row.isRunning ? "running" : row.isError ? "failed" : "completed")}
        </span>
        <span className="tool-row-name">{row.toolName ?? "tool"}</span>
        <span className="tool-row-sum">
          {/* One count implementation, one printed summary. Both the guest
              `edit` renderer and this row call the same shared `diffStats`
              (`packages/guest/src/tool-render/util.ts`), so their numbers cannot
              disagree. An edit row states its verified effect in files; every
              other row keeps the guest `Summary`, which is the honest view of a
              tool whose result this app only interprets generically. */}
          {isEdit && summary !== null ? (
            <span className="tool-row-note">
              {summary.uniqueFiles === 0 ? "No file changed" : `Edited ${summary.uniqueFiles} file${summary.uniqueFiles === 1 ? "" : "s"}`}
            </span>
          ) : renderer === undefined ? (
            <span className="tool-row-note">unknown tool</span>
          ) : changes.length > 0 ? (
            <>
              <PathText path={changes[0]!.path} />
              {changes.length > 1 && <span className="tool-row-note"> +{changes.length - 1} more</span>}
            </>
          ) : (
            <renderer.Summary name={row.toolName ?? "tool"} args={args} result={result} running={row.isRunning} />
          )}
          {summary !== null && summary.additions !== null && summary.deletions !== null && (
            <>
              {" "}
              <Badges items={[
                <span key="a" className="tv-count-add">+{summary.additions}</span>,
                <span key="d" className="tv-count-del">−{summary.deletions}</span>,
              ]} />
            </>
          )}
        </span>
        <span className="tool-row-status">{stateSuffix(row)}</span>
        <span className="tool-row-chevron" aria-hidden="true">{open ? "▾" : "›"}</span>
      </button>
      {/* A short preview while collapsed, exactly as the single-card view had:
          an error's first line must be legible without a tap. Only 240 characters
          are mounted, so the long-transcript win (254,197 → 308 DOM chars) holds. */}
      {!open && row.text.length > 0 && (
        <p className="tool-output-preview">{row.text.slice(0, 240)}{row.text.length > 240 ? "…" : ""}</p>
      )}
      {open && (isEdit
        ? <EditBody row={row} changes={changes} pairedArgs={pairedArgs} onOpenFile={onOpenFile} />
        : <ToolBody row={row} pairedArgs={pairedArgs} />)}
    </div>
  );
});

/**
 * A collapsed group: `✓ Read 8 files`, expanding to its member cards.
 *
 * Group state summarises member row states and never makes a separate success
 * claim: one running member makes the group `◌`, one failed member makes it `✕`.
 * A failing member's own text is surfaced under the head without a tap, because
 * an error the user cannot read is an error they will miss — the same guarantee
 * the single-card view gave with its always-visible preview.
 */
export const ActivityGroupRow = memo(function ActivityGroupRow({ group, pairedArgs, onOpenFile = noopOpenFile }: {
  group: ActivityGroup;
  pairedArgs: Map<string, Record<string, unknown>>;
  /**
   * Seam to the diff viewer, forwarded to each member `ToolRow`.
   *
   * A group's body is where most edit rows actually live (an edit joins an `edit`
   * group), so omitting this left every file row inside a group a dead button —
   * the group is the common path, not the exception.
   */
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const failed = group.state === "failed" ? group.rows.find((row) => row.isError === true) : undefined;
  // Only edit-shaped groups can carry file-change data, and only real diffs are
  // summed. A group whose diffs are missing keeps its plain label rather than
  // printing counts the transport never proved.
  const changes = group.category === "edit" || group.category === "patch" || group.category === "diff"
    ? summarizeFileChanges(group.rows)
    : null;
  return (
    <div className={`activity-group activity-group--${group.state}`}>
      <button type="button" className="activity-group-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="activity-group-state" aria-label={group.state}>{stateGlyph(group.state)}</span>
        <span className="activity-group-label">{categoryLabel(group.category, group.rows.length)}</span>
        {changes !== null && changes.note !== "" && (
          <span className="activity-group-note">{changes.note}</span>
        )}
        {changes !== null && changes.additions !== null && changes.deletions !== null && (
          <span className="activity-group-counts">
            <span className="tv-count-add">+{changes.additions}</span>{" "}
            <span className="tv-count-del">−{changes.deletions}</span>
          </span>
        )}
        <span className="activity-group-chevron" aria-hidden="true">{open ? "▾" : "›"}</span>
      </button>
      {!open && failed !== undefined && failed.text.length > 0 && (
        <p className="tool-output-preview">{failed.text.slice(0, 240)}{failed.text.length > 240 ? "…" : ""}</p>
      )}
      {open && (
        <div className="activity-group-body">
          {group.rows.map((row) => <ToolRow key={row.id} row={row} pairedArgs={pairedArgs} onOpenFile={onOpenFile} />)}
        </div>
      )}
    </div>
  );
});
