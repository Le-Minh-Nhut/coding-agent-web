import type {
  AgentSnapshot,
  AssistantMessage,
  CollabUiRequest,
  HostFrame,
  SessionEntry,
  SessionState,
  TextContent,
  WireMessage,
} from "@caw/collab-protocol";

export interface TranscriptMessage {
  /** Durable entry ID when available; otherwise stable for the live message's lifetime. */
  id: string;
  /** Durable rows use their entry ID; event-only rows use a synthesized correlation key. */
  identity: string;
  /** Correlates an event-only row with its durable entry when one arrives. */
  eventIdentity?: string;
  role: "user" | "assistant" | "tool";
  text: string;
  toolName?: string;
  isError?: boolean;
  isRunning?: boolean;
  source: "entry" | "event";
}

export interface TranscriptReply {
  text: string;
  newSize: number;
  error?: string;
}

export type TurnStatus = "idle" | "running";
export type ConnectionStatus = "connecting" | "live" | "reconnecting" | "unknown" | "disconnected";

type QueuedLiveFrame = Extract<HostFrame, { t: "entry" | "event" }>;

interface PendingSnapshot {
  entries: SessionEntry[];
  live: QueuedLiveFrame[];
  total: number;
}

export interface TranscriptState {
  entries: SessionEntry[];
  messages: TranscriptMessage[];
  pendingSnapshot: PendingSnapshot | null;
  agents: AgentSnapshot[];
  nextLiveMessageId: number;
  streamingMessage: AssistantMessage | null;
  turnStatus: TurnStatus;
  connectionStatus: ConnectionStatus;
  error: string | null;
  notice: { level: "info" | "warning" | "error"; message: string } | null;
  uiRequests: { current: CollabUiRequest | null; queue: CollabUiRequest[] };
  lastUiRequestSettlement: number | null;
  transcriptRequests: Record<string, string>;
  transcripts: Record<string, TranscriptReply>;
}
export function createTranscriptState(): TranscriptState {
  return {
    entries: [],
    messages: [],
    pendingSnapshot: null,
    agents: [],
    streamingMessage: null,
    turnStatus: "idle",
    connectionStatus: "connecting",
    error: null,
    notice: null,
    uiRequests: { current: null, queue: [] },
    lastUiRequestSettlement: null,
    transcriptRequests: {},
    nextLiveMessageId: 0,
    transcripts: {},
  };
}

export function trackTranscriptRequest(state: TranscriptState, reqId: number, agentId: string): TranscriptState {
  return {
    ...state,
    transcriptRequests: { ...state.transcriptRequests, [reqId]: agentId },
  };
}

export function forgetTranscriptRequest(state: TranscriptState, reqId: number): TranscriptState {
  if (!(String(reqId) in state.transcriptRequests)) return state;
  const transcriptRequests = { ...state.transcriptRequests };
  delete transcriptRequests[String(reqId)];
  return { ...state, transcriptRequests };
}

export function clearTranscriptRequests(state: TranscriptState): TranscriptState {
  return Object.keys(state.transcriptRequests).length === 0
    ? state
    : { ...state, transcriptRequests: {} };
}

export function setConnectionStatus(state: TranscriptState, connectionStatus: ConnectionStatus): TranscriptState {
  return { ...state, connectionStatus };
}

function messageCorrelation(message: WireMessage): string {
  if (message.role === "toolResult") return `tool:${message.toolCallId}`;
  return `message:${message.role}:${message.timestamp}:${JSON.stringify(message.content)}`;
}
function textFromContent(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string"
    ? content
    : content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("");
}

function displayMessage(entry: SessionEntry): TranscriptMessage | null {
  if (entry.type === "custom_message") {
    if (entry.customType !== "collab-prompt") return null;
    return {
      id: entry.id,
      identity: entry.id,
      role: "user",
      text: textFromContent(entry.content),
      source: "entry",
    };
  }
  if (entry.type !== "message") return null;
  const message = entry.message;
  switch (message.role) {
    case "user":
      return { id: entry.id, identity: entry.id, eventIdentity: messageCorrelation(message), role: "user", text: textFromContent(message.content), source: "entry" };
    case "assistant":
      return { id: entry.id, identity: entry.id, eventIdentity: messageCorrelation(message), role: "assistant", text: textFromContent(message.content), source: "entry" };
    case "toolResult":
      return {
        id: entry.id,
        identity: entry.id,
        eventIdentity: messageCorrelation(message),
        role: "tool",
        text: textFromContent(message.content),
        toolName: message.toolName,
        isError: message.isError,
        source: "entry",
      };
    default:
      return null;
  }
}

