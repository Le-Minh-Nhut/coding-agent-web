/**
 * One transcript row, its advisor variant, and the list that groups them.
 *
 * Moved verbatim out of `ConversationView.tsx` so the view's level-2/level-3
 * screens (Agent Detail chat, Files Center) can render transcript rows without
 * importing the whole conversation screen. Rendering behaviour, class names and
 * DOM structure are unchanged by the move; `ConversationView` re-exports all
 * three names from here, so existing imports keep working.
 */
import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { renderMarkdown } from "../sanitize.js";
import { advisorNotesOf } from "../advisor.js";
import { CollapsibleMessage } from "./CollapsibleMessage.js";
import { ActivityGroupRow } from "./ToolActivity.js";
import { groupActivity, pairToolArguments } from "../tool-activity.js";
import {
  DEFAULT_OVERSCAN_PX,
  WINDOW_MIN_ENTRIES,
  buildOffsets,
  computeSegments,
  computeWindow,
  spacerHeights,
  entryKey,
  estimateHeights,
  fallbackHeightFor,
  type EntryWindow,
} from "../transcript-window.js";
import { isRecord } from "../guest-tools.js";
import { ScrollController } from "../scroll-controller.js";
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
}, (previous, next) => {
  /**
   * Comparator, because `represented` cannot be compared by identity.
   *
   * `TranscriptList` rebuilds the set of tool-call ids that already have a result
   * row on every render, so a shallow compare fails on it for *every* row — which
   * made `memo` a no-op and had React walking all 4075 rows on each streamed frame.
   * A V8 self-time profile of 30 appended tool rows into a 4075-entry history
   * attributed 149ms to React's own reconciler (`react-dom`'s `ee`/`nc`/`Cu`/`gg`),
   * which is what this comparator removes.
   *
   * `represented` only ever suppresses a tool-call block whose id is present, so
   * the row's own rendering depends on exactly one bit of it: whether THIS row's
   * tool-call ids are in the new set. Comparing that bit per id keeps the answer
   * identical while dropping the mismatch on rows that cannot be affected.
   */
  if (previous.message !== next.message) return false;
  if (previous.represented === next.represented) return true;
  const rule = (message: DisplayMessage | TranscriptMessage): boolean => {
    const ids = new Set<string>();
    const blocks = "blocks" in message ? message.blocks : undefined;
    if (blocks !== undefined) {
      for (const block of blocks) if (block.type === "toolCall" && block.id !== undefined) ids.add(block.id);
    }
    if (message.role === "tool") {
      const toolCallId = (message as DisplayMessage).toolCallId;
      if (typeof toolCallId === "string") ids.add(toolCallId);
    }
    for (const id of ids) {
      const before = previous.represented?.has(id) ?? false;
      const after = next.represented?.has(id) ?? false;
      if (before !== after) return false;
    }
    return true;
  };
  return rule(previous.message);
});

/**
 * What a caller outside the list may ask it to do.
 *
 * Only one operation is needed: reveal an identity. In-app search has the full
 * `transcript.messages` and therefore knows *which* message matched, but only the
 * list knows *where* that message sits in a document whose unmounted span is a
 * spacer of estimated height.
 */
/**
 * How far below the scroller's top edge a revealed entry is placed.
 *
 * The transcript has its own padding and the rows are cards, so an entry flush against
 * the top edge reads as "cut off"; a small inset keeps it clearly whole while leaving
 * almost the full viewport below it. Its only job is to make a reveal actually visible.
 */
const ELEMENT_TOP_INSET_PX = 8;

export interface TranscriptListApi {
  /** Scroll the transcript so the entry with this identity is at the top, and pin it. */
  scrollToIdentity: (identity: string) => void;
  /**
   * Stop revealing. A reveal is a temporary instruction ("show me this hit"), not a
   * property of the row: left armed, it re-opens a collapsed group every time that
   * group is remounted, including long after the search that asked for it was closed.
   */
  clearReveal: () => void;
}

export interface TranscriptListProps {
  rows: DisplayMessage[];
  /**
   * Forwarded to every activity group so an `edit` file row can open the diff
   * viewer. Optional on purpose: `AgentChat` and `HistoryView` render transcripts
   * with no Files layer behind them, and for those a no-op is the correct
   * behaviour — a required prop would force them to fabricate a handler.
   */
  onOpenFile?: (path: string) => void;
  /**
   * The element that scrolls this list. Given one, the list mounts only the rows
   * near the visible range and keeps the rest of the conversation as spacer height.
   * Omitted — as `AgentChat` and the component tests do — every row is mounted, so
   * the behaviour of a caller that has its own windowing is unchanged.
   */
  scrollElement?: RefObject<HTMLElement | null>;
  /**
   * Identities that must stay mounted whatever the window says: the row a search
   * jump landed on, the row holding the focus ring, a row whose disclosure is open.
   */
  pinnedIdentities?: ReadonlySet<string>;
  /**
   * The one object allowed to write this list's `scrollTop`, and the owner of the tail
   * state machine. Supplied by the screen that also renders the transcript so it can
   * publish `↓ Latest`; the list never decides the tail on its own.
   *
   * Omitted by callers that have no tail obligation (a read-only history screen, the
   * component tests): a private controller is still created so that EVERY write in this
   * file goes through the same machine — there is no second code path that assigns
   * `scrollTop` — it simply has no subscriber.
   */
  controller?: ScrollController;
  /** Receives the imperative handle, so the owner can reveal a search hit. */
  apiRef?: MutableRefObject<TranscriptListApi | null>;
  /** Overscan, in px. Defaults to `DEFAULT_OVERSCAN_PX`; overridden only by a benchmark. */
  overscanPx?: number;
}

