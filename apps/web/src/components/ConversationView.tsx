import { memo, useMemo, useState, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { api } from "../api.js";
import { MarkdownCodeBlock, renderMarkdown } from "../sanitize.js";
import { SubagentPanel } from "./SubagentPanel.js";
import { ActivityPanel } from "./ActivityPanel.js";
import {
  CollabSocket,
  parseCollabLink,
  importRoomKey,
  encodeBase64Url,
  type HostFrame,
} from "@caw/collab-protocol";
import { clearTranscriptRequests, createTranscriptState, forgetTranscriptRequest, reduceHostFrame, setConnectionStatus, trackTranscriptRequest, type TranscriptState } from "../transcript.js";
import { findSlashCommand, slashCommands, type SlashCommand } from "../commands.js";
import type { AttachInstructions, Conversation } from "@caw/contracts";
interface ConversationViewProps {
  conversationId: string;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onBack: () => void;
}

interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  isError?: boolean;
  isRunning?: boolean;
  awaitingHost?: boolean;
  hostEchoCount?: number;
}

const TAIL_THRESHOLD_PX = 80;
const MAX_TRANSCRIPT_REQUESTS = 64;
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15_000;

export function autosizeComposer(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = "0px";
  const height = element.scrollHeight;
  element.style.height = `${Math.min(140, Math.max(44, height))}px`;
  element.style.overflowY = height > 140 ? "auto" : "hidden";
}

export function shouldSubmitOnEnter(
  event: Pick<React.KeyboardEvent<HTMLTextAreaElement>, "key" | "shiftKey" | "nativeEvent">,
  composing: boolean,
): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing;
}

const MessageRow = memo(function MessageRow({ message }: { message: DisplayMessage }) {
  return (
    <div className={`message-card ${message.role}`}>
      <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: "4px", textTransform: "capitalize" }}>
        {message.role} {message.toolName ? `(${message.toolName})` : ""}
        {message.awaitingHost ? " · sent while active; awaiting host" : ""}
      </div>
      {message.role === "tool" ? (
        <details open={message.isRunning}>
          <summary>{message.toolName ?? "Tool Result"} {message.isRunning ? "(Running…)" : message.isError ? "(Error)" : ""}</summary>
          <div className="message-content"><MarkdownCodeBlock code={message.text} language="" /></div>
        </details>
      ) : (
        <div className="message-content">{renderMarkdown(message.text)}</div>
      )}
    </div>
  );
});

export type ConnectionStatus = "connecting" | "idle" | "running" | "reconnecting" | "disconnected" | "unknown";

