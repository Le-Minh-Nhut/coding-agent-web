import type {
  AgentSnapshot,
  AssistantMessage,
  CollabUiRequest,
  HostFrame,
  SessionEntry,
  SessionState,
  WireMessage,
} from "@caw/collab-protocol";

export interface TranscriptMessage {
  /** Durable entry ID when available; otherwise stable for the live message's lifetime. */
  id: string;
  /** Durable rows use their entry ID; event-only rows use a synthesized correlation key. */
  identity: string;
  /** Correlates an event-only row with its durable entry when one arrives. */
  eventIdentity?: string;
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  toolName?: string;
  isError?: boolean;
  isRunning?: boolean;
  source: "entry" | "event";
}

export interface TranscriptReply {
  text: string;
  newSize: number;
  carry?: string;
  error?: string;
}

export interface TranscriptRequest {
  agentId: string;
  fromByte: number;
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
  sessionEnded: boolean;
  readOnly: boolean;
  error: string | null;
  notice: { level: "info" | "warning" | "error"; message: string } | null;
  uiRequests: { current: CollabUiRequest | null; queue: CollabUiRequest[] };
  lastUiRequestSettlement: number | null;
  transcriptRequests: Record<string, TranscriptRequest>;
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
    sessionEnded: false,
    readOnly: false,
    error: null,
    notice: null,
    uiRequests: { current: null, queue: [] },
    lastUiRequestSettlement: null,
    transcriptRequests: {},
    nextLiveMessageId: 0,
    transcripts: {},
  };
}

