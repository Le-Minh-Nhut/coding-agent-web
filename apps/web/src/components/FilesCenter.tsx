/**
 * Files Center — the level-2 full-screen list of every path this conversation's
 * transcript recorded an edit for.
 *
 * The one claim this screen makes is stated on it, not implied: these are edit
 * events observed in the transcript, not the workspace. There is no git on this
 * transport, so a "modified" row means "the host reported an edit to this path",
 * and the window note carried in from the caller says how far back that log
 * reaches. The list never renders a row's aggregate as a net diff — the counts
 * are labelled `observed` wherever they appear.
 */
import { useMemo, useState, type ReactNode } from "react";
import { STATUS_LETTER } from "../tool-activity.js";
import {
  changedFileCountsText,
  CHANGED_FILE_SORTS,
  CHANGED_FILE_SORT_LABELS,
  CHANGED_FILE_STATUS_LABELS,
  filterChangedFiles,
  sortChangedFiles,
  type ChangedFile,
  type ChangedFileSort,
  type ChangedFilesSummary,
} from "../files.js";
import type { FileChangeStatus } from "../tool-activity.js";
import { FileDiffView } from "./FileDiffView.js";
import "../files.css";

export interface FilesCenterProps {
  files: readonly ChangedFile[];
  summary: ChangedFilesSummary;
  /** Provenance sentence from the caller, naming the loaded window. */
  windowNote: string;
  onOpenFile: (path: string) => void;
  onBack: () => void;
  /** When set, the diff for this path is shown instead of the list. */
  openPath?: string | null;
}

type Filter = "all" | FileChangeStatus;

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "modified", label: "Modified" },
  { id: "added", label: "Added" },
  { id: "deleted", label: "Deleted" },
];

export function FilesCenter({ files, summary, windowNote, onOpenFile, onBack, openPath = null }: FilesCenterProps): ReactNode {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ChangedFileSort>("changes");
  // `""` is the callers' "back to the list" signal (the diff's Back button sends
  // it), so it must never be mistaken for a path.
  const wanted = openPath === "" ? null : openPath;

  const shown = useMemo(
    () => sortChangedFiles(filterChangedFiles(files, { query, status: filter }), sort),
    [files, query, filter, sort],
  );

  const open = wanted === null ? undefined : files.find((file) => file.path === wanted);
  if (wanted !== null && open !== undefined) {
    return (
      <div className="files-layer">
        <FileDiffView file={open} onBack={() => onOpenFile("")} />
      </div>
    );
  }

  // A path the list no longer holds (the transcript changed under us): say so and
  // fall back to the list rather than rendering a blank layer.
  const vanishedPath = wanted !== null && open === undefined ? wanted : null;

  const cycleSort = (): void => {
    const at = CHANGED_FILE_SORTS.indexOf(sort);
    setSort(CHANGED_FILE_SORTS[(at + 1) % CHANGED_FILE_SORTS.length]!);
  };

  return (
    // A named region: this is a full screen of the app, and a container nobody can
    // reach by name is not reachable at all.
    <div className="files-layer">
      <section className="files-center" role="region" aria-labelledby="files-center-title">
        <div className="files-head">
          <button type="button" className="files-back" onClick={onBack} aria-label="Back">←</button>
          <div className="files-head-titles">
            <h2 id="files-center-title">Changed Files</h2>
            {/* The number here is the APPLIED file count, the same one the
                dashboard card prints: a failed edit changed nothing, so counting it
                as a changed file is how the two screens came to disagree. Rows for
                failures are still listed and say "not counted". */}
            <p className="files-count">
              {`${summary.appliedFiles} file${summary.appliedFiles === 1 ? "" : "s"} changed`}
              {summary.total > summary.appliedFiles ? ` · ${summary.total - summary.appliedFiles} failed row${summary.total - summary.appliedFiles === 1 ? "" : "s"} not counted` : ""}
            </p>
          </div>
        </div>

        <p className="files-window-note">{windowNote}</p>

        {vanishedPath !== null && (
          <p className="files-note" role="status">{`${vanishedPath} is no longer in this conversation's change list.`}</p>
        )}

        <div className="files-chips" role="group" aria-label="Filter files">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className="files-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="files-toolbar">
          <input
            type="search"
            className="files-search"
            aria-label="Search files"
            placeholder="Filter by path"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button
            type="button"
            className="files-toggle"
            aria-label={`Sort by ${CHANGED_FILE_SORT_LABELS[sort]} — change sort order`}
            onClick={cycleSort}
          >
            {`Sort: ${CHANGED_FILE_SORT_LABELS[sort]}`}
          </button>
        </div>

        {files.length === 0 ? (
          <p className="files-empty" role="status">No edits have been observed in this conversation's transcript yet.</p>
        ) : shown.length === 0 ? (
          <p className="files-empty" role="status">
            {query.trim() === "" ? `No ${CHANGED_FILE_STATUS_LABELS[filter as FileChangeStatus]} files in this conversation.` : `No file path matches “${query.trim()}”.`}
          </p>
        ) : (
          <ul className="files-list">
            {shown.map((file) => (
              <li key={file.path}>
                <button type="button" className="files-row" onClick={() => onOpenFile(file.path)}>
                  <span className={`files-row-status files-status--${file.failed ? "failed" : file.status}`} aria-hidden="true">
                    {file.failed ? "✕" : STATUS_LETTER[file.status]}
                  </span>
                  <span className="files-row-titles">
                    <span className="files-row-name" title={file.path}>{file.shortName}</span>
                    {file.directory === "" ? null : <span className="files-row-dir">{file.directory}/</span>}
                  </span>
                  <span className="files-row-meta">
                    <span className="files-row-counts">{changedFileCountsText(file)}</span>
                    {file.edits > 1 && <span className="files-row-edits">{`edits ×${file.edits}`}</span>}
                    {file.failed && <span className="files-row-flag files-row-flag--failed" title="The host reported this edit failed, so it changed nothing and is not counted as a changed file">failed — not counted</span>}
                    {file.truncated && <span className="files-row-flag files-row-flag--truncated" title="The host truncated this diff">truncated</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
