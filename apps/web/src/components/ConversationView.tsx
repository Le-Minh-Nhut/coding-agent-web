import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../api.js";
import { renderMarkdown } from "../sanitize.js";
import { SubagentPanel } from "./SubagentPanel.js";
import { ActivityPanel } from "./ActivityPanel.js";
import {
  CollabSocket,
  parseCollabLink,
  importRoomKey,
  type AgentSnapshot,
  type CollabUiRequest,
  type HostFrame,
  type SessionEntry,
} from "@caw/collab-protocol";
import type { AttachInstructions, Conversation } from "@caw/contracts";

interface ConversationViewProps {
  conversationId: string;
  onBack: () => void;
}

interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  isError?: boolean;
}

export type ConnectionStatus = "connecting" | "idle" | "running" | "reconnecting" | "disconnected" | "unknown";

export function ConversationView({ conversationId, onBack }: ConversationViewProps) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streamingText, setStreamingText] = useState<string>("");
  const [inputText, setInputText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [attachInfo, setAttachInfo] = useState<AttachInstructions | null>(null);
  const [linkUnavailable, setLinkUnavailable] = useState(false);
  const [modelDraft, setModelDraft] = useState("");
  const [modelMessage, setModelMessage] = useState("");
  const [modelBusy, setModelBusy] = useState(false);

  // Subagents
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [showSubagents, setShowSubagents] = useState(false);
  const [transcripts, setTranscripts] = useState<Record<string, string>>({});

  // Activity Timeline
  const [showActivity, setShowActivity] = useState(false);

  // UI Request (Approvals) & FIFO Queue
  const [uiRequests, setUiRequests] = useState<{
    current: CollabUiRequest | null;
    queue: CollabUiRequest[];
  }>({ current: null, queue: [] });
  const [uiRequestTimedOut, setUiRequestTimedOut] = useState(false);
  const settledReqIdsRef = useRef<Set<number>>(new Set());

  const activeUiRequest = uiRequests.current;
  const uiRequestQueue = uiRequests.queue;

  // Hold socket & bearer credentials in React ref/closure ONLY
  const socketRef = useRef<CollabSocket | null>(null);
  const rawUrlRef = useRef<string | null>(null);
  const reqIdCounterRef = useRef<number>(1);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll messages
  useEffect(() => {
    if (typeof messagesEndRef.current?.scrollIntoView === "function") {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, streamingText]);

  // Load conversation metadata & attach instructions
  useEffect(() => {
    api.getConversation(conversationId).then((res) => {
      if (res.ok) {
        setConversation(res.data);
        setModelDraft(res.data.modelPreference ?? res.data.model ?? "");
      }
    });
    api.getAttachInstructions(conversationId).then((res) => {
      if (res.ok) setAttachInfo(res.data);
    });
  }, [conversationId]);

  /**
   * Latest frame handler, held in a ref.
   *
   * The connection effect must not depend on a callback that changes when state
   * changes: `connectToCollab` would be recreated on every render, the effect would
   * re-run, and each re-run closes the socket and opens a new one. That produced a
   * hot reconnect loop — 44 sockets in 9 seconds, each accepted by the relay and
   * dropped before a welcome could arrive — instead of a live session.
   */
  const handleHostFrameRef = useRef<(frame: HostFrame) => void>(() => {});

  const handleHostFrame = useCallback((frame: HostFrame) => {
    switch (frame.t) {
      case "welcome":
        setStatus(frame.state.busy ? "running" : "idle");
        if (frame.agents) setAgents(frame.agents);
        break;

      case "state":
        setStatus(frame.state.busy ? "running" : "idle");
        break;

      case "entry": {
        const entry: SessionEntry = frame.entry;
        if (entry.type === "message") {
          const msg = entry.message;
          if (msg.role === "user") {
            const userText = typeof msg.content === "string"
              ? msg.content
              : msg.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
            setMessages((prev) => [
              ...prev,
              { id: entry.id, role: "user", text: userText },
            ]);
          } else if (msg.role === "assistant") {
            const textParts = msg.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { text: string }).text)
              .join("\n");
            setMessages((prev) => [
              ...prev,
              { id: entry.id, role: "assistant", text: textParts },
            ]);
            setStreamingText("");
          } else if (msg.role === "tool") {
            const resultStr = typeof msg.result === "string" ? msg.result : JSON.stringify(msg.result, null, 2);
            setMessages((prev) => [
              ...prev,
              { id: entry.id, role: "tool", text: resultStr, isError: msg.isError },
            ]);
          }
        }
        break;
      }

      case "event": {
        const ev = frame.event;
        if (ev.type === "turn_start" || ev.type === "agent_start") {
          setStatus("running");
        } else if (ev.type === "turn_end" || ev.type === "agent_end") {
          setStatus("idle");
          setIsSending(false);
        } else if (ev.type === "message_update") {
          if (ev.message.role === "assistant") {
            const text = ev.message.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { text: string }).text)
              .join("");
            setStreamingText(text);
          }
        } else if (ev.type === "message_end") {
          if (ev.message.role === "assistant") {
            const text = ev.message.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { text: string }).text)
              .join("");
            if (text) {
              setMessages((prev) => [
                ...prev,
                { id: `assistant-${Date.now()}`, role: "assistant", text },
              ]);
            }
            setStreamingText("");
          }
        } else if (ev.type === "tool_execution_start") {
          // Tool start
        } else if (ev.type === "tool_execution_end") {
          const resText = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result, null, 2);
          setMessages((prev) => [
            ...prev,
            { id: `tool-${ev.toolCallId}`, role: "tool", text: resText, toolName: ev.toolName, isError: ev.isError },
          ]);
        }
        break;
      }

      case "agents":
        setAgents(frame.agents);
        break;

      case "ui-request":
        setUiRequests((prev) => {
          if (!prev.current) {
            return { current: frame.request, queue: [] };
          }
          return { current: prev.current, queue: [...prev.queue, frame.request] };
        });
        setUiRequestTimedOut(false);
        break;

      case "ui-request-end":
        settledReqIdsRef.current.add(frame.reqId);
        setUiRequests((prev) => {
          if (prev.current?.reqId === frame.reqId) {
            const [next, ...rest] = prev.queue;
            return { current: next ?? null, queue: rest };
          }
          return {
            current: prev.current,
            queue: prev.queue.filter((r) => r.reqId !== frame.reqId),
          };
        });
        setUiRequestTimedOut(true);
        break;

      case "transcript":
        if (frame.text) {
          const text = frame.text;
          setTranscripts((prev) => {
            const updated = { ...prev };
            for (let i = 0; i < agents.length; i++) {
              const a = agents[i]!;
              if (!updated[a.id]) {
                updated[a.id] = text;
                break;
              }
            }
            return updated;
          });
        }
        break;

      case "error":
        setStatus("unknown");
        break;

      case "bye":
        setStatus("disconnected");
        break;
    }
  }, [agents]);

  // Point the ref at the current handler after every render, so the socket path can
  // read it without listing it as a dependency.
  useEffect(() => {
    handleHostFrameRef.current = handleHostFrame;
  }, [handleHostFrame]);

  // Connect to collab relay
  const connectToCollab = useCallback(async (retryStale = true) => {
    const linkRes = await api.getConversationLink(conversationId);
    if (!linkRes.ok) {
      if (linkRes.error.code === "link_unavailable") {
        setLinkUnavailable(true);
        setStatus("unknown");
        return;
      }
      if (linkRes.error.code === "stale_generation" && retryStale) {
        connectToCollab(false);
        return;
      }
      setStatus("disconnected");
      return;
    }

    setLinkUnavailable(false);
    rawUrlRef.current = linkRes.data.url;

    const parsed = parseCollabLink(rawUrlRef.current);
    if ("error" in parsed) {
      setStatus("disconnected");
      return;
    }

    try {
      const { key, writeToken } = await importRoomKey(parsed.key);
      const socket = new CollabSocket({
        wsUrl: parsed.wsUrl,
        role: "guest",
        key,
      });

      socket.onOpen = () => {
        setStatus("idle");
        socket.send({
          t: "hello",
          proto: 3,
          name: "Mobile Web Controller",
          writeToken,
        });
      };

      socket.onFrame = (frame) => {
        handleHostFrameRef.current(frame);
      };

      socket.onClose = (_reason, willReconnect) => {
        setStatus(willReconnect ? "reconnecting" : "disconnected");
      };

      socketRef.current = socket;
      socket.connect();
    } catch {
      setStatus("disconnected");
    }
  }, [conversationId]);

  useEffect(() => {
    connectToCollab(true);

    return () => {
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
      rawUrlRef.current = null;
    };
  }, [connectToCollab]);

  // Send prompt with idempotency key
  const handleSendPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputText.trim();
    if (!text || isSending || !socketRef.current) return;

    setIsSending(true);
    const idempotencyKey = crypto.randomUUID();

    // Optimistically render user message
    setMessages((prev) => [
      ...prev,
      { id: `user-${idempotencyKey}`, role: "user", text },
    ]);
    setInputText("");

    socketRef.current.send({
      t: "prompt",
      text,
      idempotencyKey,
    });
  };

  // Send stop / abort
  const handleStop = () => {
    if (socketRef.current) {
      socketRef.current.send({ t: "abort" });
    }
    setIsSending(false);
  };

  const handleSaveModel = async () => {
    setModelBusy(true);
    setModelMessage("");
    const result = await api.setConversationModel(conversationId, modelDraft);
    setModelBusy(false);
    setModelMessage(result.ok ? "Model saved for next launch." : result.error.message);
    if (result.ok) setConversation(result.data);
  };

  const handleRestart = async () => {
    setModelBusy(true);
    setModelMessage("");
    const saved = await api.setConversationModel(conversationId, modelDraft);
    if (!saved.ok) {
      setModelBusy(false);
      setModelMessage(saved.error.message);
      return;
    }
    setConversation(saved.data);
    const result = await api.restartConversation(conversationId);
    setModelBusy(false);
    if (result.ok) {
      setConversation(result.data);
      setModelDraft(result.data.modelPreference ?? result.data.model ?? "");
      setModelMessage("Agent restarted.");
      socketRef.current?.close();
      socketRef.current = null;
      await connectToCollab(true);
    } else setModelMessage(result.error.message);
  };

  // Answer UI approval
  const handleUiResponse = (value: string | undefined, reqId?: number) => {
    const targetReqId = reqId ?? activeUiRequest?.reqId;
    if (targetReqId === undefined || !socketRef.current) return;

    // Latch: exactly one response per reqId; never answer a settled request
    if (settledReqIdsRef.current.has(targetReqId)) return;
    settledReqIdsRef.current.add(targetReqId);

    socketRef.current.send({
      t: "ui-response",
      reqId: targetReqId,
      value,
    });

    setUiRequestTimedOut(false);
    setUiRequests((prev) => {
      if (prev.current?.reqId === targetReqId) {
        const [next, ...rest] = prev.queue;
        return { current: next ?? null, queue: rest };
      }
      return {
        current: prev.current,
        queue: prev.queue.filter((r) => r.reqId !== targetReqId),
      };
    });
  };

  // Fetch subagent transcript
  const handleFetchTranscript = (agentId: string) => {
    if (!socketRef.current) return;
    const reqId = reqIdCounterRef.current++;
    socketRef.current.send({
      t: "fetch-transcript",
      reqId,
      agentId,
      fromByte: 0,
    });
  };

  return (
    <div className="conversation-screen">
      {/* Header */}
      <div className="app-header">
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button type="button" className="ghost" onClick={onBack} title="Back">
            ←
          </button>
          <div>
            <h3 style={{ fontSize: "1rem" }}>{conversation?.title ?? "Conversation"}</h3>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
              Effective model: {conversation?.model ?? "not reported"}
            </span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <button
            type="button"
            className="ghost"
            style={{ fontSize: "0.85rem" }}
            onClick={() => setShowActivity(true)}
          >
            Activity
          </button>
          {agents.length > 0 && (
            <button
              type="button"
              className="ghost"
              style={{ fontSize: "0.85rem" }}
              onClick={() => setShowSubagents(true)}
            >
              Agents ({agents.length})
            </button>
          )}
          {status === "running" && (
            <button type="button" className="danger" onClick={handleStop} style={{ padding: "4px 10px", fontSize: "0.85rem" }}>
              Stop
            </button>
          )}
        </div>
      </div>
      <section className="model-controls" aria-label="Conversation model">
        <label htmlFor="conversation-model">Model</label>
        <input
          id="conversation-model"
          value={modelDraft}
          maxLength={128}
          onChange={(event) => setModelDraft(event.target.value)}
          placeholder="Enter OMP model"
          aria-describedby="model-launch-note"
        />
        <button type="button" onClick={handleSaveModel} disabled={modelBusy || !modelDraft.trim()}>
          Save model
        </button>
        <button type="button" className="ghost" onClick={handleRestart} disabled={modelBusy || !modelDraft.trim()}>
          Save &amp; restart agent
        </button>
        <span id="model-launch-note">Model changes apply on the next launch of this conversation, not immediately.</span>
        {modelMessage && <span role="status">{modelMessage}</span>}
      </section>

      {/* Accessible Status Banners */}
      {status === "disconnected" && (
        <div className="banner disconnected" role="status">
          <span>Disconnected — Connection lost</span>
          <button type="button" className="ghost" style={{ padding: "2px 8px", fontSize: "0.8rem", color: "#ffffff" }} onClick={() => connectToCollab(true)}>
            Retry
          </button>
        </div>
      )}
      {status === "reconnecting" && (
        <div className="banner reconnecting" role="status">
          <span>Reconnecting… Attempting to re-establish live session</span>
        </div>
      )}
      {status === "unknown" && (
        <div className="banner unknown" role="status">
          <span>State: unknown — Agent status cannot be determined</span>
        </div>
      )}
      {status === "idle" && (
        <div className="banner idle" role="status">
          <span>Connected — no turn in flight</span>
        </div>
      )}
      {status === "running" && (
        <div className="banner running" role="status">
          <span>Agent is working on a turn</span>
        </div>
      )}
      {status === "connecting" && (
        <div className="banner connecting" role="status">
          <span>Connecting to the agent…</span>
        </div>
      )}

      {/* Messages area */}
      <div className="messages-scroll">
        {/* Honest link_unavailable / Attach instructions card */}
        {linkUnavailable && (
          <div className="card" style={{ borderColor: "var(--warning)", backgroundColor: "#1e180d" }}>
            <h4 style={{ color: "var(--warning)", marginBottom: "8px" }}>No live agent to attach to</h4>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", marginBottom: "12px" }}>
              There is currently no active host agent process running for this conversation. You can launch or attach to the agent via tmux on your host machine.
            </p>
            {attachInfo?.command ? (
              <div>
                <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>How to attach in terminal:</span>
                <pre><code>{attachInfo.command}</code></pre>
              </div>
            ) : (
              <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                Run <code>omp session list</code> on host machine to view active sessions.
              </p>
            )}
          </div>
        )}

        {/* A brand-new conversation has nothing to show, which reads as a broken
            screen. Say what the session actually is instead of leaving a void.
            Deliberately NOT role="status": the status banners above are the single
            live region for connection state, and a second one advertising the same
            state makes assistive tech (and any test filtering by role) ambiguous. */}
        {messages.length === 0 && !streamingText && !linkUnavailable && (
          <div className="empty-transcript">
            {status === "idle" && (
              <>
                <p>Connected to this conversation&apos;s agent.</p>
                <p>No prompts yet. Send one below to start the turn.</p>
              </>
            )}
            {status === "running" && <p>The agent is working. Output appears here as it streams.</p>}
            {status === "connecting" && <p>Contacting the agent…</p>}
            {(status === "reconnecting" || status === "disconnected") && (
              <p>The live transcript is unavailable while the connection is down.</p>
            )}
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`message-card ${msg.role}`}>
            <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "4px", textTransform: "capitalize" }}>
              {msg.role} {msg.toolName ? `(${msg.toolName})` : ""}
            </div>
            {msg.role === "tool" ? (
              <details>
                <summary>{msg.toolName ?? "Tool Result"} {msg.isError ? "(Error)" : ""}</summary>
                <pre><code>{msg.text}</code></pre>
              </details>
            ) : (
              <div>{renderMarkdown(msg.text)}</div>
            )}
          </div>
        ))}

        {/* Streaming assistant message */}
        {streamingText && (
          <div className="message-card assistant">
            <div style={{ fontSize: "0.75rem", color: "var(--primary)", marginBottom: "4px" }}>
              Assistant (streaming…)
            </div>
            <div>{renderMarkdown(streamingText)}</div>
          </div>
        )}

        {/* UI Request / Host Approval */}
        {activeUiRequest && (
          <div className="card" style={{ borderColor: "var(--primary)", backgroundColor: "rgba(47,129,247,0.1)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <h4 style={{ margin: 0, color: "var(--primary)" }}>Approval Requested</h4>
              {uiRequestQueue.length > 0 && (
                <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  +{uiRequestQueue.length} queued
                </span>
              )}
            </div>
            <p style={{ marginBottom: "12px", fontSize: "0.95rem" }}>{activeUiRequest.prompt}</p>

            {activeUiRequest.type === "select" && activeUiRequest.options && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                {activeUiRequest.options.map((opt) => {
                  const label = typeof opt === "string" ? opt : opt.label;
                  return (
                    <button
                      key={label}
                      type="button"
                      className="primary"
                      onClick={() => handleUiResponse(label, activeUiRequest.reqId)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            )}

            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className="primary"
                onClick={() => handleUiResponse("approve", activeUiRequest.reqId)}
              >
                Approve
              </button>
              <button
                type="button"
                onClick={() => handleUiResponse("reject", activeUiRequest.reqId)}
              >
                Reject
              </button>
            </div>
          </div>
        )}

        {uiRequestTimedOut && (
          <div role="status" style={{ padding: "8px 12px", backgroundColor: "#222", borderRadius: "var(--radius)", fontSize: "0.85rem", color: "var(--text-muted)" }}>
            Previous approval request timed out.
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      <form onSubmit={handleSendPrompt} className="composer-container">
        <textarea
          className="composer-input"
          placeholder={isSending ? "Turn in flight…" : "Send instructions to agent…"}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          disabled={isSending || status === "disconnected"}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSendPrompt(e);
            }
          }}
        />
        <button
          type="submit"
          className="primary"
          disabled={isSending || !inputText.trim() || status === "disconnected"}
          style={{ minHeight: "44px", minWidth: "64px" }}
        >
          {isSending ? "…" : "Send"}
        </button>
      </form>

      {/* Subagent Panel Modal */}
      {showSubagents && (
        <SubagentPanel
          agents={agents}
          onFetchTranscript={handleFetchTranscript}
          transcripts={transcripts}
          onClose={() => setShowSubagents(false)}
        />
      )}
      {/* Activity Timeline Modal */}
      {showActivity && (
        <ActivityPanel
          conversationId={conversationId}
          onClose={() => setShowActivity(false)}
        />
      )}
    </div>
  );
}