export function trackTranscriptRequest(state: TranscriptState, reqId: number, agentId: string, fromByte = 0): TranscriptState {
  return {
    ...state,
    transcriptRequests: { ...state.transcriptRequests, [reqId]: { agentId, fromByte } },
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
export function textFromContent(content: string | readonly { type: string; text?: string; mimeType?: string; data?: string; thinking?: string; name?: string; arguments?: unknown; intent?: string }[]): string {
  if (typeof content === "string") return content;
  let text = "";
  let afterBlock = false;
  for (const part of content) {
    if (part.type === "text") {
      if (afterBlock && text && !text.endsWith("\n")) text += "\n";
      text += part.text ?? "";
      afterBlock = false;
      continue;
    }
    if (text && !text.endsWith("\n")) text += "\n";
    if (part.type === "image" && /^(?:image\/(?:png|jpeg|gif|webp|avif))$/.test(part.mimeType ?? "") && part.data) {
      text += `![Attachment](data:${part.mimeType};base64,${part.data})`;
    } else if (part.type === "image") {
      text += `[Image attachment not displayed${part.mimeType ? ` (${part.mimeType})` : ""}]`;
    } else if (part.type === "thinking") {
      text += `[Reasoning]\n${part.thinking ?? ""}`;
    } else if (part.type === "redactedThinking") {
      text += "[Reasoning redacted by host]";
    } else if (part.type === "toolCall") {
      const intent = part.intent ? ` — ${part.intent}` : "";
      text += `[Tool call: ${part.name ?? "unknown"}${intent}] ${JSON.stringify(part.arguments ?? {}, null, 2)}`;
    } else {
      text += `[Unsupported content: ${part.type}]`;
    }
    afterBlock = true;
  }
  return text;
}


function displayMessage(entry: SessionEntry): TranscriptMessage | null {
  if (entry.type === "custom_message") {
    if (entry.customType === "collab-prompt") {
      return {
        id: entry.id,
        identity: entry.id,
        role: "user",
        text: textFromContent(entry.content),
        source: "entry",
      };
    }
    if (!entry.display) return null;
    return {
      id: entry.id,
      identity: entry.id,
      role: "notice",
      text: `${entry.customType}: ${textFromContent(entry.content)}`,
      source: "entry",
    };
  }
  if (entry.type === "compaction") return {
    id: entry.id,
    identity: entry.id,
    role: "notice",
    text: `Context compacted (${entry.tokensBefore} tokens): ${entry.shortSummary ?? entry.summary}`,
    source: "entry",
  };
  if (entry.type === "branch_summary") return {
    id: entry.id,
    identity: entry.id,
    role: "notice",
    text: `Branch summary: ${entry.summary}`,
    source: "entry",
  };
  if (entry.type === "model_change") return {
    id: entry.id,
    identity: entry.id,
    role: "notice",
    text: `Model changed: ${entry.model}`,
    source: "entry",
  };
  if (entry.type === "thinking_level_change") return {
    id: entry.id,
    identity: entry.id,
    role: "notice",
    text: `Thinking level changed: ${entry.thinkingLevel ?? "off"}`,
    source: "entry",
  };
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
    case "developer":
      return { id: entry.id, identity: entry.id, role: "notice", text: `Developer message: ${textFromContent(message.content)}`, source: "entry" };
    default:
      return null;
  }

}
export function transcriptMessagesFromEntries(entries: readonly SessionEntry[]): TranscriptMessage[] {
  return entries.flatMap((entry) => {
    const message = displayMessage(entry);
    return message ? [message] : [];
  });
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

function addEntriesBatch(state: TranscriptState, batch: readonly SessionEntry[]): TranscriptState {
  const entries = state.entries.slice();
  const messages = state.messages.slice();
  const entryIndexes = new Map(entries.map((entry, index) => [entry.id, index]));
  const identities = new Map<string, number[]>();
  const eventIdentities = new Map<string, number[]>();
  const addIndex = (map: Map<string, number[]>, key: string | undefined, index: number) => {
    if (key === undefined) return;
    const indices = map.get(key);
    if (indices) indices.push(index);
    else map.set(key, [index]);
  };
  const indexMessage = (message: TranscriptMessage, index: number) => {
    addIndex(identities, message.identity, index);
    addIndex(eventIdentities, message.eventIdentity === undefined ? undefined : `${message.source}:${message.eventIdentity}`, index);
  };
  messages.forEach(indexMessage);
  const findIndex = (map: Map<string, number[]>, key: string | undefined, matches: (message: TranscriptMessage) => boolean) =>
    key === undefined ? -1 : map.get(key)?.find((index) => matches(messages[index]!)) ?? -1;
  const upsert = (next: TranscriptMessage) => {
    const pairedSource = next.source === "entry" ? "event" : "entry";
    const paired = findIndex(eventIdentities, `${pairedSource}:${next.eventIdentity}`, (message) => message.source === pairedSource && message.eventIdentity === next.eventIdentity);
    const index = paired >= 0 ? paired : findIndex(identities, next.identity, (message) => message.identity === next.identity);
    if (index < 0) {
      const newIndex = messages.push(next) - 1;
      indexMessage(next, newIndex);
      return;
    }
    if (paired >= 0) {
      const previous = messages[index]!;
      const replacement = previous.source === "entry"
        ? { ...previous, eventIdentity: undefined }
        : { ...next, eventIdentity: undefined };
      messages[index] = replacement;
      indexMessage(replacement, index);
    } else if (!(messages[index]!.source === "entry" && next.source === "event")) {
      messages[index] = next;
      indexMessage(next, index);
    }
  };
  for (const entry of batch) {
    const index = entryIndexes.get(entry.id);
    if (index === undefined) {
      entryIndexes.set(entry.id, entries.push(entry) - 1);
    } else entries[index] = entry;
    const row = displayMessage(entry);
    if (row) upsert(row);
  }
  return { ...state, entries, messages };
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
    case "developer":
      return { id, identity, role: "notice", text: `Developer message: ${textFromContent(message.content)}`, source: "event" };
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
  const request = state.transcriptRequests[String(frame.reqId)];
  if (!request) return state;
  const transcriptRequests = { ...state.transcriptRequests };
  delete transcriptRequests[String(frame.reqId)];
  const previous = state.transcripts[request.agentId] ?? { text: "", newSize: 0, carry: "" };
  if (frame.error !== undefined) {
    return {
      ...state,
      transcriptRequests,
      transcripts: { ...state.transcripts, [request.agentId]: { ...previous, error: frame.error } },
    };
  }
  if (request.fromByte !== previous.newSize) return { ...state, transcriptRequests };
  const reset = frame.newSize < previous.newSize;
  if (reset && frame.text === "" && request.fromByte >= frame.newSize) {
    return {
      ...state,
      transcriptRequests,
      transcripts: { ...state.transcripts, [request.agentId]: { text: "", newSize: 0, carry: "" } },
    };
  }
  const base = reset ? { text: "", carry: "" } : previous;
  const combined = `${base.carry ?? ""}${frame.text}`;
  const lastNewline = combined.lastIndexOf("\n");
  const complete = lastNewline < 0 ? "" : combined.slice(0, lastNewline + 1);
  const carry = lastNewline < 0 ? combined : combined.slice(lastNewline + 1);
  return {
    ...state,
    transcriptRequests,
    transcripts: {
      ...state.transcripts,
      [request.agentId]: {
        text: `${base.text}${complete}`,
        newSize: frame.newSize,
        carry,
      },
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
  return state.sessionEnded
    ? { ...state, connectionStatus: "disconnected", turnStatus: session.isStreaming ? "running" : "idle" }
    : { ...state, connectionStatus: "live", turnStatus: session.isStreaming ? "running" : "idle", error: null };
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
        sessionEnded: false,
        readOnly: frame.readOnly ?? false,
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
      const published = addEntriesBatch({ ...state, entries: [], messages: [], pendingSnapshot: null }, pending.entries);
      return pending.live.reduce(applyLiveFrame, published);
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
      return { ...state, error: frame.message };
    case "bye":
      return { ...state, connectionStatus: "disconnected", sessionEnded: true, error: frame.reason };
    case "bus": {
      const data = frame.data && typeof frame.data === "object"
        ? frame.data as { agent?: unknown; task?: unknown; status?: unknown; description?: unknown; progress?: { status?: unknown; currentTool?: unknown } }
        : {};
      const status = frame.channel === "task:subagent:progress" ? data.progress?.status : data.status;
      const level = status === "failed" ? "error" : status === "aborted" ? "warning" : "info";
      if (frame.channel === "task:subagent:progress") {
        const agent = typeof data.agent === "string" ? data.agent : "Subagent";
        const task = typeof data.task === "string" ? data.task : "task progress";
        const progress = typeof status === "string" ? ` (${status})` : "";
        const tool = typeof data.progress?.currentTool === "string" ? ` · ${data.progress.currentTool}` : "";
        return { ...state, notice: { level, message: `${agent}: ${task}${progress}${tool}` } };
      }
      const agent = typeof data.agent === "string" ? data.agent : "Subagent";
      const description = typeof data.description === "string" ? `: ${data.description}` : "";
      const lifecycle = typeof status === "string" ? status : "updated";
      return { ...state, notice: { level, message: `${agent} ${lifecycle}${description}` } };
    }
  }
}
