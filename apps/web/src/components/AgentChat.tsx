/**
 * The agent-detail chat surface: one agent's own journal, rendered as a conversation.
 *
 * The view used to print the fetched bytes into a `<pre>`. That is not a transcript:
 * the bytes are native OMP JSONL whose first record is a fixed-width title slot and
 * whose second is the `session` header, so a raw dump opens with bookkeeping the
 * agent never said. This component renders the rows the parse layer
 * (`../agent-transcript.ts`) already built and keeps the bytes behind a Diagnostics
 * disclosure, so the raw view stays reachable without being the default reading.
 *
 * Three facts from the corpus shape the code:
 *
 *  - Servable subagent journals reach 6,690 rows / 52 MB, so the row window is
 *    mandatory, not an optimisation. Mounting the whole journal at once is the
 *    expensive-render case this surface exists to avoid.
 *  - `carry` is a *prefix of a record*, never a record. It is shown as a provisional
 *    line and never parsed — parsing it would emit a row for half a line and then the
 *    same record again, whole, on the next poll.
 *  - A record that fails to decode is counted, never silently dropped, and its count
 *    is stated. "Nothing rendered" and "nothing readable" are different facts and
 *    only one of them may be described as the agent saying nothing.
 */
import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranscriptMessage } from "../transcript.js";
import { TranscriptList, type DisplayMessage } from "./MessageRow.js";
import "../agent-chat.css";

/**
 * Rows mounted at the tail before the user asks for more.
 *
 * 100 is one screenful on a phone with room to scroll, and it is the unit the
 * "Show earlier" control prepends by, so the button never moves by an amount the
 * user cannot predict from its own label.
 */
const CHAT_WINDOW_INITIAL = 100;
const CHAT_WINDOW_STEP = 100;
/**
 * How close to the bottom counts as "watching the tail". Local to this component —
 * `ConversationView` has its own constant for its own scroller, and sharing one
 * name across two scrolling surfaces would only couple them.
 */
const CHAT_TAIL_THRESHOLD_PX = 80;

export interface AgentChatProps {
  /** Conversation rows, oldest first, already parsed and de-duplicated. */
  rows: TranscriptMessage[];
  /** Trailing partial record from the transport. Rendered, never parsed. */
  carry: string;
  /** Non-blank lines that were not decodable records. Stated, never hidden. */
  unreadableRecords: number;
  /** Whether any raw bytes arrived, which decides which empty state is true. */
  hasRawText: boolean;
  /** The raw bytes, for the Diagnostics disclosure only. */
  rawText: string;
  /** Why there is nothing to show, when the caller already knows. Wins over the guesses below. */
  emptyReason: string | null;
}

type TabId = "chat" | "activity" | "results";

const TABS: readonly { id: TabId; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "activity", label: "Activity" },
  { id: "results", label: "Results" },
];

/** First non-empty line, bounded: a row's worth of text, not a wall of it. */
function oneLine(text: string, limit = 160): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** One recorded tool result, in the session's own order. */
interface ActivityLine {
  id: string;
  toolName: string;
  /** `isError === true` is the only failure signal the row carries. */
  failed: boolean;
  outcome: string;
}

/** The completion payload a `yield` tool result carries, when the session has one. */
interface CompletionPayload {
  id: string;
  status: string | null;
  data: unknown;
  failed: boolean;
}

