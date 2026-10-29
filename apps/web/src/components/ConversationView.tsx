import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type SavedConversationHistory } from "../api.js";
import { MarkdownCodeBlock, renderMarkdown } from "../sanitize.js";
import { ActivityPanel } from "./ActivityPanel.js";
import { SubagentPanel } from "./SubagentPanel.js";
import {
  CollabSocket,
  parseCollabLink,
  importRoomKey,
  encodeBase64Url,
  type HostFrame,
  type SessionEntry,
} from "@caw/collab-protocol";
import { clearTranscriptRequests, createTranscriptState, forgetTranscriptRequest, reduceHostFrame, setConnectionStatus, trackTranscriptRequest, transcriptMessagesFromEntries, type TranscriptMessage, type TranscriptReply, type TranscriptState } from "../transcript.js";
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
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  toolName?: string;
  isError?: boolean;
  isRunning?: boolean;
  awaitingHost?: boolean;
  hostEchoCount?: number;
}
interface PendingPrompt {
  text: string;
  submitted: string;
  hostEchoCount: number;
  optimisticId: string | null;
  sent: boolean;
  refusalMessage?: string;
  draftVersion: number;
  /** Physical connection the prompt was sent on; a refusal only matches prompts from the current one. */
  physicalConnection: number;
  token: object;
}


const TAIL_THRESHOLD_PX = 80;
const MAX_TRANSCRIPT_REQUESTS = 64;
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15_000;
const TRANSCRIPT_POLL_MS = 1200;
const STARTUP_PROMPT_REFUSAL = "prompting is unavailable until the host finishes starting up";


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
  coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
): boolean {
  return !coarsePointer && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !composing;
}

