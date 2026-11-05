/**
 * Tool activity UI: the per-turn category summary and the expanded tool card.
 *
 * The card body is the vendored guest renderer (`packages/guest/src/tool-render/`)
 * reached through exactly one seam (`src/guest-tools.ts`) — this file owns no
 * diff parser, no `+/−` counter, and no second styling system. What it does own
 * is the *chrome*, because the guest's own chrome (`ToolView.tsx:82`) is welded
 * to its monolithic registry: `ToolView` imports `./registry`, which reaches
 * `tools/eval.tsx` and `tools/web-search.tsx` → `components/transcript/Markdown.tsx`
 * → katex. Measured, importing `ToolView` costs 712 kB raw / 156 kB gz against
 * 101 kB / 21 kB for the curated renderer set, and `apps/web` does not depend on
 * katex at all. So the collapse/expand shell is ~50 lines here; everything
 * substantive inside it is the guest's.
 *
 * Collapsed cards mount no body at all — the long-transcript win measured at
 * 254,197 → 308 DOM chars stays intact.
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

/** Per-file change rows: the compact list the guest renderer has no equivalent for at this level. */
function FileChangeList({ files }: { files: FileChange[] }) {
  return (
    <ul className="tv-file-changes">
      {files.map((file, index) => (
        <li key={`${file.path}:${index}`} className="tv-file-change">
          <span className={`tv-file-status tv-file-status--${file.status}`} aria-hidden="true">{STATUS_LETTER[file.status]}</span>
          <span className="tv-file-path"><PathText path={file.path} /></span>
          {file.moveFrom === undefined ? null : <span className="tv-file-from">← {file.moveFrom}</span>}
          {file.additions === null || file.deletions === null ? (
            <span className="tv-file-counts tv-file-counts--unknown">counts unavailable</span>
          ) : (
            <span className="tv-file-counts">
              <span className="tv-count-add">+{file.additions}</span>{" "}
              <span className="tv-count-del">−{file.deletions}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Expanded body.
 *
 * Order matters. Verified change data first (real diffs), then the guest
 * renderer's view. When the transport carried no structured result there is
 * nothing verified to render, so the raw text is shown in full — that is the
 * "View tool details" path, and it is first-class rather than a footnote,
 * because a row we cannot interpret must not look like an empty success.
 */
function ToolBody({ row, pairedArgs }: { row: ToolActivityRow; pairedArgs: Map<string, Record<string, unknown>> }) {
  const [showRaw, setShowRaw] = useState(false);
  const result = guestResultOf(row);
  const changes = fileChangesOf(row);
  const renderer = row.toolName === undefined ? undefined : resolveGuestRenderer(row.toolName);
  const args = argumentsFor(row, pairedArgs);
  const structured = result !== undefined;

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
          </div>
          <FileChangeList files={changes} />
          {changes.every((file) => file.diff === null) && (
            <p className="tool-body-note">
              File operation completed · Diff unavailable — the host sent no diff for this
              operation, so no added/removed counts are shown. Use “View tool details” for the raw
              result.
            </p>
          )}
          {/* The diff text itself, in full, when the host carried one: this is the
              "open the diff" step of the drill-down, not a second parser. */}
          {changes.map((file, index) => file.diff === null ? null : (
            <div key={`diff:${file.path}:${index}`} className="tool-diff-block">
              <div className="tool-diff-head">
                <PathText path={file.path} />
                <button type="button" className="ghost" onClick={() => copyText(file.diff ?? "")}>Copy patch</button>
              </div>
              <DiffBlock diff={file.diff} maxLines={200} />
            </div>
          ))}
        </div>
      )}

      {structured && renderer?.Body !== undefined && (
        <div className="tool-body-section">
          <renderer.Body name={row.toolName ?? "tool"} args={args} result={result} running={row.isRunning} />
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
          <pre className="tool-raw-output"><code>{row.text}</code></pre>
          <button type="button" className="ghost" onClick={() => copyText(row.text)}>Copy output</button>
        </div>
      ) : (
        <div className="tool-body-section">
          <button type="button" className="ghost" onClick={() => setShowRaw((value) => !value)}>
            {showRaw ? "Hide tool details" : "View tool details"}
          </button>
          {showRaw && (
            <>
              <pre className="tool-raw-output"><code>{row.text}</code></pre>
              <button type="button" className="ghost" onClick={() => copyText(row.text)}>Copy output</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One tool card. Collapsed by default; the header is the summary line, so the
 * transcript reads as `✓ Read 8 files` until the user drills in.
 */
export const ToolRow = memo(function ToolRow({ row, pairedArgs }: { row: ToolActivityRow; pairedArgs: Map<string, Record<string, unknown>> }) {
  const [open, setOpen] = useState(false);
  const result = guestResultOf(row);
  const renderer = row.toolName === undefined ? undefined : resolveGuestRenderer(row.toolName);
  const args = argumentsFor(row, pairedArgs);
  const changes = fileChangesOf(row);
  const counts = changes.length === 0 ? null : {
    additions: changes.every((file) => file.additions !== null) ? changes.reduce((sum, file) => sum + (file.additions ?? 0), 0) : null,
    deletions: changes.every((file) => file.deletions !== null) ? changes.reduce((sum, file) => sum + (file.deletions ?? 0), 0) : null,
  };

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
              `edit` renderer and this row now call the same shared `diffStats`
              (`packages/guest/src/tool-render/util.ts`), so their numbers cannot
              disagree — but the guest `Summary` also prints the path and the
              counts, so calling it on a row whose counts we already print would
              render the same summary twice. Where there are verified changes this
              row prints the path and the counts; the guest Summary is used only
              when there is nothing verified to count. */}
          {renderer === undefined ? (
            <span className="tool-row-note">unknown tool</span>
          ) : changes.length > 0 ? (
            <>
              <PathText path={changes[0]!.path} />
              {changes.length > 1 && <span className="tool-row-note"> +{changes.length - 1} more</span>}
            </>
          ) : (
            <renderer.Summary name={row.toolName ?? "tool"} args={args} result={result} running={row.isRunning} />
          )}
          {counts !== null && counts.additions !== null && counts.deletions !== null && (
            <>
              {" "}
              <Badges items={[
                counts.additions > 0 ? <span key="a" className="tv-count-add">+{counts.additions}</span> : null,
                counts.deletions > 0 ? <span key="d" className="tv-count-del">−{counts.deletions}</span> : null,
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
      {open && <ToolBody row={row} pairedArgs={pairedArgs} />}
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
export const ActivityGroupRow = memo(function ActivityGroupRow({ group, pairedArgs }: { group: ActivityGroup; pairedArgs: Map<string, Record<string, unknown>> }) {
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
          {group.rows.map((row) => <ToolRow key={row.id} row={row} pairedArgs={pairedArgs} />)}
        </div>
      )}
    </div>
  );
});


