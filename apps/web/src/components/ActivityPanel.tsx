import { useState, useEffect, useRef } from "react";
import type { ConversationEvent } from "@caw/contracts";
import { api } from "../api.js";
import { ModalOverlay } from "./ModalOverlay.js";

export interface ActivityPanelProps {
  conversationId?: string;
  events?: ConversationEvent[];
  nextBefore?: number | null;
  onClose?: () => void;
}

export function humanizeEventType(type: string): string {
  switch (type) {
    case "launch.refused":
      return "Launch Refused";
    case "agent.launched":
      return "Agent Launched";
    case "agent.hosted":
      return "Agent Collab Hosted";
    case "agent.exited":
      return "Agent Exited";
    case "agent.stop_requested":
      return "Stop Requested";
    case "agent.stopped":
      return "Agent Stopped";
    case "agent.stop_timeout":
      return "Stop Timed Out";
    case "agent.publish_timeout":
      return "Publish Timed Out";
    default:
      return (
        type
          .split(/[._-]/)
          .filter((w) => w.length > 0)
          .map((w) => w[0]!.toUpperCase() + w.slice(1))
          .join(" ") || type
      );
  }
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
   * F-B1/F-B2: every read (tail reload and backward page) takes the next
   * generation, and it may only touch the panel while it is still the newest
   * read *and* still the same conversation. A disposition-less "in flight" flag
   * is not enough: a tail reload that started first but lands last used to replace
   * the rows a backward page had just prepended, silently dropping the seq range
   * between the two windows and leaving the cursor unable to reach it. A late read
   * for a previous conversation is dropped the same way.
   */
  const readGenerationRef = useRef(0);
  /**
   * The two entry points each own their own in-flight flag, so which response may
   * release it is decided per entry point: a tail reload must not clear the spinner a
   * NEWER tail reload still owns (ACTIVITY-01), and neither must a backward page.
   * The shared `readGenerationRef` above stays the payload/ordering guard across both
   * entry points; these two only decide flag ownership.
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
    const generation = ++readGenerationRef.current;
    // The flag is owned by the newest TAIL read, so an older tail read landing late
    // cannot clear the spinner the user is waiting on (ACTIVITY-01), while the newest
    // tail read always releases it — which is what keeps `loading` from wedging.
    const tail = ++tailGenerationRef.current;
    setLoading(true);
    setError(null);
    const res = await api.getConversationEvents(id);
    if (tailGenerationRef.current === tail) setLoading(false);
    if (conversationIdRef.current !== id || readGenerationRef.current !== generation) return;
    if (res.ok) {
      setEvents(res.data.events);
      setNextBefore(res.data.nextBefore ?? null);
    } else setError(res.error.message || "Could not load activity.");
  };

  useEffect(() => {
    conversationIdRef.current = conversationId;
    // F-B2: a new conversation starts blank. Anything already in flight for the
    // previous one is superseded here and dropped on landing.
    readGenerationRef.current += 1;
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
    const generation = ++readGenerationRef.current;
    const page = ++pageGenerationRef.current;
    setLoadingMore(true);
    setError(null);
    const res = await api.getConversationEvents(id, { before: cursor });
    if (pageGenerationRef.current === page) setLoadingMore(false);
    if (conversationIdRef.current !== id || readGenerationRef.current !== generation) return;
    if (res.ok) {
      setEvents((prev) => [...res.data.events, ...prev]);
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

          {sortedEvents.map((event) => (
            <div
              key={event.seq}
              className="activity-item"
              style={{
                padding: "10px 0",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                  {humanizeEventType(event.type)}
                </span>
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  #{event.seq}
                </span>
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                {new Date(event.ts).toLocaleString()}
              </div>
              {event.payload !== null && event.payload !== undefined && (typeof event.payload !== "object" || Object.keys(event.payload as object).length > 0) && (
                <div style={{ marginTop: "4px" }}>
                  {typeof event.payload === "object" ? (
                    <pre
                      style={{
                        fontSize: "0.75rem",
                        padding: "6px 8px",
                        backgroundColor: "var(--surface-alt)",
                        borderRadius: "4px",
                        overflowX: "auto",
                        margin: 0,
                      }}
                    >
                      <code>{JSON.stringify(event.payload, null, 2)}</code>
                    </pre>
                  ) : (
                    <span style={{ fontSize: "0.8rem" }}>{String(event.payload)}</span>
                  )}
                </div>
              )}
            </div>
          ))}

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
