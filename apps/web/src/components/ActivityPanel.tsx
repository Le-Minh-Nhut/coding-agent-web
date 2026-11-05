import { useState, useEffect, useRef } from "react";
import type { ConversationEvent } from "@caw/contracts";
import { api } from "../api.js";
import { ModalOverlay } from "./ModalOverlay.js";
import { describeActivityEvent } from "./activity-event.js";

export interface ActivityPanelProps {
  conversationId?: string;
  events?: ConversationEvent[];
  nextBefore?: number | null;
  onClose?: () => void;
}

/**
 * Kept exported from this module's path because tests import it here; the
 * implementation lives with the rest of the event vocabulary.
 */
export { humanizeEventType } from "./activity-event.js";

/**
 * The raw payload, mounted only while its disclosure is open.
 *
 * React mounts a `<details>`'s children whether or not it is open — only the
 * browser hides them — so rendering `JSON.stringify(payload)` inline meant every
 * row in the list held its full JSON in the DOM while showing none of it. On a
 * long timeline that is megabytes of text nodes and a second serialization per
 * render, for content the reader has not asked to see. The `open` flag is local
 * per row, and `onToggle` keeps it true only while the element really is open
 * (including a browser-forced close), so a collapsed row costs one `<summary>`.
 */
function ActivityRawEvent({ seq, payload, hasPayload }: { seq: number; payload: unknown; hasPayload: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="activity-raw" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Raw event <span className="activity-seq">#{seq}</span></summary>
      {open && (hasPayload ? (
        typeof payload === "object" ? (
          <pre className="activity-raw-body"><code>{JSON.stringify(payload, null, 2)}</code></pre>
        ) : (
          <p className="activity-raw-body">{String(payload)}</p>
        )
      ) : (
        <p className="activity-raw-body">No payload recorded.</p>
      ))}
    </details>
  );
}