export function ConversationView({ conversationId, draft = "", onDraftChange, onBack }: ConversationViewProps) {


  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(createTranscriptState);
  const transcriptRef = useRef(transcript);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [sendError, setSendError] = useState<string | null>(null);
  const [inputText, setInputText] = useState(draft);
  const [isDetached, setIsDetached] = useState(false);
  const [attachInfo, setAttachInfo] = useState<AttachInstructions | null>(null);
  const [linkUnavailable, setLinkUnavailable] = useState(false);
  const [interceptedCommand, setInterceptedCommand] = useState<SlashCommand | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [modelMessage, setModelMessage] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const [showSubagents, setShowSubagents] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [transcriptErrors, setTranscriptErrors] = useState<Record<string, string>>({});
  const [optimisticMessages, setOptimisticMessages] = useState<DisplayMessage[]>([]);
  const [uiEditorValue, setUiEditorValue] = useState("");
  const inputValueRef = useRef(draft);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingStreamFrameRef = useRef<Extract<HostFrame, { t: "event" }> | null>(null);
  const composingRef = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const modelControlsRef = useRef<HTMLDetailsElement | null>(null);
  const modelInputRef = useRef<HTMLInputElement | null>(null);
  const socketRef = useRef<CollabSocket | null>(null);
  const pendingUiResponsesRef = useRef(new Set<number>());
  const localIdRef = useRef(0);
  const sendGuardRef = useRef<string | null>(null);
  const reqIdCounterRef = useRef(1);
  const transcriptRequestsRef = useRef(new Map<number, { agentId: string; timer: ReturnType<typeof setTimeout> }>());
  const rawUrlRef = useRef<string | null>(null);

  const streamingText = transcript.streamingMessage?.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("") ?? "";
  const commandSuggestions = inputText.startsWith("/") && !/\s/.test(inputText)
    ? slashCommands.filter((command) => command.name.startsWith(inputText)).slice(0, 5)
    : [];
  const agents = transcript.agents;
  const transcripts = useMemo(() => Object.fromEntries(Object.entries(transcript.transcripts).map(([id, reply]) => [id, reply.text])), [transcript.transcripts]);
  const loadingAgentIds = useMemo(() => [...new Set(Object.values(transcript.transcriptRequests))], [transcript.transcriptRequests]);
  const activeUiRequest = transcript.uiRequests.current;
  const uiRequestQueue = transcript.uiRequests.queue;
  useEffect(() => {
    if (activeUiRequest?.kind === "editor") setUiEditorValue(activeUiRequest.prefill ?? "");
  }, [activeUiRequest?.reqId]);
  const messages: DisplayMessage[] = useMemo(() => {
    const hostCounts = new Map<string, number>();
    for (const message of transcript.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    return [
      ...transcript.messages,
      ...optimisticMessages.filter((pending) => (hostCounts.get(pending.text) ?? 0) <= (pending.hostEchoCount ?? 0)),
    ];
  }, [transcript.messages, optimisticMessages]);
  useEffect(() => {
    const hostCounts = new Map<string, number>();
    for (const message of transcript.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    setOptimisticMessages((prev) => {
      const pending = prev.filter((message) => (hostCounts.get(message.text) ?? 0) <= (message.hostEchoCount ?? 0));
      return pending.length === prev.length ? prev : pending;
    });
  }, [transcript.messages]);

  const updateTranscript = (frame: HostFrame): void => {
    const next = reduceHostFrame(transcriptRef.current, frame);
    transcriptRef.current = next;
    setTranscript(next);
    setStatus(next.connectionStatus === "live" ? next.turnStatus : next.connectionStatus);
    if (frame.t === "welcome") sendGuardRef.current = null;
  };

  const flushPendingStream = (): void => {
    if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = null;
    const frame = pendingStreamFrameRef.current;
    pendingStreamFrameRef.current = null;
    if (frame) updateTranscript(frame);
  };

  const handleHostFrameRef = useRef<(frame: HostFrame) => void>(() => {});
  handleHostFrameRef.current = (frame) => {
    if (frame.t === "event" && frame.event.type === "message_update" && frame.event.message.role === "assistant") {
      pendingStreamFrameRef.current = frame;
      if (renderTimerRef.current === null) renderTimerRef.current = setTimeout(flushPendingStream, 100);
      return;
    }
    flushPendingStream();
    updateTranscript(frame);
    if (frame.t === "transcript") {
      const request = transcriptRequestsRef.current.get(frame.reqId);
      if (request) {
        clearTimeout(request.timer);
        transcriptRequestsRef.current.delete(frame.reqId);
        setTranscriptErrors((prev) => {
          const next = { ...prev };
          if (frame.error) next[request.agentId] = frame.error;
          else delete next[request.agentId];
          return next;
        });
      }
    }
  };

  const updateTailLock = useCallback(() => {
    const element = messagesScrollRef.current;
    if (!element) return;
    const nearTail = element.scrollHeight - element.clientHeight - element.scrollTop <= TAIL_THRESHOLD_PX;
    followTailRef.current = nearTail;
    setIsDetached((previous) => previous === !nearTail ? previous : !nearTail);
  }, []);

  useLayoutEffect(() => {
    const element = messagesScrollRef.current;
    if (element && followTailRef.current) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  }, [messages, streamingText]);

  useEffect(() => {
    const element = messagesScrollRef.current;
    const content = messagesContentRef.current;
    if (!element || !content) return;
    element.addEventListener("scroll", updateTailLock, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (followTailRef.current) element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    });
    observer?.observe(element);
    observer?.observe(content);
    return () => {
      element.removeEventListener("scroll", updateTailLock);
      observer?.disconnect();
    };
  }, [updateTailLock]);

  useEffect(() => () => {
    if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
    for (const request of transcriptRequestsRef.current.values()) clearTimeout(request.timer);
    transcriptRequestsRef.current.clear();
  }, []);

  useLayoutEffect(() => autosizeComposer(composerRef.current), [inputText]);

  const goToLatest = (): void => {
    const element = messagesScrollRef.current;
    if (!element) return;
    followTailRef.current = true;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    setIsDetached(false);
  };


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

  const connectToCollab = useCallback(async (retryStale = true) => {
    const linkRes = await api.getConversationLink(conversationId);
    if (!linkRes.ok) {
      if (linkRes.error.code === "link_unavailable") {
        setLinkUnavailable(true);
        setStatus("unknown");
        transcriptRef.current = setConnectionStatus(transcriptRef.current, "unknown");
        setTranscript(transcriptRef.current);
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
      const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
      socket.onOpen = () => {
        setStatus("connecting");
        socket.send({ t: "hello", proto: 3, name: "Mobile Web Controller", ...(writeToken ? { writeToken: encodeBase64Url(writeToken) } : {}) });
      };
      socket.onFrame = (frame) => handleHostFrameRef.current(frame);
      socket.onClose = (_reason, willReconnect) => {
        const connection = willReconnect ? "reconnecting" : "disconnected";
        setStatus(connection);
        transcriptRef.current = setConnectionStatus(transcriptRef.current, connection);
        setTranscript(transcriptRef.current);
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
      socketRef.current?.close();
      socketRef.current = null;
      rawUrlRef.current = null;
    };
  }, [connectToCollab]);

  const sendPrompt = (text: string, allowSlashCommand = false): void => {
    const trimmed = text.trim();
    if (!trimmed || !socketRef.current || (status !== "idle" && status !== "running")) return;
    const command = findSlashCommand(trimmed);
    if (command && !allowSlashCommand) {
      setInterceptedCommand(command);
      return;
    }
    if (sendGuardRef.current === trimmed) return;
    sendGuardRef.current = trimmed;
    const hostEchoCount = transcript.messages.filter((message) => message.role === "user" && message.text === trimmed).length;
    const echoAllowance = hostEchoCount + optimisticMessages.filter((message) => message.text === trimmed && hostEchoCount <= (message.hostEchoCount ?? 0)).length;
    const socket = socketRef.current;
    const submitted = allowSlashCommand ? text : trimmed;
    setSendError(null);
    void socket.send({ t: "prompt", text: submitted }).then((sent) => {
      if (sent) {
        setOptimisticMessages((prev) => [...prev, {
          id: `user-${++localIdRef.current}`,
          role: "user",
          text: submitted,
          awaitingHost: status === "running",
          hostEchoCount: echoAllowance,
        }]);
        inputValueRef.current = "";
        setInputText("");
        onDraftChange?.("");
        setInterceptedCommand(null);
        return;
      }
      sendGuardRef.current = null;
      setSendError("Not connected — prompt not sent. Draft kept; retry when connected.");
    });

  };
  const handleSendPrompt = (event: React.FormEvent): void => {
    event.preventDefault();
    sendPrompt(inputValueRef.current);
  };

  const updateDraft = (value: string): void => {
    inputValueRef.current = value;
    setInputText(value);
    sendGuardRef.current = null;
    setSendError(null);
    setInterceptedCommand(null);
    onDraftChange?.(value);
  };
  const sendSlashAsText = (): void => sendPrompt(inputValueRef.current, true);

  const openCommandAction = (): void => {
    setInterceptedCommand(null);
    if (modelControlsRef.current) modelControlsRef.current.open = true;
    modelInputRef.current?.focus();
  };

  const handleUiResponse = (value: string | undefined, reqId?: number): void => {
    const targetReqId = reqId ?? transcriptRef.current.uiRequests.current?.reqId;
    if (targetReqId === undefined || !socketRef.current || pendingUiResponsesRef.current.has(targetReqId)) return;
    const requests = transcriptRef.current.uiRequests;
    if (requests.current?.reqId !== targetReqId && !requests.queue.some((request) => request.reqId === targetReqId)) return;
    pendingUiResponsesRef.current.add(targetReqId);
    const socket = socketRef.current;
    void socket.send({ t: "ui-response", reqId: targetReqId, value }).then((sent) => {
      pendingUiResponsesRef.current.delete(targetReqId);
      if (sent) updateTranscript({ t: "ui-request-end", reqId: targetReqId });
      else setSendError("Not connected — approval response not sent. Request remains open; retry when connected.");
    });
  };

  const handleStop = () => {
    socketRef.current?.send({ t: "abort" });
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


  const handleFetchTranscript = (agentId: string) => {
    if (!socketRef.current || [...transcriptRequestsRef.current.values()].some((request) => request.agentId === agentId)) return;
    const reqId = reqIdCounterRef.current++;
    if (transcriptRequestsRef.current.size >= MAX_TRANSCRIPT_REQUESTS) {
      const oldestId = transcriptRequestsRef.current.keys().next().value;
      if (oldestId !== undefined) {
        const request = transcriptRequestsRef.current.get(oldestId)!;
        clearTimeout(request.timer);
        transcriptRequestsRef.current.delete(oldestId);
        transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, oldestId);
      }
    }
    transcriptRef.current = trackTranscriptRequest(transcriptRef.current, reqId, agentId);
    setTranscript(transcriptRef.current);
    setTranscriptErrors((prev) => {
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
    const timer = setTimeout(() => {
      transcriptRequestsRef.current.delete(reqId);
      transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, reqId);
      setTranscript(transcriptRef.current);
      setTranscriptErrors((prev) => ({ ...prev, [agentId]: "Transcript request timed out." }));
    }, TRANSCRIPT_REQUEST_TIMEOUT_MS);
    transcriptRequestsRef.current.set(reqId, { agentId, timer });
    socketRef.current.send({ t: "fetch-transcript", reqId, agentId, fromByte: 0 });
  };

  const handleCloseSubagents = () => {
    for (const request of transcriptRequestsRef.current.values()) clearTimeout(request.timer);
    transcriptRequestsRef.current.clear();
    transcriptRef.current = clearTranscriptRequests(transcriptRef.current);
    setTranscript(transcriptRef.current);
    setShowSubagents(false);
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
      <details className="model-controls-disclosure" ref={modelControlsRef}>
        <summary>Conversation model settings</summary>
        <section className="model-controls" aria-label="Conversation model">
          <label htmlFor="conversation-model">Model</label>
          <input
            id="conversation-model"
            ref={modelInputRef}
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
      </details>

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
      {transcript.notice && (
        <div className={`banner ${transcript.notice.level}`} role="status">
          <span>{transcript.notice.message}</span>
        </div>
      )}

      <div className="messages-scroll" ref={messagesScrollRef} role="region" aria-label="Conversation transcript">
        <div className="messages-content" ref={messagesContentRef}>
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

        {messages.map((message) => <MessageRow key={message.id} message={message} />)}

        {/* Streaming assistant message */}
        {streamingText && (
          <div className="message-card assistant">
            <div style={{ fontSize: "0.75rem", color: "var(--primary)", marginBottom: "4px" }}>
              Assistant (streaming…)
            </div>
            <div className="message-content">{renderMarkdown(streamingText)}</div>
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
            <p style={{ marginBottom: "12px", fontSize: "0.95rem" }}>{activeUiRequest.title}</p>

            {activeUiRequest.kind === "select" ? (
              <>
                {activeUiRequest.helpText && <p style={{ marginBottom: "8px", color: "var(--text-muted)" }}>{activeUiRequest.helpText}</p>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                  {activeUiRequest.options.map((option, index) => {
                    const label = typeof option === "string" ? option : option.label;
                    const checked = activeUiRequest.checkedIndices?.includes(index) ?? false;
                    const selected = activeUiRequest.initialIndex === index || checked;
                    return (
                      <button key={`${activeUiRequest.reqId}-${index}-${label}`} type="button" className={/\b(deny|reject|decline|refuse|disallow|cancel|no)\b/i.test(label) ? "ghost" : "primary"} onClick={() => handleUiResponse(label, activeUiRequest.reqId)}>
                        {activeUiRequest.selectionMarker === "checkbox" ? (checked ? "☑ " : "☐ ") : (selected ? "◉ " : "○ ")}
                        {label}
                        {typeof option !== "string" && option.description && <><br /><small>{option.description}</small></>}
                      </button>
                    );
                  })}
                </div>
                {activeUiRequest.markableCount !== undefined && <p style={{ color: "var(--text-muted)" }}>Choose up to {activeUiRequest.markableCount} options.</p>}
              </>
            ) : (
              <>
                <textarea value={uiEditorValue} onChange={(event) => setUiEditorValue(event.target.value)} rows={4} />
                <button type="button" className="primary" onClick={() => handleUiResponse(uiEditorValue, activeUiRequest.reqId)}>Submit</button>
              </>
            )}
          </div>
        )}


        </div>
      </div>
      {isDetached && commandSuggestions.length === 0 && !interceptedCommand && <button type="button" className="latest-button" onClick={goToLatest}>↓ Latest</button>}

      {/* Composer */}
      {commandSuggestions.length > 0 && !interceptedCommand && (
        <div className="composer-suggestions" aria-label="Slash command suggestions">
          {commandSuggestions.map((command) => (
            <button
              key={command.name}
              type="button"
              className="command-suggestion"
              onClick={() => { updateDraft(command.name); composerRef.current?.focus(); }}
            >
              <span><code>{command.name}</code> — {command.description}</span>
              {command.availability !== "app_action" && <small>{command.availability === "terminal_only" ? "Terminal only" : "Not a command"}</small>}
            </button>
          ))}
        </div>
      )}
      {interceptedCommand && (
        <div className="slash-command-intercept">
          <strong>{interceptedCommand.name}</strong>
          <p>{interceptedCommand.explanation}</p>
          {interceptedCommand.availability === "terminal_only" && <p>Terminal only — not sent to the live session.</p>}
          {interceptedCommand.availability === "app_action" && (
            <button type="button" onClick={openCommandAction}>Open model controls</button>
          )}
          <button type="button" className="primary" onClick={sendSlashAsText}>Send as plain text anyway</button>
          <button type="button" className="ghost" onClick={() => setInterceptedCommand(null)}>Cancel</button>
        </div>
      )}
      <form onSubmit={handleSendPrompt} className="composer-container">
        <textarea
          className="composer-input"
          placeholder={status === "running" ? "Turn in flight — send a follow-up…" : "Send instructions to agent…"}
          value={inputText}
          ref={composerRef}
          onChange={(event) => updateDraft(event.target.value)}
          disabled={status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
          rows={1}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { setTimeout(() => { composingRef.current = false; }, 0); }}
          onKeyDown={(event) => {
            if (shouldSubmitOnEnter(event, composingRef.current)) {
              event.preventDefault();
              handleSendPrompt(event);
            }
          }}
        />
        <button
          type="submit"
          className="primary"
          disabled={!inputText.trim() || status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
          style={{ minHeight: "44px", minWidth: "64px" }}
        >
          Send
        </button>
      {sendError && <div className="banner unknown" role="alert">{sendError}</div>}
      </form>

      {/* Subagent Panel Modal */}
      {showSubagents && (
        <SubagentPanel
          agents={agents}
          onFetchTranscript={handleFetchTranscript}
          transcripts={transcripts}
          transcriptErrors={transcriptErrors}
          loadingAgentIds={loadingAgentIds}
          onClose={handleCloseSubagents}
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