const MessageRow = memo(function MessageRow({ message }: { message: DisplayMessage }) {
  return (
    <div className={`message-card ${message.role}${message.isError ? " error" : ""}`}>
      <div style={{ fontSize: "0.75rem", color: message.isError ? "var(--danger)" : "var(--text-muted)", marginBottom: "4px", textTransform: "capitalize" }}>
        {message.role} {message.toolName ? `(${message.toolName})` : ""}{message.isError ? " · error" : ""}
        {message.awaitingHost ? " · sent while active; awaiting host" : ""}
      </div>
      {message.role === "tool" ? (
        <details open={message.isRunning}>
          <summary>{message.toolName ?? "Tool Result"} {message.isRunning ? "(Running…)" : message.isError ? "(Error)" : ""}</summary>
          <div className="message-content"><MarkdownCodeBlock code={message.text} language="" /></div>
        </details>
      ) : (
        <div className="message-content">{message.role === "notice" ? <p>{message.text}</p> : renderMarkdown(message.text)}</div>
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
  const [optimisticMessages, setOptimisticMessages] = useState<DisplayMessage[]>([]);
  const [inputText, setInputText] = useState(draft);
  const [isDetached, setIsDetached] = useState(false);
  const [attachInfo, setAttachInfo] = useState<AttachInstructions | null>(null);
  const [linkUnavailable, setLinkUnavailable] = useState(false);
  const [interceptedCommand, setInterceptedCommand] = useState<SlashCommand | null>(null);
  const [modelCatalogState, setModelCatalogState] = useState<{ status: "loading" } | { status: "loaded"; models: string[] } | { status: "empty" } | { status: "unavailable"; reason: string } | { status: "error"; message: string }>({ status: "loading" });
  const [modelDraft, setModelDraft] = useState("");
  const [modelMessage, setModelMessage] = useState("");
  const [effectiveModel, setEffectiveModel] = useState<{ conversationId: string; model: string | null } | null>(null);
  const [viewAccessOffer, setViewAccessOffer] = useState<string | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  const [roomRetired, setRoomRetired] = useState(false);
  const [linkAccess, setLinkAccess] = useState<"view" | "full" | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [showSubagents, setShowSubagents] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [transcriptErrors, setTranscriptErrors] = useState<Record<string, string>>({});
  const [savedHistory, setSavedHistory] = useState<(SavedConversationHistory & { messages: TranscriptMessage[] }) | null>(null);
  const [historyLive, setHistoryLive] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [olderHistoryError, setOlderHistoryError] = useState<string | null>(null);
  /** Bumped by Retry so the saved-history effect re-runs even though linkUnavailable stays true. */
  const [historyRetryEpoch, setHistoryRetryEpoch] = useState(0);
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
  const pendingUiResponsesRef = useRef(new Map<number, object>());
  const sendingPromptTextsRef = useRef(new Map<string, object>());
  const pendingPromptRef = useRef<PendingPrompt[]>([]);
  const localIdRef = useRef(0);
  const sendGuardRef = useRef<{ id: number; text: string } | null>(null);
  const sendVersionRef = useRef(0);
  const sendIdRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const viewActiveRef = useRef(true);
  const connectionGenerationRef = useRef(0);
  /**
   * Physical connection identity, bumped on every socket open — including the
   * automatic reconnect of the same CollabSocket object. Minted-link generation
   * (connectionGenerationRef) is a separate concern: an unacked prompt from an
   * earlier physical connection must not consume a refusal meant for a newer one.
   */
  const physicalConnectionRef = useRef(0);
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const watchedTranscriptAgentRef = useRef<string | null>(null);
  const reqIdCounterRef = useRef(1);
  const transcriptRequestsRef = useRef(new Map<number, { agentId: string; fromByte: number; timer: ReturnType<typeof setTimeout> }>());
  const olderHistoryLoadingRef = useRef(false);
  const historyScrollAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const fetchTranscriptRef = useRef<(agentId: string, fromByte: number) => void>(() => {});
  const rawUrlRef = useRef<string | null>(null);

  const streamingText = transcript.streamingMessage?.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("") ?? "";
  const isShowingSavedHistory = linkUnavailable && savedHistory !== null;
  const commandSuggestions = inputText.startsWith("/") && !/\s/.test(inputText)
    ? slashCommands.filter((command) => command.name.startsWith(inputText)).slice(0, 5)
    : [];
  const agents = transcript.agents;
  const transcripts = transcript.transcripts;
  const canManageConversation = conversation?.id === conversationId && conversation.ownership === "managed";
  const canWriteToHost = linkAccess === "full";
  useLayoutEffect(() => {
    viewActiveRef.current = true;
    operationGenerationRef.current++;
    return () => {
      viewActiveRef.current = false;
      operationGenerationRef.current++;
    };
  }, [conversationId]);
  const loadingAgentIds = useMemo(() => [...new Set(Object.values(transcript.transcriptRequests).map((request) => request.agentId))], [transcript.transcriptRequests]);
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

  const recoverRefusedPrompt = (prompt: PendingPrompt): void => {
    pendingPromptRef.current = pendingPromptRef.current.filter((pending) => pending !== prompt);
    if (prompt.optimisticId) setOptimisticMessages((previous) => previous.filter((message) => message.id !== prompt.optimisticId));
    if (sendVersionRef.current !== prompt.draftVersion) return;
    inputValueRef.current = prompt.text;
    setInputText(prompt.text);
    onDraftChange?.(prompt.text);
  };
  const removeAcknowledgedPrompts = (): void => {
    const hostCounts = new Map<string, number>();
    for (const message of transcriptRef.current.messages) {
      if (message.role === "user") hostCounts.set(message.text, (hostCounts.get(message.text) ?? 0) + 1);
    }
    pendingPromptRef.current = pendingPromptRef.current.filter((prompt) => (hostCounts.get(prompt.submitted) ?? 0) <= prompt.hostEchoCount);
  };

  const updateTranscript = (frame: HostFrame): void => {
    const next = reduceHostFrame(transcriptRef.current, frame);
    transcriptRef.current = next;
    setTranscript(next);
    setStatus(next.connectionStatus === "live" ? next.turnStatus : next.connectionStatus);
    if (frame.t === "welcome") {
      sendGuardRef.current = null;
      setEffectiveModel({ conversationId, model: frame.state.model?.id ?? null });
    }
    if (frame.t === "state" && frame.state.model) setEffectiveModel({ conversationId, model: frame.state.model.id });
    if ((frame.t === "welcome" || frame.t === "state") && next.error === null) setSendError(null);
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
    if (frame.t === "entry" || frame.t === "snapshot-chunk" || (frame.t === "event" && frame.event.type === "message_end" && frame.event.message.role === "user")) removeAcknowledgedPrompts();
    if (frame.t === "error") {
      if (frame.message === STARTUP_PROMPT_REFUSAL) {
        const prompt = pendingPromptRef.current.find((pending) => pending.physicalConnection === physicalConnectionRef.current && !pending.refusalMessage);
        if (prompt) {
          prompt.refusalMessage = frame.message;
          if (prompt.sent) recoverRefusedPrompt(prompt);
        }
      }
      setSendError(frame.message);
    }
    if (frame.t === "bye") setSendError(frame.reason);
    if (frame.t === "transcript") {
      const request = transcriptRequestsRef.current.get(frame.reqId);
      if (request) {
        clearTimeout(request.timer);
        transcriptRequestsRef.current.delete(frame.reqId);
        if (request.agentId === watchedTranscriptAgentRef.current) {
          setTranscriptErrors((prev) => {
            const next = { ...prev };
            if (frame.error) next[request.agentId] = frame.error;
            else delete next[request.agentId];
            return next;
          });
          if (!frame.error && frame.text === "" && frame.newSize < request.fromByte) {
            fetchTranscriptRef.current(request.agentId, 0);
          }
        }
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
  useLayoutEffect(() => {
    const anchor = historyScrollAnchorRef.current;
    const element = messagesScrollRef.current;
    if (!anchor || !element) return;
    element.scrollTop = anchor.top + element.scrollHeight - anchor.height;
    historyScrollAnchorRef.current = null;
  }, [savedHistory]);

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
    socketRef.current?.close();
    socketRef.current = null;
  }, []);

  useLayoutEffect(() => autosizeComposer(composerRef.current), [inputText]);
  useEffect(() => {
    inputValueRef.current = draft;
    setInputText(draft);
  }, [draft]);

  const goToLatest = (): void => {
    const element = messagesScrollRef.current;
    if (!element) return;
    followTailRef.current = true;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    setIsDetached(false);
  };


  useEffect(() => {
    transcriptRef.current = createTranscriptState();
    setTranscript(transcriptRef.current);
    setConversation(null);
    setEffectiveModel(null);
    setLinkUnavailable(false);
    setViewAccessOffer(null);
    setLinkFailure(null);
    setSavedHistory(null);
    setHistoryLive(false);
    setHistoryLoading(false);
    setOlderHistoryLoading(false);
    olderHistoryLoadingRef.current = false;
    setHistoryError(null);
    setOlderHistoryError(null);

    sendVersionRef.current++;
    pendingPromptRef.current = [];
    setSendError(null);
    sendingPromptTextsRef.current.clear();
    const currentId = conversationId;
    api.getConversation(conversationId).then((res) => {
      if (conversationIdRef.current === currentId && res.ok) {
        setConversation(res.data);
        setModelDraft(res.data.modelPreference ?? res.data.model ?? "");
      }
    });
    api.getAttachInstructions(conversationId).then((res) => {
      if (conversationIdRef.current === currentId && res.ok) setAttachInfo(res.data);
    });
  }, [conversationId]);
  useEffect(() => {
    if (!linkUnavailable) return;
    let active = true;
    setHistoryLoading(true);
    setHistoryError(null);
    void api.getConversationHistory(conversationId).then((result) => {
      if (!active) return;
      setHistoryLoading(false);
      if (result.ok) {
        setHistoryError(null);
        setSavedHistory({ ...result.data, messages: transcriptMessagesFromEntries(result.data.entries as unknown as SessionEntry[]) });
      } else if (result.error.code === "conflict_owner") {
        setHistoryLive(true);
      } else if (result.error.code !== "not_found") {
        setHistoryError(result.error.message || "Could not load saved transcript.");
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setHistoryLoading(false);
      setHistoryError(error instanceof Error ? error.message : "Could not load saved transcript.");
    });
    return () => { active = false; };
  }, [conversationId, linkUnavailable, historyRetryEpoch]);
  const loadOlderHistory = async () => {
    const current = savedHistory;
    if (!current?.hasOlder || !current.nextCursor || olderHistoryLoadingRef.current) return;
    olderHistoryLoadingRef.current = true;
    setOlderHistoryLoading(true);
    setOlderHistoryError(null);
    const conversationAtRequest = conversationIdRef.current;
    const scroll = messagesScrollRef.current;
    if (scroll) historyScrollAnchorRef.current = { top: scroll.scrollTop, height: scroll.scrollHeight };
    const result = await api.getConversationHistory(conversationAtRequest, current.nextCursor);
    if (conversationIdRef.current !== conversationAtRequest) return;
    olderHistoryLoadingRef.current = false;
    setOlderHistoryLoading(false);
    if (!result.ok) {
      historyScrollAnchorRef.current = null;
      setOlderHistoryError(result.error.message || "Could not load older history.");
      return;
    }
    const seenMessages = new Set<string>();
    const messages = [...transcriptMessagesFromEntries(result.data.entries as unknown as SessionEntry[]), ...current.messages].filter((message) => {
      if (seenMessages.has(message.id)) return false;
      seenMessages.add(message.id);
      return true;
    });
    const seenEntries = new Set<string>();
    const entries = [...result.data.entries, ...current.entries].filter((entry) => {
      const id = typeof entry.id === "string" ? entry.id : JSON.stringify(entry);
      if (seenEntries.has(id)) return false;
      seenEntries.add(id);
      return true;
    });
    setSavedHistory({
      ...current,
      entries,
      messages,
      truncated: current.truncated || result.data.truncated,
      truncatedByBytes: current.truncatedByBytes || result.data.truncatedByBytes,
      truncatedByEntries: current.truncatedByEntries || result.data.truncatedByEntries,
      skippedOversized: current.skippedOversized || result.data.skippedOversized,
      hasOlder: result.data.hasOlder,
      nextCursor: result.data.nextCursor,
    });
  };
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api.getModels()).then((result) => {
      if (!active) return;
      if (!result.ok) setModelCatalogState({ status: "error", message: result.error.message });
      else if (result.data.source === "unavailable") setModelCatalogState({ status: "unavailable", reason: result.data.reason ?? "Model catalog unavailable." });
      else if (result.data.models.length === 0) setModelCatalogState({ status: "empty" });
      else setModelCatalogState({ status: "loaded", models: result.data.models });
    }).catch((error: unknown) => {
      if (active) setModelCatalogState({ status: "error", message: error instanceof Error ? error.message : "Could not load model catalog." });
    });
    return () => { active = false; };
  }, []);

  const connectToCollab = useCallback(async (retryStale = true, access: "control" | "view" = "control") => {
    if (!viewActiveRef.current) return;
    const generation = ++connectionGenerationRef.current;
    const isCurrent = () => viewActiveRef.current && connectionGenerationRef.current === generation && conversationIdRef.current === conversationId;
    setRoomRetired(false);
    setEffectiveModel(null);
    setLinkAccess(null);
    socketRef.current?.close();
    socketRef.current = null;
    const linkRes = await api.getConversationLink(conversationId, access);
    if (!isCurrent()) return;
    if (!linkRes.ok) {
      if (linkRes.error.code === "link_unavailable") {
        setLinkUnavailable(true);
        setStatus("unknown");
        transcriptRef.current = setConnectionStatus(transcriptRef.current, "unknown");
        setTranscript(transcriptRef.current);
        return;
      }
      if (linkRes.error.code === "capability_missing" && access === "control") {
        setLinkUnavailable(false);
        setViewAccessOffer(linkRes.error.message);
        setLinkFailure(null);
        setStatus("unknown");
        return;
      }
      if (linkRes.error.code === "capability_missing") setLinkFailure(`Host access refused: ${linkRes.error.message}`);
      if (linkRes.error.code === "stale_generation" && retryStale) {
        void connectToCollab(false, access);
        return;
      }
      setViewAccessOffer(null);
      setStatus("disconnected");
      return;
    }
    setViewAccessOffer(null);
    setLinkFailure(null);
    if (linkRes.data.access !== (access === "control" ? "full" : "view")) {
      setLinkFailure(`Host access refused: requested ${access}, host returned ${linkRes.data.access}.`);
      setStatus("disconnected");
      return;
    }
    setLinkAccess(linkRes.data.access);

    setLinkUnavailable(false);
    setSavedHistory(null);
    setHistoryLive(false);
    rawUrlRef.current = linkRes.data.url;
    const parsed = parseCollabLink(rawUrlRef.current);
    if ("error" in parsed) {
      setStatus("disconnected");
      return;
    }
    try {
      const { key } = await importRoomKey(parsed.key);
      const writeToken = parsed.writeToken;
      if (!isCurrent()) return;
      const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
      socket.onOpen = () => {
        if (!isCurrent() || socketRef.current !== socket) return;
        physicalConnectionRef.current++;
        setStatus("connecting");
        void socket.send({ t: "hello", proto: 3, name: "Mobile Web Controller", ...(writeToken ? { writeToken: encodeBase64Url(writeToken) } : {}) });
      };
      socket.onFrame = (frame) => {
        if (isCurrent() && socketRef.current === socket) handleHostFrameRef.current(frame);
      };
      socket.onClose = (_reason, willReconnect, roomRetired) => {
        if (!isCurrent() || socketRef.current !== socket) return;
        const connection = willReconnect ? "reconnecting" : "disconnected";
        setRoomRetired(roomRetired === true);
        setStatus(connection);
        transcriptRef.current = setConnectionStatus(transcriptRef.current, connection);
        setTranscript(transcriptRef.current);
      };
      socketRef.current = socket;
      socket.connect();
    } catch {
      if (isCurrent()) setStatus("disconnected");
    }
  }, [conversationId]);

  useEffect(() => {
    void connectToCollab(true);
    return () => {
      connectionGenerationRef.current++;
      socketRef.current?.close();
      socketRef.current = null;
      rawUrlRef.current = null;
    };
  }, [connectToCollab]);


  const retryUnavailableConversation = async (): Promise<void> => {
    const currentId = conversationIdRef.current;
    const result = await api.getConversation(currentId);
    if (conversationIdRef.current !== currentId) return;
    if (result.ok) {
      setConversation(result.data);
      setModelDraft(result.data.modelPreference ?? result.data.model ?? "");
    }
    await connectToCollab(true);
    // The live link may still be down; re-run the saved-history read so a
    // recovered endpoint is picked up without waiting for linkUnavailable to flip.
    if (conversationIdRef.current === currentId) setHistoryRetryEpoch((epoch) => epoch + 1);
  };
  const sendPrompt = (text: string, allowSlashCommand = false): void => {
    const trimmed = text.trim();
    const socket = socketRef.current;
    if (!trimmed || !socket || (status !== "idle" && status !== "running")) return;
    if (transcriptRef.current.readOnly) {
      setSendError("Read-only view — prompt was not sent.");
      return;
    }
    const command = findSlashCommand(trimmed);
    if (command && !allowSlashCommand) {
      setInterceptedCommand(command);
      return;
    }
    if (sendingPromptTextsRef.current.has(trimmed)) return;
    const sendId = ++sendIdRef.current;
    const draftVersion = sendVersionRef.current;
    const conversationAtSend = conversationIdRef.current;
    const operationGeneration = operationGenerationRef.current;
    const connectionGeneration = connectionGenerationRef.current;
    const physicalConnection = physicalConnectionRef.current;
    const sendToken = { id: sendId, text: trimmed };
    const hostEchoCount = transcript.messages.filter((message) => message.role === "user" && message.text === trimmed).length;
    const echoAllowance = hostEchoCount + optimisticMessages.filter((message) => message.text === trimmed && hostEchoCount <= (message.hostEchoCount ?? 0)).length;
    const submitted = allowSlashCommand ? text : trimmed;
    const pendingPrompt: PendingPrompt = {
      text,
      submitted,
      hostEchoCount: echoAllowance,
      optimisticId: null,
      sent: false,
      refusalMessage: undefined,
      draftVersion,
      physicalConnection,
      token: sendToken,
    };
    pendingPromptRef.current.push(pendingPrompt);
    sendingPromptTextsRef.current.set(trimmed, sendToken);
    sendGuardRef.current = sendToken;
    setSendError(null);
    const startedRunning = status === "running";
    void socket.send({ t: "prompt", text: submitted }).then((sent) => {
      if (sendingPromptTextsRef.current.get(trimmed) === sendToken) sendingPromptTextsRef.current.delete(trimmed);
      if (!sent) pendingPromptRef.current = pendingPromptRef.current.filter((prompt) => prompt.token !== sendToken);
      if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || connectionGenerationRef.current !== connectionGeneration || conversationIdRef.current !== conversationAtSend) return;
      if (sendGuardRef.current === sendToken) sendGuardRef.current = null;
      if (sent) {
        const optimisticId = `user-${++localIdRef.current}`;
        pendingPrompt.sent = true;
        pendingPrompt.optimisticId = optimisticId;
        setOptimisticMessages((prev) => [...prev, {
          id: optimisticId,
          role: "user",
          text: submitted,
          awaitingHost: startedRunning,
          hostEchoCount: echoAllowance,
        }]);
        setSendError("Sent to socket; host receipt is unconfirmed until conversation echo arrives.");
        if (sendVersionRef.current === draftVersion && inputValueRef.current === text) {
          inputValueRef.current = "";
          setInputText("");
          onDraftChange?.("");
        }
        if (pendingPrompt.refusalMessage) {
          setSendError(pendingPrompt.refusalMessage);
          recoverRefusedPrompt(pendingPrompt);
        }
        return;
      }
      setSendError("Socket did not accept prompt. Draft kept; retry when connected.");
    });
  };
  const handleSendPrompt = (event: React.FormEvent): void => {
    event.preventDefault();
    sendPrompt(inputValueRef.current);
  };

  const updateDraft = (value: string): void => {
    sendVersionRef.current++;
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
    modelInputRef.current?.scrollIntoView?.({ block: "nearest" });
  };

  const handleUiResponse = (value: string | undefined, reqId?: number): void => {
    const targetReqId = reqId ?? transcriptRef.current.uiRequests.current?.reqId;
    if (transcriptRef.current.readOnly || targetReqId === undefined || !socketRef.current || pendingUiResponsesRef.current.has(targetReqId)) return;
    const requests = transcriptRef.current.uiRequests;
    if (requests.current?.reqId !== targetReqId && !requests.queue.some((request) => request.reqId === targetReqId)) return;
    const responseToken = {};
    pendingUiResponsesRef.current.set(targetReqId, responseToken);
    const socket = socketRef.current;
    const operationGeneration = operationGenerationRef.current;
    const connectionGeneration = connectionGenerationRef.current;
    const conversationAtResponse = conversationIdRef.current;
    void socket.send({ t: "ui-response", reqId: targetReqId, value }).then((sent) => {
      if (pendingUiResponsesRef.current.get(targetReqId) === responseToken) pendingUiResponsesRef.current.delete(targetReqId);
      if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || connectionGenerationRef.current !== connectionGeneration || conversationIdRef.current !== conversationAtResponse) return;
      if (sent) updateTranscript({ t: "ui-request-end", reqId: targetReqId });
      else setSendError("Not connected — approval response not sent. Request remains open; retry when connected.");
    });
  };

  const handleStop = () => {
    if (transcriptRef.current.readOnly) return;
    void socketRef.current?.send({ t: "abort" });
  };

  const handleSaveModel = async () => {
    const operationGeneration = operationGenerationRef.current;
    const conversationAtSave = conversationIdRef.current;
    setModelBusy(true);
    setModelMessage("");
    const result = await api.setConversationModel(conversationId, modelDraft);
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtSave) return;
    setModelBusy(false);
    setModelMessage(result.ok ? "Model saved for next launch." : result.error.message);
    if (result.ok) setConversation(result.data);
  };

  const handleRestart = async () => {
    if (!window.confirm("Save this model preference and restart the agent now? The running session may be interrupted.")) return;
    const operationGeneration = operationGenerationRef.current;
    const conversationAtRestart = conversationIdRef.current;
    setModelBusy(true);
    setModelMessage("");
    const saved = await api.setConversationModel(conversationId, modelDraft);
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtRestart) return;
    if (!saved.ok) {
      setModelBusy(false);
      setModelMessage(saved.error.message);
      return;
    }
    setConversation(saved.data);
    const result = await api.restartConversation(conversationId);
    if (!viewActiveRef.current || operationGenerationRef.current !== operationGeneration || conversationIdRef.current !== conversationAtRestart) return;
    setModelBusy(false);
    if (result.ok) {
      setConversation(result.data);
      setModelDraft(result.data.modelPreference ?? result.data.model ?? "");
      setModelMessage("Agent restarted.");
      socketRef.current?.close();
      socketRef.current = null;
      if (viewActiveRef.current && operationGenerationRef.current === operationGeneration && conversationIdRef.current === conversationAtRestart) await connectToCollab(true);
    } else setModelMessage(result.error.message);
  };


  const handleFetchTranscript = (agentId: string, fromByte: number) => {
    if (!socketRef.current || watchedTranscriptAgentRef.current !== agentId || [...transcriptRequestsRef.current.values()].some((request) => request.agentId === agentId)) return;
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
    const cursor = transcriptRef.current.transcripts[agentId]?.newSize ?? fromByte;
    transcriptRef.current = trackTranscriptRequest(transcriptRef.current, reqId, agentId, cursor);
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
      setTranscriptErrors((prev) => ({ ...prev, [agentId]: "Transcript request timed out. Cursor was kept; retry to continue." }));
    }, TRANSCRIPT_REQUEST_TIMEOUT_MS);
    transcriptRequestsRef.current.set(reqId, { agentId, fromByte: cursor, timer });
    void socketRef.current.send({ t: "fetch-transcript", reqId, agentId, fromByte: cursor }).then((sent) => {
      if (sent) return;
      const request = transcriptRequestsRef.current.get(reqId);
      if (!request) return;
      clearTimeout(request.timer);
      transcriptRequestsRef.current.delete(reqId);
      transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, reqId);
      setTranscript(transcriptRef.current);
      setTranscriptErrors((previous) => ({ ...previous, [agentId]: "Transcript request was not accepted. Cursor was kept; retry to continue." }));
    });
  };
  fetchTranscriptRef.current = handleFetchTranscript;

  const handleWatchTranscript = useCallback((agentId: string | null) => {
    const previousAgentId = watchedTranscriptAgentRef.current;
    watchedTranscriptAgentRef.current = agentId;
    if (previousAgentId === null || previousAgentId === agentId) return;
    for (const [reqId, request] of transcriptRequestsRef.current) {
      if (request.agentId !== previousAgentId) continue;
      clearTimeout(request.timer);
      transcriptRequestsRef.current.delete(reqId);
      transcriptRef.current = forgetTranscriptRequest(transcriptRef.current, reqId);
    }
    setTranscript(transcriptRef.current);
  }, []);

  const handleCloseSubagents = () => {
    handleWatchTranscript(null);
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
        <div className="conversation-header-title">
          <button type="button" className="ghost" onClick={onBack} title="Back">
            ←
          </button>
          <div className="conversation-header-copy">
            <h3 style={{ fontSize: "1rem" }}>{conversation?.title ?? "Conversation"}</h3>
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>{conversation?.state ?? "status unknown"}</span>
          </div>
        </div>

        <div className="conversation-header-actions">
          <button
            type="button"
            className="ghost"
            style={{ fontSize: "0.85rem" }}
            onClick={() => setShowActivity(true)}
            aria-label="Activity"
            title="Activity"
          >
            <span className="header-action-icon" aria-hidden="true">◷</span>
            <span className="header-action-label">Activity</span>
          </button>
          {agents.length > 0 && (
            <button
              type="button"
              className="ghost"
              style={{ fontSize: "0.85rem" }}
              aria-label={`Agents (${agents.length})`}
              title={`Agents (${agents.length})`}
              onClick={() => setShowSubagents(true)}
            >
              <span className="header-action-icon" aria-hidden="true">◉</span>
              <span className="header-action-label">Agents ({agents.length})</span>
            </button>
          )}
          {status === "running" && canManageConversation && canWriteToHost && !transcript.readOnly && (
            <button type="button" className="danger" aria-label="Stop" title="Stop" onClick={handleStop} style={{ padding: "4px 10px", fontSize: "0.85rem" }}>
              <span className="header-action-icon" aria-hidden="true">■</span>
              <span className="header-action-label">Stop</span>
            </button>
          )}
        </div>
      </div>
      <details className="model-controls-disclosure" ref={modelControlsRef}>
        <summary>Conversation model settings</summary>
        <section className="model-controls" aria-label="Conversation model">
          <label htmlFor="conversation-model">Preferred model for next launch</label>
          <select id="conversation-model" value={modelCatalogState.status === "loaded" && modelCatalogState.models.includes(modelDraft) ? modelDraft : ""} onChange={(event) => setModelDraft(event.target.value)}>
            <option value="">Choose a catalog model</option>
            {modelCatalogState.status === "loaded" && modelCatalogState.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <label htmlFor="custom-model">Custom model ID</label>
          <input id="custom-model" ref={modelInputRef} value={modelDraft} maxLength={128} onChange={(event) => setModelDraft(event.target.value)} placeholder="Enter any OMP model ID" aria-describedby="model-launch-note" />
          {modelCatalogState.status === "loading" && <p role="status">Loading model catalog…</p>}
          {modelCatalogState.status === "empty" && <p role="status">No models reported by OMP. Saved preference is unchanged.</p>}
          {modelCatalogState.status === "unavailable" && <p role="status">Model catalog unavailable: {modelCatalogState.reason} Saved preference is unchanged.</p>}
          {modelCatalogState.status === "error" && <p role="alert">Could not load models: {modelCatalogState.message} Saved preference is unchanged.</p>}
          <p>{conversation?.ownership === "external" ? "Saved preference for app-launched chats:" : "Preferred for next launch:"} <strong>{conversation?.modelPreference || "not set"}</strong></p>
          <p>Effective model reported now: <strong>{effectiveModel?.conversationId === conversationId ? effectiveModel.model ?? "not reported" : "not reported"}</strong></p>
          {canManageConversation && <button type="button" onClick={handleSaveModel} disabled={modelBusy || !modelDraft.trim()}>Save model</button>}
          {canManageConversation && <button type="button" className="ghost" onClick={handleRestart} disabled={modelBusy || !modelDraft.trim()}>Save &amp; restart agent</button>}
          <span id="model-launch-note">{conversation?.ownership === "external" ? "This model preference applies only to conversations launched by the app." : "Model changes apply on the next launch of this conversation, not immediately."}</span>
          {modelMessage && <span role="status">{modelMessage}</span>}
        </section>
      </details>
      {(transcript.readOnly || linkAccess === "view") && <div className="banner unknown" role="status">Read-only view — prompts, approvals and Stop are unavailable.</div>}
      {viewAccessOffer && status === "unknown" && (
        <div className="banner unknown" role="status">
          <span>Host offers read-only access: {viewAccessOffer}</span>
          <button type="button" className="ghost" onClick={() => void connectToCollab(true, "view")}>Open read-only</button>
        </div>
      )}

      {/* Accessible Status Banners */}
      {status === "disconnected" && !roomRetired && (
        <div className="banner disconnected" role="status">
          <span>Disconnected — Connection lost</span>
          <button type="button" className="ghost" style={{ padding: "2px 8px", fontSize: "0.8rem", color: "#ffffff" }} onClick={() => connectToCollab(true)}>
            Retry
          </button>
        </div>
      )}
      {roomRetired && (
        <div className="banner disconnected" role="status">
          <span>Room retired — reconnect with a fresh link.</span>
          <button type="button" className="ghost" style={{ padding: "2px 8px", fontSize: "0.8rem", color: "#ffffff" }} onClick={() => void connectToCollab(true)}>
            Get new link
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
      {linkFailure && <div className="banner disconnected" role="alert">{linkFailure}</div>}
      {transcript.notice && (
        <div className={`banner ${transcript.notice.level}`} role={transcript.notice.level === "error" ? "alert" : "status"}>
          <span>{transcript.notice.message}</span>
        </div>
      )}
      {conversation?.state === "starting" && (
        <div className="banner connecting" role="status">Host is starting up; prompting may be refused.</div>
      )}
      <div className="messages-scroll" ref={messagesScrollRef} role="region" aria-label="Conversation transcript">
        <div className="messages-content" ref={messagesContentRef}>
        {isShowingSavedHistory && savedHistory ? (
          <>
            <div className="banner idle" role="status">Saved transcript — this session is not running. {savedHistory.header.title ?? savedHistory.header.sessionId}</div>
            {savedHistory.skippedOversized && <div className="banner unknown" role="alert">History is incomplete: a record too large to display was skipped; journal intact on disk.</div>}
            {savedHistory.truncated && (savedHistory.hasOlder || savedHistory.skippedOversized) && <div className="banner unknown" role="status">Saved transcript truncated; some history is omitted.</div>}
            {savedHistory.hasOlder && savedHistory.nextCursor !== null && <button type="button" className="ghost" disabled={olderHistoryLoading} onClick={() => void loadOlderHistory()}>{olderHistoryLoading ? "Loading older…" : "Load older"}</button>}
            {olderHistoryLoading && <p role="status">Loading older history…</p>}
            {olderHistoryError && <p role="alert">{olderHistoryError}</p>}
            {!savedHistory.hasOlder && !savedHistory.skippedOversized && <p role="status">Beginning of history.</p>}
            {savedHistory.messages.map((message) => (
              <MessageRow key={message.id} message={{ id: message.id, role: message.role, text: message.text, ...(message.toolName ? { toolName: message.toolName } : {}), ...(message.isError ? { isError: true } : {}) }} />
            ))}
          </>
        ) : linkUnavailable ? (
          <div className="card" style={{ borderColor: "var(--warning)", backgroundColor: "#1e180d" }}>
            <h4 style={{ color: "var(--warning)", marginBottom: "8px" }}>{historyLive ? "Live host available" : "Live host unavailable"}</h4>
            <p style={{ fontSize: "0.9rem", color: "var(--text-muted)", marginBottom: "12px" }}>
              {historyLive ? "This session is live. Open the live view to read it." : historyLoading ? "Checking for a saved transcript…" : historyError ?? "Host presence is not yet verified. No saved transcript is available; retry to check for a live host."}
            </p>
            {(historyLive || !historyLoading) && <button type="button" className="primary" onClick={() => void retryUnavailableConversation()}>{historyLive ? "Open live view" : "Retry"}</button>}
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
        ) : null}

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
        {activeUiRequest && !linkUnavailable && (
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

            {(transcript.readOnly || linkAccess === "view") ? (
              <p role="note">Read-only link — this request cannot be answered here.</p>
            ) : activeUiRequest.kind === "select" ? (
              <>
                {activeUiRequest.helpText && <p style={{ marginBottom: "8px", color: "var(--text-muted)" }}>{activeUiRequest.helpText}</p>}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
                  {activeUiRequest.options.map((option, index) => {
                    const label = typeof option === "string" ? option : option.label;
                    const checked = activeUiRequest.checkedIndices?.includes(index) ?? false;
                    const selected = activeUiRequest.initialIndex === index || checked;
                    return (
                      <button key={`${activeUiRequest.reqId}-${index}-${label}`} type="button" className={/\b(deny|reject|decline|refuse|disallow|cancel|no)\b/i.test(label) ? "approval-deny" : "primary"} disabled={transcript.readOnly} onClick={() => handleUiResponse(label, activeUiRequest.reqId)}>
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
                <textarea value={uiEditorValue} onChange={(event) => setUiEditorValue(event.target.value)} rows={4} readOnly={transcript.readOnly} />
                <button type="button" className="primary" disabled={transcript.readOnly} onClick={() => handleUiResponse(uiEditorValue, activeUiRequest.reqId)}>Submit</button>
              </>
            )}
          </div>
        )}


        </div>
      </div>
      {!linkUnavailable && !transcript.readOnly && isDetached && commandSuggestions.length === 0 && !interceptedCommand && (
        <div className="latest-row">
          <button type="button" className="latest-button" onClick={goToLatest}>↓ Latest</button>
        </div>
      )}
      {canWriteToHost && commandSuggestions.length > 0 && !interceptedCommand && !linkUnavailable && (
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
      {canWriteToHost && interceptedCommand && !linkUnavailable && (
        <div className="slash-command-intercept">
          <strong>{interceptedCommand.name}</strong>
          <p>{interceptedCommand.explanation}</p>
          {interceptedCommand.availability === "terminal_only" && <p>Terminal only — not sent to the live session.</p>}
          {interceptedCommand.availability === "app_action" && (
            <button type="button" onClick={openCommandAction}>Open model controls</button>
          )}
          <button type="button" className="primary" disabled={transcript.readOnly} onClick={sendSlashAsText}>Send as plain text anyway</button>
          <button type="button" className="ghost" onClick={() => setInterceptedCommand(null)}>Cancel</button>
        </div>
      )}
      {canWriteToHost && !linkUnavailable && !isShowingSavedHistory && !historyLive && (
      <form onSubmit={handleSendPrompt} className="composer-container">
        <textarea
          className="composer-input"
          placeholder={transcript.readOnly ? "Read-only — not sent" : status === "running" ? "Turn in flight — send a follow-up…" : "Send instructions to agent…"}
          value={inputText}
          ref={composerRef}
          onChange={(event) => updateDraft(event.target.value)}
          disabled={transcript.readOnly || status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
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
          disabled={transcript.readOnly || !inputText.trim() || status === "disconnected" || status === "unknown" || status === "connecting" || status === "reconnecting"}
          style={{ minHeight: "44px", minWidth: "64px" }}
        >
          Send
        </button>
      {sendError && <div className="banner unknown" role="alert">{sendError}</div>}
      </form>
      )}

      {/* Subagent Panel Modal */}
      {showSubagents && (
        <SubagentPanel
          agents={agents}
          onFetchTranscript={handleFetchTranscript}
          onWatchAgent={handleWatchTranscript}
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