function upsertMessage(messages: TranscriptMessage[], next: TranscriptMessage): TranscriptMessage[] {
  // Two distinct native entries must never share a row, and one native entry must never produce two rows.
  const pairedSource = next.source === "entry" ? "event" : "entry";
  const paired = next.eventIdentity === undefined ? -1 : messages.findIndex((message) =>
    message.source === pairedSource && message.eventIdentity === next.eventIdentity,
  );
  const index = paired >= 0 ? paired : messages.findIndex((message) => message.identity === next.identity);
  if (index < 0) return [...messages, next];
  if (paired >= 0) {
    const updated = [...messages];
    updated[index] = messages[index]!.source === "entry"
      ? { ...messages[index]!, eventIdentity: undefined }
      : { ...next, eventIdentity: undefined };
    return updated;
  }
  if (messages[index]!.source === "entry" && next.source === "event") return messages;
  const updated = [...messages];
  updated[index] = next;
  return updated;
}

function addEntry(state: TranscriptState, entry: SessionEntry): TranscriptState {
  const index = state.entries.findIndex((candidate) => candidate.id === entry.id);
  const entries = [...state.entries];
  if (index < 0) entries.push(entry);
  else entries[index] = entry;
  const row = displayMessage(entry);
  return {
    ...state,
    entries,
    messages: row ? upsertMessage(state.messages, row) : state.messages,
  };
}

