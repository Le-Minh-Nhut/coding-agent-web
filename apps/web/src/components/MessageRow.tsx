/**
 * One transcript row, its advisor variant, and the list that groups them.
 *
 * Moved verbatim out of `ConversationView.tsx` so the view's level-2/level-3
 * screens (Agent Detail chat, Files Center) can render transcript rows without
 * importing the whole conversation screen. Rendering behaviour, class names and
 * DOM structure are unchanged by the move; `ConversationView` re-exports all
 * three names from here, so existing imports keep working.
 */
import React, { memo, useMemo, useState } from "react";
import { renderMarkdown } from "../sanitize.js";
import { advisorNotesOf } from "../advisor.js";
import { CollapsibleMessage } from "./CollapsibleMessage.js";
import { ActivityGroupRow } from "./ToolActivity.js";
import { groupActivity, pairToolArguments } from "../tool-activity.js";
import type { TranscriptBlock, TranscriptMessage, ToolResultLike } from "../transcript.js";

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  blocks?: TranscriptBlock[];
  toolName?: string;
  toolCallId?: string;
  toolResult?: ToolResultLike;
  /** Wire arguments captured from the live start event; the guest body renders
      these directly, so dropping them here silently empties every live tool row. */
  toolArgs?: Record<string, unknown>;
  isError?: boolean;
  isRunning?: boolean;
  awaitingHost?: boolean;
  hostEchoCount?: number;
  /** Custom-message type, so an advisor card can render structurally. */
  customType?: string;
  /** That entry's `details` payload, verbatim. */
  customDetails?: unknown;
}

/**
 * An advisor card, in the compact form the phone needs.
 *
 * OMP delivers advice as a batched `custom_message` (`customType: "advisor"`)
 * whose details carry one or more notes with a severity each. The row's shape is
 * a single line per note — `⚠ Advisor · Concern ›` — with the note text revealed
 * on tap, because a wall of advisor prose between two turns is exactly the kind
 * of chrome that pushes the conversation off a 390px screen.
 *
 * Severity is never levelled: a `blocker` keeps the error colour and its own
 * prominent line so it cannot be mistaken for a nit, and it is never hidden
 * behind the transcript's own collapsing (the row is a normal transcript row, so
 * replay and compaction keep it).
 */