export function ActivityPanel({
  conversationId,
  events: initialEvents,
  nextBefore: initialNextBefore = null,
  onClose,
}: ActivityPanelProps) {
  const [events, setEvents] = useState<ConversationEvent[]>(initialEvents ?? []);
  const [nextBefore, setNextBefore] = useState<number | null>(initialNextBefore);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The two entry points each own their own in-flight flag, so which response may
   * release it is decided per entry point: a tail reload must not clear the spinner a
   * NEWER tail reload still owns (ACTIVITY-01), and neither must a backward page.
   */
  const tailGenerationRef = useRef(0);
  const pageGenerationRef = useRef(0);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // V23-02: open on the TAIL — no cursor means the newest page, and "Load older"
  // walks backwards with `before`, so the newest events are visible immediately.
  // B6: Retry is a tail RESTART by design — it reloads the newest page and
  // intentionally discards any older pages already walked (the shared error is
  // recovered by re-reading the newest truth, not by resuming a broken walk).
  const loadEvents = async () => {
    if (!conversationId) return;
    const id = conversationId;
    // The flag is owned by the newest TAIL read, so an older tail read landing late
    // cannot clear the spinner the user is waiting on (ACTIVITY-01), while the newest
    // tail read always releases it — which is what keeps `loading` from wedging.
    const tail = ++tailGenerationRef.current;
    setLoading(true);
    setError(null);
    const res = await api.getConversationEvents(id);
    if (tailGenerationRef.current === tail) setLoading(false);
    if (conversationIdRef.current !== id || tailGenerationRef.current !== tail) return;
    if (res.ok) {
      setEvents((prev) => [...new Map([...prev, ...res.data.events].map((event) => [event.seq, event])).values()]);
      const next = res.data.nextBefore ?? null;
      setNextBefore((prev) => (prev === null || next === null ? next : Math.min(prev, next)));
    } else setError(res.error.message || "Could not load activity.");
  };

  useEffect(() => {
    conversationIdRef.current = conversationId;
    // F-B2: a new conversation starts blank. Anything already in flight for the
    // previous one is superseded here and dropped on landing.
    // This effect is taking over the panel's state, so it also takes over the tail
    // flag from whatever tail read it just superseded: an abandoned read can no
    // longer release it (that is the point of the ownership check in loadEvents), so
    // the effect releases it here. Without this the `initialEvents` path below —
    // which starts no replacement read — would leave `loading` true forever and
    // Retry disabled, exactly the wedge the old unconditional release guarded.
    tailGenerationRef.current += 1;
    setLoading(false);
    // Same hand-off for the backward page: its flag is owned by the newest page
    // read, so abandoning one here would otherwise leave `loadingMore` true on the
    // new conversation (Load older disabled, and handleLoadMore early-returns)
    // until the abandoned read lands — or forever, if it never does.
    pageGenerationRef.current += 1;
    setLoadingMore(false);
    if (initialEvents !== undefined) {
      setEvents(initialEvents);
      setNextBefore(initialNextBefore);
      return;
    }
    setEvents([]);
    setNextBefore(null);
    setError(null);
    void loadEvents();
  }, [conversationId, initialEvents]);

  const handleLoadMore = async () => {
    if (!conversationId || nextBefore === null || loadingMore) return;
    const id = conversationId;
    const cursor = nextBefore;
    const page = ++pageGenerationRef.current;
    setLoadingMore(true);
    setError(null);
    const res = await api.getConversationEvents(id, { before: cursor });
    if (pageGenerationRef.current === page) setLoadingMore(false);
    if (conversationIdRef.current !== id || pageGenerationRef.current !== page) return;
    if (res.ok) {
      setEvents((prev) => [...new Map([...res.data.events, ...prev].map((event) => [event.seq, event])).values()]);
      setNextBefore(res.data.nextBefore ?? null);
    } else setError(res.error.message || "Could not load more activity.");
  };

  const sortedEvents = [...events].sort((a, b) => b.seq - a.seq);

  return (
    <ModalOverlay
      onClose={onClose ?? (() => {})}
      aria-labelledby="activity-panel-title"
      overlayProps={{
        className: "modal-overlay",
        onClick: (e) => {
          if (e.target === e.currentTarget) onClose?.();
        },
      }}
    >
      <div
        className="modal-content"
        style={{
          maxWidth: "480px",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          padding: "16px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingBottom: "10px",
            borderBottom: "1px solid var(--border)",
            marginBottom: "8px",
          }}
        >
          <h3 id="activity-panel-title" style={{ fontSize: "1.05rem", margin: 0 }}>Activity Timeline</h3>
          {onClose && (
            <button
              type="button"
              className="ghost"
              onClick={onClose}
              aria-label="Close activity timeline"
              style={{ padding: "4px 8px" }}
            >
              ✕
            </button>
          )}
        </div>

        <div style={{ overflowY: "auto", flex: 1, paddingRight: "4px" }}>
          {error && <div role="alert" style={{ padding: "10px", color: "var(--danger-text)" }}>{error} <button type="button" onClick={() => void loadEvents()} disabled={loading}>Retry</button></div>}
          {loading && events.length === 0 && (
            <div role="status" style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>
              Loading activity…
            </div>
          )}

          {!loading && !error && events.length === 0 && (
            <div role="status" style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>
              No activity recorded for this conversation yet.
            </div>
          )}

          {sortedEvents.map((event, index) => {
            const described = describeActivityEvent(event);
            // A date heading only when the day actually changes, derived from `ts`
            // and never invented: the rows are already in seq order, and the label
            // is the row's own timestamp day.
            const day = new Date(event.ts).toDateString();
            const previousDay = index === 0 ? null : new Date(sortedEvents[index - 1]!.ts).toDateString();
            const hasPayload = event.payload !== null && event.payload !== undefined
              && (typeof event.payload !== "object" || Object.keys(event.payload as object).length > 0);
            return (
              <div key={event.seq}>
                {day !== previousDay && <h3 className="activity-date-heading">{day === new Date().toDateString() ? "Today" : new Date(event.ts).toLocaleDateString()}</h3>}
                <div className={`activity-item activity-item--${described.tone}${described.debugOnly ? " activity-item--internal" : ""}`}>
                  <div className="activity-head">
                    <span className="activity-label">{described.label}</span>
                    <time className="activity-time" dateTime={event.ts}>{new Date(event.ts).toLocaleString()}</time>
                  </div>
                  {described.detail !== null && <p className="activity-detail">{described.detail}</p>}
                  {/* The raw record stays reachable, but behind a disclosure: the
                      row's job is the meaning, and the payload is evidence for the
                      rare case the meaning is not enough. */}
                  <ActivityRawEvent seq={event.seq} payload={event.payload} hasPayload={hasPayload} />
                </div>
              </div>
            );
          })}

          {nextBefore !== null && (
            <div style={{ padding: "12px 0", textAlign: "center" }}>
              <button
                type="button"
                className="ghost"
                onClick={handleLoadMore}
                disabled={loadingMore}
                style={{ width: "100%", justifyContent: "center" }}
              >
                {loadingMore ? "Loading…" : "Load older activity"}
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
