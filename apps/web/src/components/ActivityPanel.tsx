import { useState, useEffect } from "react";
import type { ConversationEvent } from "@caw/contracts";
import { api } from "../api.js";

export interface ActivityPanelProps {
  conversationId?: string;
  events?: ConversationEvent[];
  nextAfter?: number | null;
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
  nextAfter: initialNextAfter = null,
  onClose,
}: ActivityPanelProps) {
  const [events, setEvents] = useState<ConversationEvent[]>(initialEvents ?? []);
  const [nextAfter, setNextAfter] = useState<number | null>(initialNextAfter);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (initialEvents !== undefined) {
      setEvents(initialEvents);
      return;
    }
    if (!conversationId) return;

    setLoading(true);
    api.getConversationEvents(conversationId).then((res) => {
      setLoading(false);
      if (res.ok) {
        setEvents(res.data.events);
        setNextAfter(res.data.nextAfter);
      }
    });
  }, [conversationId, initialEvents]);

  const handleLoadMore = async () => {
    if (!conversationId || nextAfter === null || loadingMore) return;
    setLoadingMore(true);
    const res = await api.getConversationEvents(conversationId, { after: nextAfter });
    setLoadingMore(false);
    if (res.ok) {
      setEvents((prev) => [...prev, ...res.data.events]);
      setNextAfter(res.data.nextAfter);
    }
  };

  const sortedEvents = [...events].sort((a, b) => b.seq - a.seq);

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-label="Activity timeline"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
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
          <h3 style={{ fontSize: "1.05rem", margin: 0 }}>Activity Timeline</h3>
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
          {loading && events.length === 0 && (
            <div role="status" style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)" }}>
              Loading activity…
            </div>
          )}

          {!loading && events.length === 0 && (
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
              {event.payload !== null && event.payload !== undefined && (
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

          {nextAfter !== null && (
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
    </div>
  );
}