function liveMessage(message: WireMessage, sequence: number): TranscriptMessage | null {
  const eventIdentity = messageCorrelation(message);
  const identity = message.role === "toolResult" ? eventIdentity : `event:${sequence}`;
  const id = `live:${identity}`;
  switch (message.role) {
    case "assistant":
      return { id, identity, eventIdentity, role: "assistant", text: textFromContent(message.content), source: "event" };
    case "user":
      return { id, identity, eventIdentity, role: "user", text: textFromContent(message.content), source: "event" };
    case "toolResult":
      return {
        id,
        identity,
        eventIdentity,
        role: "tool",
        text: textFromContent(message.content),
        toolName: message.toolName,
        isError: message.isError,
        source: "event",
      };
    default:
      return null;
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function toolRow(toolCallId: string, toolName: string, text: string, isRunning: boolean, isError?: boolean): TranscriptMessage {
  return {
    id: `live:tool:${toolCallId}`,
    identity: `tool:${toolCallId}`,
    eventIdentity: `tool:${toolCallId}`,
    role: "tool",
    text,
    toolName,
    isRunning,
    isError,
    source: "event",
  };
}

function applyEvent(state: TranscriptState, event: Extract<HostFrame, { t: "event" }>["event"]): TranscriptState {
  if (event.type === "turn_start" || event.type === "agent_start") return { ...state, turnStatus: "running" };
  if (event.type === "turn_end" || event.type === "agent_end") return { ...state, turnStatus: "idle", streamingMessage: null };
  if ((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant") {
    return { ...state, streamingMessage: event.message };
  }
  if (event.type === "message_end") {
    const row = liveMessage(event.message, state.nextLiveMessageId);
    return {
      ...state,
      nextLiveMessageId: row ? state.nextLiveMessageId + 1 : state.nextLiveMessageId,
      streamingMessage: event.message.role === "assistant" ? null : state.streamingMessage,
      messages: row ? upsertMessage(state.messages, row) : state.messages,
    };
  }
  if (event.type === "tool_execution_start") {
    return { ...state, messages: upsertMessage(state.messages, toolRow(event.toolCallId, event.toolName, stringify(event.args), true)) };
  }
  if (event.type === "tool_execution_update") {
    return { ...state, messages: upsertMessage(state.messages, toolRow(event.toolCallId, event.toolName, stringify(event.partialResult), true)) };
  }
  if (event.type === "tool_execution_end") {
    const result = typeof event.result === "string" ? event.result : stringify(event.result);
    return { ...state, messages: upsertMessage(state.messages, toolRow(event.toolCallId, event.toolName, result, false, event.isError)) };
  }
  if (event.type === "notice") return { ...state, notice: { level: event.level, message: event.message } };
  if (event.type === "auto_compaction_start") {
    return { ...state, notice: { level: "info", message: `Compacting context (${event.reason})` } };
  }
  if (event.type === "auto_compaction_end") {
    return event.skipped ? state : {
      ...state,
      notice: {
        level: event.errorMessage ? "error" : "info",
        message: event.aborted ? "Context compaction aborted" : event.errorMessage ? `Context compaction failed: ${event.errorMessage}` : "Context compacted",
      },
    };
  }
  if (event.type === "auto_retry_start") {
    return { ...state, notice: { level: "info", message: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` } };
  }
  if (event.type === "auto_retry_end") {
    return event.success ? { ...state, notice: { level: "info", message: "Retry succeeded" } } : {
      ...state,
      notice: { level: "error", message: event.finalError ?? "Retry failed" },
    };
  }
  if (event.type === "thinking_level_changed") {
    return { ...state, notice: { level: "info", message: `Thinking level: ${event.thinkingLevel ?? "default"}` } };
  }
  // Non-assistant message starts/updates have no stable partial-row contract; final content is handled on message_end.
  return state;
}

function applyLiveFrame(state: TranscriptState, frame: QueuedLiveFrame): TranscriptState {
  return frame.t === "entry" ? addEntry(state, frame.entry) : applyEvent(state, frame.event);
}

function applyTranscript(state: TranscriptState, frame: Extract<HostFrame, { t: "transcript" }>): TranscriptState {
  const agentId = state.transcriptRequests[String(frame.reqId)];
  if (agentId === undefined) return state;
  const transcriptRequests = { ...state.transcriptRequests };
  delete transcriptRequests[String(frame.reqId)];
  return {
    ...state,
    transcriptRequests,
    transcripts: {
      ...state.transcripts,
      [agentId]: { text: frame.text, newSize: frame.newSize, ...(frame.error !== undefined ? { error: frame.error } : {}) },
    },
  };
}

function settleUiRequest(state: TranscriptState, reqId: number): TranscriptState {
  const { current, queue } = state.uiRequests;
  return {
    ...state,
    lastUiRequestSettlement: reqId,
    uiRequests: current?.reqId === reqId
      ? { current: queue[0] ?? null, queue: queue.slice(1) }
      : { current, queue: queue.filter((request) => request.reqId !== reqId) },
  };
}

function addUiRequest(state: TranscriptState, request: CollabUiRequest): TranscriptState {
  if (state.uiRequests.current?.reqId === request.reqId || state.uiRequests.queue.some((item) => item.reqId === request.reqId)) return state;
  if (!state.uiRequests.current) return { ...state, uiRequests: { current: request, queue: [] } };
  return { ...state, uiRequests: { current: state.uiRequests.current, queue: [...state.uiRequests.queue, request] } };
}

function withSessionState(state: TranscriptState, session: SessionState): TranscriptState {
  return { ...state, turnStatus: session.isStreaming ? "running" : "idle" };
}

/**
 * Pure Collab transcript reducer. A welcome starts replacement snapshot; chunks
 * stay private until final (or entry count reached), then snapshot entries publish
 * in order before queued live entries/events. Durable rows use entry IDs; live
 * event rows are paired one-to-one with durable twins by message correlation.
 */
export function reduceHostFrame(state: TranscriptState, frame: HostFrame): TranscriptState {
  switch (frame.t) {
    case "welcome": {
      const base = {
        ...state,
        agents: [...frame.agents],
        connectionStatus: "live" as const,
        error: null,
        turnStatus: frame.state.isStreaming ? "running" as const : "idle" as const,
        streamingMessage: null,
        uiRequests: { current: null, queue: [] },
      };
      return frame.entryCount === 0
        ? { ...base, entries: [], messages: [], pendingSnapshot: null }
        : { ...base, pendingSnapshot: { entries: [], live: [], total: frame.entryCount } };
    }
    case "snapshot-chunk": {
      if (state.pendingSnapshot === null) return state;
      const pending = {
        ...state.pendingSnapshot,
        entries: [...state.pendingSnapshot.entries, ...frame.entries],
      };
      if (!frame.final && pending.entries.length < pending.total) return { ...state, pendingSnapshot: pending };
      let published: TranscriptState = {
        ...state,
        entries: [],
        messages: [],
        pendingSnapshot: null,
      };
      for (const entry of pending.entries) published = addEntry(published, entry);
      for (const liveFrame of pending.live) published = applyLiveFrame(published, liveFrame);
      return published;
    }
    case "entry":
      return state.pendingSnapshot
        ? { ...state, pendingSnapshot: { ...state.pendingSnapshot, live: [...state.pendingSnapshot.live, frame] } }
        : addEntry(state, frame.entry);
    case "event":
      return state.pendingSnapshot
        ? { ...state, pendingSnapshot: { ...state.pendingSnapshot, live: [...state.pendingSnapshot.live, frame] } }
        : applyEvent(state, frame.event);
    case "state":
      return withSessionState(state, frame.state);
    case "agents":
      return { ...state, agents: [...frame.agents] };
    case "ui-request":
      return addUiRequest(state, frame.request);
    case "ui-request-end":
      return settleUiRequest(state, frame.reqId);
    case "transcript":
      return applyTranscript(state, frame);
    case "error":
      return { ...state, connectionStatus: "unknown", error: frame.message };
    case "bye":
      return { ...state, connectionStatus: "disconnected", error: frame.reason };
    case "bus": {
      const data = frame.data && typeof frame.data === "object"
        ? frame.data as { agent?: unknown; task?: unknown; status?: unknown; description?: unknown; progress?: { status?: unknown } }
        : {};
      if (frame.channel === "task:subagent:progress") {
        const agent = typeof data.agent === "string" ? data.agent : "Subagent";
        const task = typeof data.task === "string" ? data.task : "task progress";
        const status = typeof data.progress?.status === "string" ? ` (${data.progress.status})` : "";
        return { ...state, notice: { level: "info", message: `${agent}: ${task}${status}` } };
      }
      const agent = typeof data.agent === "string" ? data.agent : "Subagent";
      const description = typeof data.description === "string" ? `: ${data.description}` : "";
      const status = typeof data.status === "string" ? data.status : "updated";
      return { ...state, notice: { level: "info", message: `${agent} ${status}${description}` } };
    }
  }
}