function AdvisorMessageCard({ message }: { message: DisplayMessage }) {
  const [open, setOpen] = useState(false);
  const notes = advisorNotesOf({ customType: message.customType, details: message.customDetails });
  if (notes.length === 0) {
    return <div className="message-content"><p>{message.text}</p></div>;
  }
  const worst = notes.some((note) => note.severity === "blocker")
    ? "blocker"
    : notes.some((note) => note.severity === "concern") ? "concern" : "nit";
  return (
    <div className={`advisor-card advisor-card--${worst}`}>
      <button
        type="button"
        className="advisor-card-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="advisor-card-glyph" aria-hidden="true">{worst === "blocker" ? "⛔" : "⚠"}</span>
        <span className="advisor-card-label">
          Advisor{notes.length === 1 ? "" : ` · ${notes.length} notes`}
          {worst !== "nit" ? ` · ${worst === "blocker" ? "Blocker" : "Concern"}` : ""}
        </span>
        <span className="advisor-card-preview">{notes[0]!.note.split("\n", 1)[0]}</span>
        <span className="advisor-card-chevron" aria-hidden="true">{open ? "▾" : "›"}</span>
      </button>
      {worst === "blocker" && !open && (
        // A blocker is the one severity that must survive a collapsed row: the
        // user has to be able to read what it says without tapping anything.
        <p className="advisor-card-blocker-text">{notes.find((note) => note.severity === "blocker")!.note}</p>
      )}
      {open && (
        <ul className="advisor-card-notes">
          {notes.map((note, index) => (
            <li key={index}>
              <span className={`badge ${note.severity === "blocker" ? "error" : note.severity === "concern" ? "warning" : "idle"}`}>{note.severity}</span>
              {note.advisor !== null && <span className="advisor-note-owner">{note.advisor}</span>}
              <p>{note.note}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const MessageRow = memo(function MessageRow({ message, represented }: {
  message: DisplayMessage | TranscriptMessage;
  /**
   * Tool-call ids that a result row in the same render already shows. Only a
   * request whose id is in here may be hidden — everywhere else (saved history,
   * a host-shared journal, a read-only view) the request is the only record of the
   * call and must be printed.
   */
  represented?: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const blocks = "blocks" in message ? message.blocks : undefined;
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); } catch { /* Clipboard permission is optional; content remains selectable. */ } };
  /**
   * The role label is chrome, and it is only worth its line when it carries
   * something the row's shape does not already say.
   *
   * `user`/`assistant` are told apart by alignment and bubble, so a bare role
   * label there is noise — but a tool row's name, an error, and the
   * "sent while active; awaiting host" caveat are facts nothing else reports, and
   * those keep their line verbatim.
   */
  const caveat = "awaitingHost" in message && message.awaitingHost ? " · sent while active; awaiting host" : "";
  const roleLabel = message.role === "tool"
    ? `tool${message.toolName ? ` (${message.toolName})` : ""}`
    : `${message.role}${message.isError ? " · error" : ""}`;
  const showRoleLabel = message.role === "tool" || message.role === "notice" || message.isError === true || caveat !== "";
  return (
    <div className={`message-card ${message.role}${message.isError ? " error" : ""}`}>
      {showRoleLabel && (
        <div className="message-role" style={{ color: message.isError ? "var(--danger-text)" : "var(--text-muted)" }}>
          {roleLabel}{caveat}
        </div>
      )}
      {/* An advisor card is a transcript row, so it survives replay and is never
          folded into a group: an advisor warning hidden inside a collapsed
          activity row is a warning the user will not see. */}
      {"customType" in message && message.customType === "advisor" ? (
        <AdvisorMessageCard message={message} />
      ) : message.role === "tool" ? <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>{message.toolName ?? "Tool Result"} {"isRunning" in message && message.isRunning ? "(Running…)" : message.isError ? "(Error)" : "(Completed)"}</summary>
        <p className="tool-output-preview">{message.text.slice(0, 240)}{message.text.length > 240 ? "…" : ""}</p>
        <div className="history-actions"><button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse output" : "Expand output"}</button><button type="button" onClick={() => void copy(message.text)}>Copy output</button></div>
        {/* Mounted only while open: a 5000-line result otherwise builds every text
            node the collapsed card never shows, which is the expensive-render case
            on a phone. The full string stays in `message.text` — Copy reads it and
            expanding mounts all of it, so nothing is deleted, only deferred. */}
        {expanded && <pre className="message-content" style={{ overflowX: "auto", whiteSpace: "pre" }}><code>{message.text}</code></pre>}
      </details> : message.role === "user" ? (
        /* A pasted multi-page task used to occupy whole screens (Phase 4).
           This branch MUST precede the `blocks` one: durable user rows always
           carry blocks (`transcript.ts:315`), so testing blocks first meant a
           long prompt collapsed while optimistic and then expanded again the
           moment the host echo replaced the row. The body is always mounted and
           `Copy` reads `message.text` verbatim, so nothing is lost — only
           deferred. `identity` is the durable row id, never an index, so two
           identical prompts expand independently. */
        <CollapsibleMessage identity={message.id} text={message.text}>
          {blocks ? (
            <div className="message-content">{blocks.map((block, index) => renderTranscriptBlock(block, index, represented))}</div>
          ) : (
            <div className="message-content">{renderMarkdown(message.text)}</div>
          )}
        </CollapsibleMessage>
      ) : blocks && message.role !== "notice" ? (
        <div className="message-content">{blocks.map((block, index) => renderTranscriptBlock(block, index, represented))}</div>
      ) : (
        <div className="message-content">{message.role === "notice" ? <p>{message.text}</p> : renderMarkdown(message.text)}</div>
      )}
    </div>
  );
});

/**
 * The transcript list: tool results collapse into per-category activity groups,
 * every other row keeps its own card.
 *
 * Grouping is presentation only — the rows handed to a group are the same
 * objects the ungrouped list would render, and each group's card expands to
 * those rows unchanged. That is why a reconnect or replay cannot duplicate rows:
 * the group derives from `messages`, which the reducer already de-duplicates.
 */
export const TranscriptList = memo(function TranscriptList({ rows, onOpenFile }: {
  rows: DisplayMessage[];
  /**
   * Forwarded to every activity group so an `edit` file row can open the diff
   * viewer. Optional on purpose: `AgentChat` and `HistoryView` render transcripts
   * with no Files layer behind them, and for those a no-op is the correct
   * behaviour — a required prop would force them to fabricate a handler.
   */
  onOpenFile?: (path: string) => void;
}) {
  const entries = useMemo(() => groupActivity(rows), [rows]);
  const pairedArgs = useMemo(() => pairToolArguments(rows), [rows]);
  /**
   * Which tool calls this render actually shows a result for. A `bash` request
   * whose result row is present is displayed by that result's activity card, so
   * printing the request too would show one execution twice. A request with no
   * result row on screen is shown as itself, because nothing else records it.
   */
  const represented = useMemo(() => {
    const ids = new Set<string>();
    for (const row of rows) {
      if (row.role === "tool" && "toolCallId" in row && typeof row.toolCallId === "string") ids.add(row.toolCallId);
    }
    return ids;
  }, [rows]);
  return (
    <>
      {entries.map((entry) => entry.kind === "row"
        ? <MessageRow key={entry.row.id} message={entry.row} represented={represented} />
        : <ActivityGroupRow key={`group:${entry.group.rows[0]?.id ?? ""}`} group={entry.group} pairedArgs={pairedArgs} onOpenFile={onOpenFile} />)}
    </>
  );
});

/**
 * One transcript block.
 *
 * A tool *request* block is only allowed to disappear when the transcript is
 * already showing the execution it belongs to. `represented` is the set of
 * tool-call ids that have a result row in the list being rendered, and its
 * absence — or an id not in it — means the request is the ONLY record of that
 * call, so it must be rendered. Suppressing unconditionally cost a reader of
 * saved history and of a host-shared journal the only trace of the call, which is
 * the information loss this branch exists to avoid.
 */
function renderTranscriptBlock(block: TranscriptBlock, index: number, represented?: ReadonlySet<string>): React.ReactNode {
  if (block.type === "toolCall") {
    // `id` is the wire pairing key (`collab-protocol/src/types.ts:33`). Without one
    // the request cannot be matched to a result, so it is always shown.
    if (block.id !== undefined && represented?.has(block.id)) return null;
    return <details key={index}><summary>{`[Tool call: ${block.name}${block.intent ? ` — ${block.intent}` : ""}]`}</summary><pre style={{ overflowX: "auto" }}><code>{JSON.stringify(block.arguments, null, 2)}</code></pre></details>;
  }
  if (block.type === "image") return block.dataUrl ? <img key={index} src={block.dataUrl} alt="Attachment" style={{ maxWidth: "100%" }} /> : <p key={index}>{block.label}</p>;
  if (block.type === "notice") return <p key={index}>{block.text}</p>;
  return <React.Fragment key={index}>{renderMarkdown(block.text)}</React.Fragment>;
}