/**
 * The transcript list: tool results collapse into per-category activity groups,
 * every other row keeps its own card, and only the rows near the viewport are in
 * the document.
 *
 * Grouping is presentation only — the rows handed to a group are the same
 * objects the ungrouped list would render, and each group's card expands to
 * those rows unchanged. That is why a reconnect or replay cannot duplicate rows:
 * the group derives from `messages`, which the reducer already de-duplicates.
 *
 * ## The window
 *
 * `rows` — and therefore `entries` — is always the complete transcript; the state
 * that bounds is what is *mounted*. Measured on an 8,000-entry conversation the
 * unbounded list put 313,916 elements in the document and starved the renderer for
 * up to 793 ms per frame (2,112 ms on WebKit). Every downstream reader — search,
 * copy, tool expansion, the counts a group prints — reads the full arrays; only the
 * DOM is bounded, and a bounded DOM is not lost information, it is unrendered
 * information with an exact scroll position.
 *
 * The unmounted span is a spacer of the sum of estimated heights, so the scrollbar
 * still represents the whole conversation and `scrollHeight` stays honest enough
 * for `followTailRef` and jump-to-latest to keep working unchanged.
 *
 * ## Why the spacers are honest
 *
 * Sums are computed as `offset[index]`, and the DOM holds
 * `topSpacer + mounted heights = offset[window.start] + (heights before index)`.
 * Both sides are built from the same array, so scrolling to `offset[i]` places entry
 * `i` at the top of the viewport, even while distant entries are guessed. An estimate
 * error moves the scrollbar thumb, never the landing.
 *
 * One real space is *not* in that sum: the flex `gap` between rendered siblings is
 * additive layout and belongs to no element's measured height, so the DOM was taller
 * than the model by `(renderedItems - 1) * gap`. `fitSpacersToGap` takes exactly that
 * back out of the spacers, which is why the landing is exact rather than merely
 * close — and why this paragraph used to be wrong when it said "exactly" without it.
 */
interface AnchorDebugWindow {
  __trackAnchorCaptures?: boolean;
  __anchorCaptures?: number;
  __capturesPerCorrection?: number[];
  __anchorCorrectionDurations?: number[];
}