export function AgentChat({
  rows,
  carry,
  unreadableRecords,
  hasRawText,
  rawText,
  emptyReason,
}: AgentChatProps): React.ReactNode {
  const baseId = useId();
  const tabId = (id: TabId) => `${baseId}-tab-${id}`;
  const panelId = (id: TabId) => `${baseId}-panel-${id}`;

  const [tab, setTab] = useState<TabId>("chat");
  const [mounted, setMounted] = useState(CHAT_WINDOW_INITIAL);
  const [rawOpen, setRawOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
  const followTailRef = useRef(true);
  /** Chat's own scroll offset, kept across a tab switch so reading is not lost. */
  const chatScrollTopRef = useRef(0);
  /** The scroll height before a prepend, so the view can be held still across it. */
  const prependAnchorRef = useRef<{ top: number; height: number } | null>(null);
  /** Read inside effects that must not re-run merely because the tab changed. */
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const windowStart = Math.max(0, rows.length - mounted);
  const hiddenCount = windowStart;
  const visibleRows = useMemo(() => rows.slice(windowStart), [rows, windowStart]);
  /**
   * The reducer's rows are structurally what `TranscriptList` renders, but they are
   * mapped once per row set so the objects stay identical between renders — the
   * same reason `ConversationView` hoists its own mapping into a `useMemo`.
   */
  const displayRows = useMemo<DisplayMessage[]>(
    () => visibleRows.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.blocks ? { blocks: message.blocks } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolResult ? { toolResult: message.toolResult } : {}),
      ...(message.toolArgs ? { toolArgs: message.toolArgs } : {}),
      ...(message.customType ? { customType: message.customType } : {}),
      ...(message.customDetails === undefined ? {} : { customDetails: message.customDetails }),
      ...(message.isError ? { isError: true } : {}),
      ...(message.isRunning ? { isRunning: true } : {}),
    })),
    [visibleRows],
  );

  const activity = useMemo<ActivityLine[]>(
    () => rows
      .filter((row) => row.role === "tool")
      .map((row) => ({
        id: row.id,
        toolName: row.toolName ?? "tool",
        failed: row.isError === true,
        outcome: oneLine(row.text, 120),
      })),
    [rows],
  );

  const completion = useMemo<CompletionPayload | null>(() => {
    // Newest first: a session that yielded more than once is described by its last.
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.toolName !== "yield") continue;
      const details = row.toolResult?.details;
      if (typeof details !== "object" || details === null) continue;
      const record = details as { data?: unknown; status?: unknown };
      if (record.data === undefined) continue;
      return {
        id: row.id,
        status: typeof record.status === "string" ? record.status : null,
        data: record.data,
        failed: row.isError === true,
      };
    }
    return null;
  }, [rows]);

  /** True only when the caller has not already explained the emptiness. */
  const emptyNote = emptyReason !== null
    ? emptyReason
    : rows.length > 0 || unreadableRecords > 0
      ? null
      : !hasRawText
        ? "No transcript bytes have been received for this agent yet."
        : "This session contains no conversational records yet.";

  const updateTailLock = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nearTail = element.scrollHeight - element.clientHeight - element.scrollTop <= CHAT_TAIL_THRESHOLD_PX;
    followTailRef.current = nearTail;
    chatScrollTopRef.current = element.scrollTop;
  }, []);

  const showEarlier = useCallback(() => {
    const element = scrollRef.current;
    if (element) prependAnchorRef.current = { top: element.scrollTop, height: element.scrollHeight };
    setMounted((current) => current + CHAT_WINDOW_STEP);
  }, []);

  /**
   * Hold the reading position across a prepend.
   *
   * Earlier rows go in *above* the viewport, so every mounted row shifts down by the
   * added height. Restoring the raw old `scrollTop` would silently jump the user
   * forward by exactly the amount that was added; adding the height delta keeps the
   * row they were reading under their eyes.
   */
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    const element = scrollRef.current;
    if (!anchor || !element) return;
    element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
    chatScrollTopRef.current = element.scrollTop;
    prependAnchorRef.current = null;
  }, [mounted]);

  /**
   * Restore Chat's offset after a tab switch.
   *
   * The panel is hidden rather than unmounted precisely so its rows are not rebuilt,
   * but a hidden scroller reports no geometry, so the offset is kept here and put
   * back the moment the panel is shown again.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (tab === "chat" && !followTailRef.current) element.scrollTop = chatScrollTopRef.current;
  }, [tab]);

  /**
   * Follow the tail while the user is at the tail.
   *
   * Deliberately keyed on the rows and the carry only: a tab switch is not new
   * activity, and re-running here would drag a reader who scrolled up back down.
   */
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || tabRef.current !== "chat" || !followTailRef.current) return;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }, [displayRows, carry]);

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const order = TABS.map((entry) => entry.id);
    const index = order.indexOf(tab);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % order.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = order[next]!;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <div className="agent-chat">
      <div className="agent-chat-tabs" role="tablist" aria-label="Agent transcript views" onKeyDown={onTabKeyDown}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={tabId(entry.id)}
            aria-selected={tab === entry.id}
            aria-controls={panelId(entry.id)}
            tabIndex={tab === entry.id ? 0 : -1}
            ref={(node) => { tabRefs.current[entry.id] = node; }}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/* Chat stays mounted so a tab switch cannot rebuild its rows or lose its place. */}
      <div
        className="agent-chat-panel"
        role="tabpanel"
        id={panelId("chat")}
        aria-labelledby={tabId("chat")}
        hidden={tab !== "chat"}
      >
        <div className="agent-chat-scroll" ref={scrollRef} onScroll={updateTailLock}>
          {unreadableRecords > 0 ? (
            <p className="agent-chat-note" role="status">
              {unreadableRecords} record{unreadableRecords === 1 ? "" : "s"} in this session file could not be read.
              Everything below that could be read is shown.
            </p>
          ) : null}
          {emptyNote !== null ? <p className="agent-chat-empty" role="status">{emptyNote}</p> : null}
          {hiddenCount > 0 ? (
            <div className="agent-chat-earlier">
              <button type="button" onClick={showEarlier}>
                Show {Math.min(CHAT_WINDOW_STEP, hiddenCount)} earlier
              </button>
              <span>
                {hiddenCount} earlier {hiddenCount === 1 ? "record is" : "records are"} not shown.
              </span>
            </div>
          ) : null}
          {/* No `onOpenFile`: the agent-detail chat has no Files layer behind it, so
              an `edit` file row is deliberately a no-op here rather than opening a
              viewer that does not exist. `TranscriptList` defaults it to noop. */}
          <TranscriptList rows={displayRows} />
          {/* Provisional by construction: this is half a record. It is labelled and
              kept out of the row list so it can never be read as a committed message. */}
          {carry !== "" ? (
            <div className="agent-chat-carry" role="note">
              <span className="agent-chat-carry-label">streaming…</span>
              <span className="agent-chat-carry-text">{oneLine(carry)}</span>
            </div>
          ) : null}
        </div>
        {/* Mounted only while open: the raw string is the whole journal, up to 52 MB,
            and building its single text node for a reader who never opens this would
            be the most expensive thing on the screen. Closing it removes the node, so
            "the raw bytes are not in the default view" is true of the DOM, not just of
            what is painted. */}
        <details
          className="agent-chat-raw"
          onToggle={(event) => setRawOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>
            Raw session bytes (diagnostics) — this is the session file as written, including the
            fixed-width title slot and the <code>{'"session"'}</code> header, and it is not a transcript
          </summary>
          {rawOpen ? <pre className="agent-transcript"><code>{rawText}</code></pre> : null}
        </details>
      </div>

      {/* Activity stays mounted for the same reason Chat does — and for one more:
          an unmount/remount on every poll rebuilt this panel's memos and its whole
          DOM. `hidden` is the state, not absence, so `aria-controls` always names a
          panel that exists. */}
      <div
        className="agent-chat-panel"
        role="tabpanel"
        id={panelId("activity")}
        aria-labelledby={tabId("activity")}
        hidden={tab !== "activity"}
      >
        <p className="agent-chat-provenance" role="note">
          This timeline is the session's own records: one line per recorded tool result, in the
          order the session wrote them. No timing is shown because the records carry none here.
        </p>
        {activity.length === 0 ? (
          <p className="agent-chat-empty" role="status">
            This session's records contain no tool results.
          </p>
        ) : (
          <ol className="agent-chat-activity">
            {activity.map((entry) => (
              <li key={entry.id} className={entry.failed ? "agent-chat-activity-line failed" : "agent-chat-activity-line"}>
                <span className="agent-chat-activity-name">{entry.toolName}</span>
                {/* The row's own boolean is the whole claim: false means "not reported as
                    failed", which is not the same as proven success. */}
                <span className="agent-chat-activity-state">
                  {entry.failed ? "failed" : "not reported as failed"}
                </span>
                {entry.outcome !== "" ? <span className="agent-chat-activity-outcome">{entry.outcome}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      <div
        className="agent-chat-panel"
        role="tabpanel"
        id={panelId("results")}
        aria-labelledby={tabId("results")}
        hidden={tab !== "results"}
      >
        {completion === null ? (
          <p className="agent-chat-empty" role="status">
            This session recorded no completion payload.
          </p>
        ) : (
          <>
            <p className="agent-chat-provenance" role="note">
              The completion payload this session's own <code>yield</code> result carried
              {completion.status === null ? "" : ` (status: ${completion.status})`}
              {completion.failed ? ", reported as an error" : ""}.
            </p>
            <pre className="agent-chat-result"><code>{JSON.stringify(completion.data, null, 2)}</code></pre>
          </>
        )}
      </div>
    </div>
  );
}
