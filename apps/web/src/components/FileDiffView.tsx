/**
 * The Files Center's diff viewer (level 3 of the layer).
 *
 * The diff it draws is OMP's *gutter* form (` 12|code` / `-7|old` / `+9|new`),
 * parsed by `parseGutterDiff`, and the rows wear the app's existing `tv-diff-row`
 * classes so the shared theme paints them — the `--tv-*` tokens are bridged for
 * this subtree in `files.css`, because the app's own bridge is scoped to
 * `.tool-row` and would leave every `var(--tv-ok)` empty here.
 *
 * Two things are deliberate:
 *
 *  - a gutter cell with no recoverable number renders EMPTY. A wrong line number
 *    in a file viewer is worse than a missing one, and the host does not give the
 *    other side's number for a context line.
 *  - the initial render is bounded (50 hunks / 400 lines) but never silently: the
 *    "Show all" control states exactly how much is still hidden.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { STATUS_LETTER } from "../tool-activity.js";
import { changedFileCountsText, CHANGED_FILE_STATUS_LABELS, hunkHeadersOf, parseGutterDiff, patchTextOf, type ChangedFile, type DiffLine, type Hunk } from "../files.js";
import "../files.css";

export interface FileDiffViewProps {
  file: ChangedFile;
  onBack: () => void;
}

/** Initial bound. Large enough for a normal edit, small enough for a phone. */
const HUNK_LIMIT = 50;
const LINE_LIMIT = 400;

function rowClass(line: DiffLine): string {
  switch (line.kind) {
    case "add": return "tv-diff-row--add";
    case "del": return "tv-diff-row--del";
    case "gap": return "tv-diff-row--gap";
    case "ctx": return "";
  }
}