export const TranscriptList = memo(function TranscriptList({
  rows,
  onOpenFile,
  scrollElement,
  pinnedIdentities: pinnedIdentitiesProp,
  controller: controllerProp,
  apiRef,
  overscanPx = DEFAULT_OVERSCAN_PX,
}: TranscriptListProps) {
  /**
   * The controller for this list. The private instance exists so every `scrollTop` write
   * in this file routes through one machine even when nobody is listening; it is created
   * lazily because a new instance per render would reset the mode.
   */
  const ownControllerRef = useRef<ScrollController | null>(null);
  if (ownControllerRef.current === null) ownControllerRef.current = new ScrollController();
  const controller = controllerProp ?? ownControllerRef.current;
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

  const keys = useMemo(() => entries.map(entryKey), [entries]);
  /**
   * Measured heights, by identity rather than by position.
   *
   * By identity is the whole point: history prepends above the reader, a group folds
   * an echo in above the reader, and a compaction drops rows — none of those may
   * renumber what has already been measured and make the document jump. An entry
   * that has never been measured is estimated from its nearest measured neighbour.
   */
  const measuredRef = useRef(new Map<string, number>());
  /** Bumped when a measurement lands, because heights are read during render. */
  const [measureVersion, setMeasureVersion] = useState(0);
  const heights = useMemo(() => {
    const fallbacks: number[] = entries.map(fallbackHeightFor);
    const measured = keys.map((key) => measuredRef.current.get(key));
    return estimateHeights(measured, fallbacks);
  }, [entries, keys, measureVersion]);
  /**
   * The entries column's flex gap, in px. It is part of the HEIGHT MODEL (see
   * `buildOffsets`), not a correction applied at render time: a correction made every
   * mounted entry's position depend on how many rows happened to be mounted, which is
   * what made the anchor correction oscillate into React #185.
   */
  const [gapPx, setGapPx] = useState(0);
  useLayoutEffect(() => {
    const element = entriesRef.current;
    if (element === null) return;
    const next = parseFloat(getComputedStyle(element).rowGap) || 0;
    setGapPx((previous) => (Math.abs(previous - next) < 0.01 ? previous : next));
    // Re-runs when the transcript first renders a body: on the very first commit the ref
    // is still null (the elements do not exist yet), and a `[]` dependency list would
    // never try again — which is exactly how `gapPx` stayed 0 while the CSS gap was 10px.
  }, [entries.length]);
  const offsets = useMemo(() => buildOffsets(heights, gapPx), [heights, gapPx]);

  /** The scroller's own geometry, read on scroll and on resize. */
  const [viewport, setViewport] = useState<{ top: number; height: number }>({ top: 0, height: 0 });
  const elementsRef = useRef(new Map<string, HTMLElement>());
  /**
   * The entries wrapper, only to read its computed flex `gap` — that gap is document
   * height no element measurement contains (see `fitSpacersToGap`).
   */
  const entriesRef = useRef<HTMLDivElement | null>(null);
  /**
   * Entries that must survive the window because something inside them is *live*:
   * an open disclosure (a `Show more` the user opened, an activity group they
   * expanded) or the row holding the focus ring.
   *
   * Read from the mounted DOM while it is still mounted — on scroll and on commit,
   * before anything is dropped — and carried forward for the rest of the session. The
   * state inside those disclosures lives in the component, so unmounting one is not
   * "re-render it later", it is closing what the user opened and losing their place
   * in it.
   */
  const stickyKeysRef = useRef(new Set<string>());
  /**
   * Where the reading position is: an identity, its distance from the top of the
   * viewport, and the `scrollTop` that was in force when it was captured.
   *
   * The last field is the guard that makes the whole correction safe. If `scrollTop`
   * has moved since capture, the movement was somebody else's — the user's finger, a
   * `scrollIntoView`, a programmatic scroll, jump-to-latest — and correcting against
   * the old anchor would drag the view back to where it used to be. Measured: without
   * this, a 120-step programmatic scroll was reverted to the anchor on every commit
   * and never progressed at all.
   */
  const anchorRef = useRef<{ key: string; offset: number; scrollTop: number } | null>(null);
  const [jump, setJump] = useState<{ identity: string; token: number } | null>(null);
  /** Bumped when a focus event pins a row, so the window recomputes with that pin. */
  const [focusVersion, setFocusVersion] = useState(0);
  const jumpTokenRef = useRef(0);
  /**
   * The identity a jump or a search hit asked to see, kept until the reader moves
   * somewhere else. A group's body only renders its members when it is open, so
   * "mounted" is not the same as "readable" — this is what makes the reveal honest
   * for a hit that lives inside a collapsed group rather than at its head.
   */
  const revealRef = useRef<string | null>(null);

  const windowed = scrollElement !== undefined && entries.length >= WINDOW_MIN_ENTRIES;
  const indexOfKey = useMemo(() => {
    const map = new Map<string, number>();
    keys.forEach((key, index) => { if (!map.has(key)) map.set(key, index); });
    return map;
  }, [keys]);

  /** Rows the user must be able to act on or read right now, whatever the window. */
  const pinnedIdentities = pinnedIdentitiesProp;
  const pinned = useMemo(() => {
    const indices: number[] = [];
    for (const identity of pinnedIdentities ?? []) {
      const index = indexOfKey.get(identity) ?? indexOfKey.get(`group:${identity}`);
      if (index !== undefined) indices.push(index);
    }
    // Only what is live in the mounted DOM right now, re-read each render: an entry
    // that has been unmounted no longer holds an open disclosure or the focus ring, so
    // it does not need to be pinned. Accumulating these for the whole session — which
    // the first version did — turned every group a test opened while walking the
    // document into a permanent pin, and a handful of pins spread across an 8,000-entry
    // history is enough to mount everything between them (measured: a 182,480px spacer
    // followed by the wrong end of the transcript).
    for (const [key, node] of elementsRef.current) {
      if (node.querySelector('[aria-expanded="true"]') === null && !node.contains(document.activeElement)) continue;
      const index = indexOfKey.get(key);
      if (index !== undefined) indices.push(index);
    }
    // The anchored row is NOT pinned. It was, briefly, and it was wrong: every scroll
    // left one more anchor behind, so a conversation that had just loaded accumulated
    // them and the document's estimated height compounded to 7.8 million pixels for a
    // 4,075-entry transcript. The anchor correction alone holds the reading position
    // (measured: 0px delta across a 300-entry prepend), because the mounted window is
    // recomputed from the *post-correction* offset on the scroll event the correction
    // itself raises.
    if (jump !== null) {
      const index = indexOfKey.get(jump.identity) ?? indexOfKey.get(`group:${jump.identity}`);
      if (index !== undefined) indices.push(index);
    }
    return indices;
  }, [pinnedIdentities, indexOfKey, jump, measureVersion, focusVersion]);

  /**
   * The scroll position the window is computed from, read LIVE.
   *
   * The first version derived it from `viewport`, a piece of state the `scroll` listener
   * updates on a coalesced animation frame. That is the right shape for smooth
   * scrolling, and it is wrong for everything else: the browser's own offset moves
   * continuously — a flick, a programmatic scroll, `scrollIntoView` — and React may
   * render while the state still describes an older position. Measured on WebKit: a
   * blank frame with entries 4070-4075 mounted and `scrollTop` at 196,847, i.e. the
   * window four thousand entries away from where the reader actually was.
   *
   * The live offset is authoritative — it is the value the browser will paint at — so it
   * is read during render, with the state only as the subscription that schedules the
   * render. A layout effect then re-reads it after commit, which is what guarantees the
   * *next* paint also agrees.
   */
  const liveTop = scrollElement?.current?.scrollTop ?? viewport.top;
  const liveHeight = scrollElement?.current?.clientHeight ?? viewport.height;

  /**
   * There used to be a no-dependency `useLayoutEffect` here that published the
   * scroller's offset whenever it differed from `viewport`. It was removed as the
   * second half of the React #185 fix: a layout effect that dispatches on EVERY commit
   * is a dispatch chain, and during a stream the tail pin writes `scrollTop` on every
   * commit, so the effect always had something to publish — measured at 783 renders of
   * `ConversationView` (170 in one 400ms window) after 500 characters were typed while
   * streaming.
   *
   * Nothing is lost: the offset that MATTERS is read live during render (`liveTop`),
   * and the scroller's own `scroll` listener publishes the same state one frame later
   * with the value the reader actually landed on. This effect was duplicating that
   * subscription from inside the commit phase.
   */

  const visible: EntryWindow = useMemo(() => {
    if (!windowed) return { start: 0, end: entries.length };
    // Deliberately WITHOUT `pinned`: a pin is a separate segment (see `segments`
    // below), never a reason to widen this range. Widening is what made a failed row
    // at the bottom of an 8,000-entry conversation mount the 6,759 entries between it
    // and the viewport — measured, after the first version of this change shipped that
    // exact bug.
    return computeWindow({ offsets, scrollTop: liveTop, viewportPx: liveHeight, overscanPx });
    // `viewport` is the subscription: it changes on every scroll frame, which is what
    // forces this memo to be recomputed against the live offset above.
  }, [windowed, entries.length, offsets, liveTop, liveHeight, overscanPx, viewport]);

  /**
   * Enforce the tail invariant after every commit, instead of trusting a notification.
   *
   * Following the tail is a statement about the DOCUMENT, so it must hold whenever the
   * document changes — not only when a scroll event or a `ResizeObserver` record happens to
   * arrive. Measured on WebKit (the owner's engine) with the heavy 4,075-entry fixture,
   * scroll-to-bottom, 1 of 6 runs: the write landed at `scrollTop 712,712` while
   * `scrollHeight` was 732,974, so 19,580px of content appeared AFTER the write with no
   * scroll event and no observer record, and the view sat 19,580px short of the bottom
   * permanently (identical at +50/150/400/1000ms). The mounted window was correct for the
   * offset — rows 3,949-3,953 — which is why this is not a window bug: the position had
   * simply not been corrected, and nothing was going to correct it.
   *
   * Chromium always delivered one of those notifications, so this never showed there.
   *
   * The effect writes `scrollTop` and dispatches NO state: writing the position is the
   * whole obligation. The scroll event it raises re-enters `updateTailLock`, finds the
   * distance at zero, and keeps the lock — so this converges in one pass and cannot
   * sustain a render loop (the failure mode that produced React #185 was a correction that
   * re-armed itself through state).
   */
;
;

  /**
   * Self-heal a window that does not contain the offset the browser actually has.
   *
   * The window is derived during render from `liveTop`, which reads `scrollTop` at that
   * moment. On WebKit the engine can move `scrollTop` AFTER that render without ever
   * dispatching another scroll event — it clamps a write to a maximum it is still
   * recomputing, and applies the result once the layout lands. Measured on a 4,075-entry
   * heavy transcript, scroll-to-bottom: the write landed at `scrollTop 126,241` while
   * `scrollHeight` had already grown to 937,795, the mounted window stayed at rows
   * 104-118, and no further render ever corrected it — so `SCROLL-03` reported
   * `posinset 17` with `setsize 4075`, i.e. the scroller at the end and the window at the
   * start. Chromium does not reproduce it because its scroll event arrives with the write.
   *
   * This publishes a version bump ONLY when the live offset falls outside the mounted
   * range, which is a state the render itself cannot produce — the next render computes a
   * window that contains the offset, so the condition is false and the effect stops. That
   * is a convergence guard, not a counter.
   */
  const [, setWindowEpoch] = useState(0);
  useLayoutEffect(() => {
    const element = scrollElement?.current ?? null;
    if (element === null || !windowed) return;
    const startOffset = offsets[visible.start] ?? 0;
    const endOffset = offsets[visible.end] ?? offsets[offsets.length - 1] ?? 0;
    const top = element.scrollTop;
    const height = element.clientHeight;
    // The live viewport is not inside the mounted range at all: the window is stale.
    const beforeMounted = top + height <= startOffset + 1;
    const afterMounted = top >= endOffset - 1;
    if (beforeMounted || afterMounted) {
      setWindowEpoch((value) => value + 1);
    }
  }, [scrollElement, windowed, visible.start, visible.end, offsets, entries.length]);

  /**
   * What is mounted, as sorted disjoint segments: the visible window plus each pinned
   * entry. A pinned row is mounted where it belongs rather than stretching the window
   * to cover the distance between it and the viewport.
   */
  const segments: EntryWindow[] = useMemo(
    () => (windowed ? computeSegments({ offsets, visible, pinned }) : [visible]),
    [windowed, offsets, visible, pinned],
  );

  /** Measure the scroller, and notice a viewport change (rotation, keyboard). */
  useEffect(() => {
    const element = scrollElement?.current ?? null;
    if (element === null) return;
    let frame = 0;
    const read = (): void => {
      frame = 0;
      setViewport((previous) => (
        Math.abs(previous.top - element.scrollTop) < 0.5 && Math.abs(previous.height - element.clientHeight) < 0.5
          ? previous
          : { top: element.scrollTop, height: element.clientHeight }
      ));
      captureAnchorRef.current?.();
    };
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(read);
    };
    element.addEventListener("scroll", schedule, { passive: true });
    read();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollElement]);

  /**
   * Feed the controller: every scroll and every resize.
   *
   * The controller decides the tail; this effect only tells it what happened, and what
   * happened is a fact of the element's own geometry. No input listener is registered,
   * deliberately: the gestures that must be recognised include a scripted offset
   * assignment with a dispatched `scroll` event (how the e2e specs park a reader), which
   * produces no wheel, touch or key event at all.
   */
  useEffect(() => {
    const element = scrollElement?.current ?? null;
    if (element === null) return;
    /**
     * Attach here rather than in a layout effect: on the first commit the scroller's ref
     * is still null — refs attach to a host element only after its subtree's layout
     * effects have run — so a layout effect would silently never attach, and the machine
     * would classify every movement against a surface it does not have.
     */
    controller.attach(element);
    let frame = 0;
    const observe = (): void => {
      controller.sync();
      if (frame !== 0) return;
      // One classification per frame: the scroll event and the observer record for the
      // same layout change must not be judged twice, since the second judgement would
      // see a document already grown under a stationary reader.
      frame = requestAnimationFrame(() => { frame = 0; });
    };
    element.addEventListener("scroll", observe, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(observe);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", observe);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      controller.detach();
    };
  }, [scrollElement, controller]);

  /**
   * Record which entry is crossing the top of the viewport, and by how much.
   *
   * This is the anchor every later correction is measured against: after a
   * measurement lands or rows are prepended, the same entry must sit at the same
   * distance from the top of the viewport. Reading it on scroll (coalesced to one
   * frame) rather than on every commit keeps the cost where the movement is.
   */
  /**
   * Pin the row that holds focus, learned from focus events rather than discovered late.
   *
   * The pin set is derived from `document.activeElement` during render, but focus that
   * arrives in the same commit as a scroll (a search jump, a recovery that calls
   * `composerRef.focus()`) is not yet in `activeElement` when the render that drops the
   * row runs — so a row could unmount while holding the next focus and the ring falls to
   * `body`. These listeners record the entry before the next render needs it.
   */
  useEffect(() => {
    const element = scrollElement?.current ?? null;
    if (element === null) return;
    const remember = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const entry = target.closest(".transcript-entry");
      const key = entry?.querySelector("[data-entry-key]")?.getAttribute("data-entry-key")
        ?? entry?.getAttribute("data-entry-key");
      if (key === null || key === undefined) return;
      if (!stickyKeysRef.current.has(key)) {
        stickyKeysRef.current.add(key);
        setFocusVersion((value) => value + 1);
      }
    };
    element.addEventListener("focusin", remember);
    return () => element.removeEventListener("focusin", remember);
  }, [scrollElement]);

  const captureAnchor = (withDiscovery = true): void => {
    if (typeof window !== "undefined") {
      const debugWin = window as unknown as AnchorDebugWindow;
      if (debugWin.__trackAnchorCaptures || window.location?.search?.includes("debug=anchor")) {
        debugWin.__anchorCaptures = (debugWin.__anchorCaptures ?? 0) + 1;
      }
    }
    const element = scrollElement?.current ?? null;
    if (element === null) return;
    // Anything live inside a mounted entry becomes sticky before it can be dropped.
    // Discovery is skipped when this runs from the correction itself: setting state
    // there re-runs the correction, and a correction that triggers its own next
    // correction is an infinite render loop (React #185, measured). Discovery belongs
    // to the scroll path, which is already coalesced to one frame.
    if (withDiscovery) {
      // Only records; there is deliberately no "did anything new turn up" flag to
      // return. The pin set is derived from the mounted DOM on every render, so a
      // discovery that did not change the DOM changes no output either — and a state
      // write from this path would re-run the correction that called it (React #185).
      for (const [key, node] of elementsRef.current) {
        if (stickyKeysRef.current.has(key)) continue;
        if (node.querySelector('[aria-expanded="true"]') !== null || node.contains(document.activeElement)) {
          stickyKeysRef.current.add(key);
        }
      }
    }
    const top = element.getBoundingClientRect().top;
    let best: { key: string; offset: number; scrollTop: number } | null = null;
    /** The last mounted entry above the viewport — the fallback anchor. */
    let closest: { key: string; offset: number; scrollTop: number } | null = null;
    for (const [key, node] of elementsRef.current) {
      const box = node.getBoundingClientRect();
      if (box.bottom < top) {
        closest = { key, offset: box.top - top, scrollTop: element.scrollTop };
        continue;
      }
      best = { key, offset: box.top - top, scrollTop: element.scrollTop };
      break;
    }
    /**
     * Always anchor to *something* mounted.
     *
     * The first version only anchored to an entry that reached the viewport, and that
     * made it fail in exactly the case that needed it: after a fast flick the mounted
     * window can sit ENTIRELY above the band (measured on WebKit: 24 entries mounted,
     * band 100% blank, 283ms), there is no such entry, the anchor stayed `null`, and the
     * correction that would have pulled the content back never ran. The nearest entry
     * above the fold is a perfectly good anchor — it is the row the reader has just
     * scrolled past, and its position is exactly as meaningful for a correction.
     */
    anchorRef.current = best ?? closest;
  };
  const captureAnchorRef = useRef(captureAnchor);
  captureAnchorRef.current = captureAnchor;

  /**
   * Hold the reading position across a commit that changes the document's geometry.
   *
   * Runs after the DOM is updated and before paint, so the correction is never
   * visible: an entry that was measured taller, or a run of history prepended above
   * the reader, moves `scrollTop` by exactly the distance the anchored entry moved.
   * Skipped while following the tail — there the bottom is the anchor and the view's
   * own tail logic owns it.
   */
  useLayoutEffect(() => {
    const debugWin = typeof window !== "undefined" ? (window as unknown as AnchorDebugWindow) : undefined;
    const track = Boolean(debugWin?.__trackAnchorCaptures || (typeof window !== "undefined" && window.location?.search?.includes("debug=anchor")));
    const t0 = track ? performance.now() : 0;
    const startCaptures = track && debugWin !== undefined ? (debugWin.__anchorCaptures ?? 0) : 0;
    const recordCorrectionMetrics = (): void => {
      if (!track || debugWin === undefined) return;
      (debugWin.__anchorCorrectionDurations ??= []).push(performance.now() - t0);
      (debugWin.__capturesPerCorrection ??= []).push((debugWin.__anchorCaptures ?? 0) - startCaptures);
    };
    const element = scrollElement?.current ?? null;
    if (element === null || !windowed) { recordCorrectionMetrics(); return; }
    if (controller.follows) {
      // Following the tail means the *bottom* is the anchor. When an estimate becomes
      // a measurement the document grows or shrinks under the reader, and without
      // re-pinning the newest message drifts out of view — measured at 7,529 px after
      // the 4,075-entry snapshot settled, which is what made the newest row
      // unreachable by a "scroll to bottom". The view re-pins on `messages`, which do
      // not change here; this is the same rule applied to the height model.
      controller.sync();
      anchorRef.current = null;
      recordCorrectionMetrics();
      return;
    }
    const anchor = anchorRef.current;
    if (anchor === null) {
      captureAnchorRef.current?.(false);
      recordCorrectionMetrics();
      return;
    }
    const node = elementsRef.current.get(anchor.key);
    if (node === undefined) {
      /**
       * The anchored entry left the window — and it can leave because content ABOVE it
       * grew, not only because somebody moved the view.
       *
       * Giving up here (the first behaviour) loses the reading position exactly in the
       * case this effect exists for. Measured: a `Show more` at the reader's own row
       * expanded a single entry to 4,460px; every row below it was pushed out of the
       * window, the anchor row among them, so the correction bailed out while
       * `scrollTop` stayed put — and the reader was left staring at the empty bottom of
       * the expanded block with 13 entries mounted somewhere above and no way to tell.
       *
       * The model already knows where that entry is now, so the correction is arithmetic
       * rather than a guess: move by exactly the distance the entry's model offset
       * changed, which is the growth above it.
       */
      const anchorIndex = indexOfKey.get(anchor.key);
      if (anchorIndex !== undefined) {
        const modelOffset = offsets[anchorIndex];
        if (modelOffset !== undefined) {
          /**
           * The scroll movement since capture MUST be part of the target.
           *
           * At capture the anchor row sat at document offset `D0`, viewport offset `O0`
           * with `scrollTop = S0`, so `D0 - S0 = O0`. Holding that viewport offset now
           * needs `target = D1 - O0 = (D1 - D0) + S0`. If the reader (or a programmatic
           * jump) has since scrolled `ΔS = scrollTop - S0`, the row must sit `ΔS` higher
           * in the viewport, so `target = modelOffset - anchor.offset + ΔS`.
           *
           * Leaving that term out made this branch undo any movement that unmounted the
           * anchor. Measured on WebKit, 4,075 heavy rows, "return to bottom": the write
           * landed correctly (`scrollTop 458,385`, `atMax: true`), then the very next
           * frame reverted it to 44,578 and the frame after to 44,558 — the capture-time
           * position — because the anchor row (~entry 460) was unmounted by the jump and
           * the arithmetic put the view back where the anchor was last seen. Chromium hit
           * the same branch less often, which is why this surfaced on the owner's engine.
           *
           * The `Show more` case this branch was written for has `ΔS = 0` (the reader did
           * not scroll; the document grew), so that behaviour is unchanged.
           */
          const scrolledSinceCapture = element.scrollTop - anchor.scrollTop;
          controller.keepTarget(Math.max(0, modelOffset - anchor.offset + scrolledSinceCapture));
          // Re-capture from the DOM so the next commit has a mounted anchor again.
          captureAnchorRef.current?.(false);
          recordCorrectionMetrics();
          return;
        }
      }
      // Truly unknown (the entry is gone from the model): re-capture rather than guess.
      captureAnchorRef.current?.(false);
      recordCorrectionMetrics();
      return;
    }
    /**
     * Both causes of movement, in one correction.
     *
     * `anchor.offset` is where the anchor row sat relative to the scroller's top when it
     * was recorded, and `anchor.scrollTop` is the offset in force then. Since that
     * capture the row may have moved for two independent reasons: the user scrolled
     * (`scrollTop` changed), and the document's geometry changed because a height above
     * the viewport was measured (`offset` changed). The reader's content position must
     * follow the first and ignore the second, so:
     *
     *     wanted = anchor.offset - (scrollTop - anchor.scrollTop)
     *     delta  = actual - wanted
     *
     * Skipping the whole correction whenever `scrollTop` had moved — which is what this
     * did first — meant it never ran under a flick, which is exactly when estimates
     * above the viewport are being replaced by measurements. Measured on WebKit: the
     * mounted rows drifted entirely *above* the visible band (-715px against a band top
     * of 102) and painted a blank screen for up to 199ms.
     */
    const scrolledSinceCapture = element.scrollTop - anchor.scrollTop;
    const actual = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
    const delta = actual - (anchor.offset - scrolledSinceCapture);
    if (Math.abs(delta) >= 0.5) {
      // Apply, then re-base from the movement the browser ACTUALLY made. A fractional
      // `scrollTop` is snapped to a layout unit, so `actual - delta` is not where the
      // row ends up; measuring the applied movement is.
      const applied = controller.nudge(delta);
      // The correction is a movement this component made, so the anchor must carry the
      // post-correction geometry. Leaving the pre-correction values there makes the
      // *next* commit read its own previous correction as "somebody else moved the
      // viewport" and re-apply the same delta — how the newest row ended up 8,000px away
      // from a view that believed it was following the tail.
      anchorRef.current = { key: anchor.key, offset: actual - applied, scrollTop: element.scrollTop };
    }
    /**
     * Re-capture unconditionally, sub-pixel deltas included (W4).
     *
     * `captureAnchor` re-reads the anchor from the live DOM, so after this call the
     * baseline always describes the geometry that is actually on screen. That is what
     * stops two consecutive commits that each measure a row 0.4px taller from
     * accumulating: the first one is applied (or absorbed) and the second starts from
     * the measured truth rather than from the height it saw last time.
     */
    captureAnchorRef.current?.(false);
    // No `setViewport` here on purpose: the window is carried by the force-mounted
    // anchor (`pinned`), and the new offset reaches the window through the scroller's
    // own scroll event. Publishing state from this effect instead makes the correction
    // its own trigger — React #185 — and the scroll event was already going to fire.
    recordCorrectionMetrics();
    /**
     * Why the window's bounds are dependencies even though this effect writes
     * `scrollTop`.
     *
     * They have to be: an expansion pushes the anchored row out of the mounted range, and
     * without a run on the new range the row stays unmounted and the reading position is
     * lost — measured as "the anchored row must stay mounted through an expansion"
     * failing in `PERF-SCROLL-04`.
     *
     * They are safe to be, now that the flex gap is part of the height model
     * (`buildOffsets`). The oscillation that produced React #185 was not this dependency
     * on its own: it was that `fitSpacersToGap` subtracted `(mounted - 1) * gap` at render
     * time, so every mounted row sat `k * gap` below its model offset for a `k` that
     * changed with the range. The correction therefore measured a fresh ~10px delta after
     * every window move — `+40, -20, +10, -10, +10, -10 …` on an anchor 21,600px from the
     * top — and re-armed itself. With the gap in the model, a window move changes no
     * geometry at all: `delta` is 0, nothing is written, and the effect terminates after
     * one pass. Measured: `PERF-STREAM-02` 6/6 clean with these dependencies in place.
     */
    // Depends on the entry array's identity rather than on a spacer sum: any change to
    // what is mounted, in any segment, is a candidate for a geometry correction.
    // `offsets` is a dependency because the missing-anchor branch corrects from the
    // model, not from a measured rect: without it that branch would run against the
    // offsets from before the expansion that unmounted the anchor.
  }, [scrollElement, windowed, controller, measureVersion, visible.start, visible.end, entries, offsets, indexOfKey]);

  /** One observer for every mounted entry: a measured height is cached by identity. */
  useEffect(() => {
    const nodes = elementsRef.current;
    if (typeof ResizeObserver === "undefined" || nodes.size === 0) return;
    let changed = false;
    const observer = new ResizeObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement;
        const key = target.dataset.entryKey;
        if (key === undefined) continue;
        const height = target.getBoundingClientRect().height;
        // A zero measurement is not a height, it is a row that has not laid out yet
        // (or has no box at all). Storing it marked the entry "measured" — which clears
        // `aria-busy` — while `estimateHeights` rejects `0` and keeps the neighbouring
        // estimate, so the two sides disagreed and the row was announced as measured
        // while rendering 0px tall. `<= 0` is ignored here for the same reason it is
        // rejected there.
        if (!(height > 0)) continue;
        // Sub-pixel differences are not a geometry change; ignoring them keeps a
        // resize from re-rendering the list on every animation frame of a transition.
        if (Math.abs((measuredRef.current.get(key) ?? -1) - height) < 0.5) continue;
        measuredRef.current.set(key, height);
        changed = true;
      }
      if (changed) { changed = false; setMeasureVersion((value) => value + 1); }
    });
    // A re-mounted entry starts unmeasured: `observed` is rebuilt from the DOM each
    // time the mounted set changes, so an entry that leaves the window and returns
    // is measured again rather than trusting a height taken before a font loaded.
    for (const node of nodes.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [visible.start, visible.end, entries]);

  /** Reveal a specific identity (search jump, jump-to-latest on an older hit). */
  useEffect(() => {
    if (apiRef === undefined) return;
    apiRef.current = {
      scrollToIdentity: (identity: string) => {
        jumpTokenRef.current += 1;
        revealRef.current = identity;
        setJump({ identity, token: jumpTokenRef.current });
      },
      clearReveal: () => {
        // Both halves or neither: the `jump` pin is what keeps the entry mounted, and a
        // cleared reveal with a live pin leaves a row force-mounted for no reason.
        revealRef.current = null;
        setJump(null);
      },
    };
    return () => { apiRef.current = null; };
  }, [apiRef]);

  useLayoutEffect(() => {
    const element = scrollElement?.current ?? null;
    if (element === null || jump === null) return;
    const index = indexOfKey.get(jump.identity) ?? indexOfKey.get(`group:${jump.identity}`);
    if (index === undefined) return;
    // The mounted slice is rebuilt around the target by the `pinned` set in this same
    // render, so `offset[index]` is exactly where the entry begins.
    // Land the entry at the TOP of the viewport, not at the raw offset: `offsets[index]`
    // is where the entry begins in the document, but the viewport also has the
    // scroller's own padding above it, so setting exactly that value leaves the entry
    // just under the fold. A reveal that mounts the row and puts it off-screen is a
    // reveal only in the DOM sense.
    const target = Math.max(0, (offsets[index] ?? 0) - ELEMENT_TOP_INSET_PX);
    controller.reveal(target);
    // The window is derived from `viewport`, which is updated by the scroll event —
    // and a programmatic `scrollTop` assignment does not reliably produce one before
    // this commit compounds. Setting it here as well means the mount and the scroll
    // position change together, so the entry is in the document on the same paint
    // that moves it there. Without this a jump lands in a spacer and the row it was
    // asked for is still unmounted.
    setViewport((previous) => (
      Math.abs(previous.top - target) < 0.5 && Math.abs(previous.height - element.clientHeight) < 0.5
        ? previous
        : { top: target, height: element.clientHeight }
    ));
    // The anchor is re-captured from the new position on the next scroll frame; a
    // stale one would pull the view back to where the search started.
    anchorRef.current = null;
    setJump(null);
  }, [jump, scrollElement, controller, indexOfKey, offsets]);

  const renderEntry = (entry: (typeof entries)[number], index: number): React.ReactNode => {
    const key = keys[index];
    if (key === undefined) return null;
    // A reveal that landed on a group is a reveal of a *row inside it*: the group is
    // only the document's wrapper, and a collapsed body would not contain the hit.
    const reveal = revealRef.current;
    const revealMemberId = entry.kind === "group" && reveal !== null && entry.group.rows.some((row) => row.id === reveal)
      ? reveal
      : undefined;
    const node = entry.kind === "row"
      ? <MessageRow message={entry.row} represented={represented} />
      : <ActivityGroupRow group={entry.group} pairedArgs={pairedArgs} onOpenFile={onOpenFile} revealMemberId={revealMemberId} />;
    if (!windowed) return <React.Fragment key={key}>{node}</React.Fragment>;
    return (
      <div
        key={key}
        data-entry-key={key}
        ref={(element) => {
          if (element === null) {
            elementsRef.current.delete(key);
            return;
          }
          // The wrapper is `display: contents`, so it has no box to measure — that is
          // exactly why it cannot disturb the transcript's flex spacing, and exactly
          // why the measured node is its first element child. Everything geometric
          // below (height, `getBoundingClientRect` for the anchor) reads this child.
          const measuredNode = element.firstElementChild ?? element;
          measuredNode.setAttribute("data-entry-key", key);
          /**
           * The role and the position live on the REAL BOX, not on this wrapper.
           *
           * Measured in Chromium's own accessibility tree
           * (`Accessibility.getFullAXTree`, `PERF-A11Y-01`): with `role="listitem"`,
           * `aria-setsize` and `aria-posinset` on a `display: contents` element, the
           * tree contained 37 `listitem` nodes and **every one of them exposed only
           * `level`** — the setsize and posinset were dropped, so a screen reader heard
           * a list with items that could not say "item 1999 of 2000". Setting them on
           * the child that actually has a box (the message card / activity group) makes
           * them part of the tree, which is what `PERF-A11Y-01` now asserts.
           */
          measuredNode.setAttribute("role", "listitem");
          // The truth about the whole conversation, not the mounted slice: the
          // announced total is the transcript's real length and the rank is the row's
          // real position, even when 1,985 of the rows are not in the document.
          measuredNode.setAttribute("aria-setsize", String(entries.length));
          measuredNode.setAttribute("aria-posinset", String(index + 1));
          elementsRef.current.set(key, measuredNode as HTMLElement);
        }}
        className="transcript-entry"
      >
        {node}
      </div>
    );
  };

  // `aria-busy` while the mounted rows are still being measured: the scroll position
  // is exact but the total height is still an estimate, and a screen reader asking
  // "how far down am I" during that window would be answered with a guess.
  let busy = false;
  if (windowed) {
    for (const segment of segments) {
      for (let index = segment.start; index < segment.end; index += 1) {
        const key = keys[index];
        if (key !== undefined && !measuredRef.current.has(key)) { busy = true; break; }
      }
      if (busy) break;
    }
  }

  if (!windowed) {
    return (
      <div className="transcript-entries" role="list">
        {entries.map((entry, index) => renderEntry(entry, index))}
      </div>
    );
  }

  /**
   * Segments rendered in document order, with the unmounted span before each as a
   * spacer. `cursor` tracks how far the DOM has been filled, so the spacer heights
   * are exact sums of the same `offsets` the window was computed from — the scroll
   * position and the document agree to the pixel even while distant rows are
   * estimated.
   */
  /**
   * Build the child list as *items*, then correct the spacer heights once.
   *
   * The flex `gap` between rendered siblings is real document height that no element
   * measurement contains (`.transcript-entries` is a flex column with a gap), so the
   * model under-counts by `(renderedItems - 1) * gap`. Collecting spacers first and
   * correcting them at the end keeps that arithmetic in one place instead of
   * scattered across two spacer creation sites.
   */
  type Item = { kind: "spacer"; key: string; height: number } | { kind: "node"; key: string; node: React.ReactNode };
  const items: Item[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const gap = (offsets[segment.start] ?? 0) - (offsets[cursor] ?? 0);
    /**
     * The FIRST spacer carries the scroller's leading inset as well as the unmounted
     * distance before the window.
     *
     * The model's offset 0 is "top of the first entry", while the DOM's offset 0 is "top
     * of the scrollport", and `.messages-content` puts `padding-top` between them. Only
     * the spacer that stands in for the beginning of the document can represent that, and
     * a spacer at the top of the content is exactly that position. Measured at the bottom
     * of a 2,000-row load: the content ended at 801 while the scrollport ended at 783 —
     * 18px = 10px inset + 8px of gap arithmetic, which made the newest row hang below the
     * edge and the jump-to-latest affordance appear.
     */
    const span = gap;
    if (span > 0) items.push({ kind: "spacer", key: `gap:${String(segment.start)}`, height: span });
    for (let index = segment.start; index < segment.end; index += 1) {
      const entry = entries[index];
      if (entry !== undefined) items.push({ kind: "node", key: keys[index] ?? String(index), node: renderEntry(entry, index) });
    }
    cursor = segment.end;
  }
  // The trailing span is everything after the last mounted entry. It is exactly the
  // remainder, because the window's `end` already includes the overscan below the
  // viewport — subtracting it again would shorten the document and make the scroll
  // range lie about where the conversation ends.
  // The trailing span comes from the same tested function the unit suite covers. It takes
  // the cursor as a ZERO-LENGTH window (`start === end`): `bottom` is then
  // `total - offsets[start]`, which is exactly the remainder after the last mounted
  // entry. Passing `end: entries.length` instead made `bottom` `total - total = 0`, and
  // the whole unmounted tail disappeared from the document (measured: 2,000-entry
  // transcript with `scrollHeight: 2158` and no spacers at all).
  const trailing = spacerHeights(offsets, { start: cursor, end: cursor }, gapPx).bottom;
  if (trailing > 0) items.push({ kind: "spacer", key: "gap:end", height: trailing });


  const content: React.ReactNode[] = items.map((item) => item.kind === "spacer"
    ? (item.height > 0 ? <div key={item.key} className="transcript-spacer" style={{ height: `${item.height}px` }} aria-hidden="true" /> : null)
    : <React.Fragment key={item.key}>{item.node}</React.Fragment>);

  return (
    <div className="transcript-entries" role="list" aria-busy={busy} ref={entriesRef}>
      {content}
    </div>
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
    // Three conditions, all required, before this request may be dropped:
    //  1. it has an `id` — the wire pairing key (`collab-protocol/src/types.ts:33`);
    //  2. a result row for that id is on screen, so the execution is still shown;
    //  3. its `arguments` are a record, so the paired tool card can actually carry
    //     them. `pairToolArguments` keeps only records (`tool-activity.ts:159`), so
    //     suppressing a request whose arguments are, say, an array would leave them
    //     unreachable at every disclosure level — a contract violation upstream
    //     still must not cost the reader the arguments.
    if (block.id !== undefined && represented?.has(block.id) && isRecord(block.arguments)) return null;
    return <details key={index}><summary>{`[Tool call: ${block.name}${block.intent ? ` — ${block.intent}` : ""}]`}</summary><pre style={{ overflowX: "auto" }}><code>{JSON.stringify(block.arguments, null, 2)}</code></pre></details>;
  }
  if (block.type === "image") return block.dataUrl ? <img key={index} src={block.dataUrl} alt="Attachment" style={{ maxWidth: "100%" }} /> : <p key={index}>{block.label}</p>;
  if (block.type === "notice") return <p key={index}>{block.text}</p>;
  return <React.Fragment key={index}>{renderMarkdown(block.text)}</React.Fragment>;
}