export function FileDiffView({ file, onBack }: FileDiffViewProps): ReactNode {
  const hunks = useMemo(() => (file.lastDiff === null ? [] : parseGutterDiff(file.lastDiff)), [file.lastDiff]);
  // One call for the whole diff: a hunk's new-side start depends on every hunk
  // before it, so a per-hunk call cannot produce it (see `hunkHeadersOf`).
  const headers = useMemo(() => hunkHeadersOf(hunks), [hunks]);
  const [showAll, setShowAll] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [hunkIndex, setHunkIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hunkRefs = useRef(new Map<number, HTMLDivElement>());

  const totalLines = useMemo(() => hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0), [hunks]);
  const { rendered, renderedLines } = useMemo(() => {
    if (showAll) return { rendered: hunks.map((hunk, index) => ({ hunk, index })), renderedLines: totalLines };
    const kept: Array<{ hunk: Hunk; index: number }> = [];
    let lines = 0;
    for (let index = 0; index < hunks.length; index++) {
      if (kept.length >= HUNK_LIMIT) break;
      const hunk = hunks[index]!;
      kept.push({ hunk, index });
      lines += hunk.lines.length;
      if (lines >= LINE_LIMIT) break;
    }
    return { rendered: kept, renderedLines: lines };
  }, [hunks, showAll, totalLines]);

  // Every hunk carries a gutter number or the diff is drawn without gutters at
  // all: a mixed view would imply the empty cells were parsed and found empty.
  const numbered = useMemo(() => hunks.some((hunk) => hunk.lines.some((line) => line.oldLine !== null || line.newLine !== null)), [hunks]);

  // Scrolling is done by offset relative to this component's own scroll container:
  // `scrollIntoView` would also scroll the page, which on a phone moves the whole
  // layer. Runs after render, so a nav that revealed hidden hunks lands on them.
  useEffect(() => {
    const node = hunkRefs.current.get(hunkIndex);
    const container = scrollRef.current;
    if (node === undefined || container === null) return;
    container.scrollTop = node.offsetTop - container.offsetTop - 8;
  }, [hunkIndex, showAll]);

  const copyPatch = async (): Promise<void> => {
    // Same clipboard contract as the app's code-block control: a browser without a
    // clipboard reports a failure instead of silently doing nothing.
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(patchTextOf(file));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const hiddenHunks = hunks.length - rendered.length;
  const hiddenLines = totalLines - renderedLines;

  /**
   * Move to a hunk, revealing it when it is past the render bound.
   *
   * Without the reveal the control would silently do nothing past hunk 50, which
   * is the same lie as discarding the rest of the diff; "next hunk" is the user's
   * explicit request to go further.
   */
  const goToHunk = (next: number): void => {
    const clamped = Math.max(0, Math.min(hunks.length - 1, next));
    if (clamped >= rendered.length) setShowAll(true);
    setHunkIndex(clamped);
  };

  return (
    // A named region: a full screen of the app must be reachable by name.
    <section className="files-diff" role="region" aria-labelledby="files-diff-title">
      <div className="files-head">
        <button type="button" className="files-back" onClick={onBack} aria-label="Back">←</button>
        <div className="files-head-titles">
          <h2 id="files-diff-title" title={file.path}>{file.shortName}</h2>
          {/* The directory, not the whole path: the title above already carries the
              filename, so repeating it would spend the one line on a duplicate. The
              host's path is only ever what it sent — never an absolute path this
              app resolved. */}
          {file.directory === "" ? null : <p className="files-diff-dir" title={file.path}>{file.directory}/</p>}
        </div>
        <span className={`files-status files-status--${file.failed ? "failed" : file.status}`} aria-label={`status: ${file.failed ? "failed" : CHANGED_FILE_STATUS_LABELS[file.status]}`}>
          {file.failed ? "✕" : STATUS_LETTER[file.status]}
        </span>
      </div>

      <div className="files-diff-meta">
        <span className="files-diff-counts">{changedFileCountsText(file)}</span>
        <span className="files-diff-hunks">{hunks.length} hunk{hunks.length === 1 ? "" : "s"}</span>
        {file.edits > 1 && <span className="files-diff-edits">{file.edits} edits observed</span>}
        {hunks.length > 0 && (
          <span className="files-diff-nav">
            <button type="button" aria-label="Previous hunk" disabled={hunkIndex === 0} onClick={() => goToHunk(hunkIndex - 1)}>↑</button>
            <button type="button" aria-label="Next hunk" disabled={hunkIndex >= hunks.length - 1} onClick={() => goToHunk(hunkIndex + 1)}>↓</button>
          </span>
        )}
      </div>

      <div className="files-diff-actions">
        <button type="button" className="files-toggle" aria-pressed={wrap} onClick={() => setWrap((value) => !value)}>Wrap lines</button>
        <button type="button" className="files-toggle" onClick={() => void copyPatch()}>Copy patch</button>
        {copyState === "copied" && <span className="files-copy-note" role="status">Copied</span>}
        {copyState === "failed" && <span className="files-copy-note files-copy-note--failed" role="alert">Copy failed — clipboard unavailable</span>}
      </div>

      {/* The host's own words for a failure, and only they. A failed edit has no
          diff, so this replaces the diff rather than annotating one. */}
      {file.failed && <p className="files-error" role="alert">{file.errorText ?? "The host reported this edit failed and sent no error text."}</p>}
      {file.truncated && <p className="files-note" role="status">The host truncated this diff, so it is a prefix of the edit and its counts are a floor.</p>}

      {file.lastDiff === null ? (
        file.failed ? null : <p className="files-note" role="status">The host sent no diff for this file.</p>
      ) : (
        <div ref={scrollRef} className={`files-diff-scroll${wrap ? " files-diff-scroll--wrap" : ""}`}>
          {rendered.map(({ hunk, index }) => (
            <div
              key={index}
              className="files-diff-hunk"
              ref={(node) => {
                if (node === null) hunkRefs.current.delete(index);
                else hunkRefs.current.set(index, node);
              }}
            >
              {(headers[index] ?? "") !== "" && <div className="tv-diff-row tv-diff-row--hunk files-diff-row">{headers[index]}</div>}
              {hunk.lines.map((line, lineIndex) => {
                const tone = rowClass(line);
                return (
                  <div key={lineIndex} className={`tv-diff-row files-diff-row${tone === "" ? "" : ` ${tone}`}`}>
                    {numbered && line.kind !== "gap" && (
                      <>
                        <span className="files-diff-gutter">{line.oldLine ?? ""}</span>
                        <span className="files-diff-gutter">{line.newLine ?? ""}</span>
                      </>
                    )}
                    <span className="files-diff-code">{line.kind === "gap" ? "…" : line.text}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {hiddenHunks > 0 && (
            <button type="button" className="files-toggle files-show-all" onClick={() => setShowAll(true)}>
              {`Show all — ${hiddenHunks} more hunk${hiddenHunks === 1 ? "" : "s"}, ${hiddenLines} more line${hiddenLines === 1 ? "" : "s"} hidden`}
            </button>
          )}
        </div>
      )}

      {/* Raw host payload, closed by default: nothing raw is on screen until asked. */}
      {file.rawDetails === null || file.rawDetails === undefined ? null : (
        <details className="files-raw">
          <summary>Technical details</summary>
          <pre className="files-raw-json"><code>{JSON.stringify(file.rawDetails, null, 2)}</code></pre>
        </details>
      )}
    </section>
  );
}
