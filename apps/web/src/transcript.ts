import type {
  AgentSnapshot,
  AssistantMessage,
  CollabUiRequest,
  HostFrame,
  SessionEntry,
  SessionState,
  WireMessage,
} from "@caw/collab-protocol";

export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; arguments: unknown; intent?: string; id?: string }
  | { type: "image"; label: string; dataUrl?: string }
  | { type: "notice"; text: string };

export interface TranscriptMessage {
  /** Durable entry ID when available; otherwise stable for the live message's lifetime. */
  id: string;
  /** Durable rows use their entry ID; event-only rows use a synthesized correlation key. */
  identity: string;
  /** Correlates an event-only row with its durable entry when one arrives. */
  eventIdentity?: string;
  role: "user" | "assistant" | "tool" | "notice";
  text: string;
  blocks?: TranscriptBlock[];
  toolName?: string;
  isError?: boolean;
  isRunning?: boolean;
  source: "entry" | "event";
  /** Wire tool-call id: pairs a tool result row with the call that produced it. */
  toolCallId?: string;
  /** Wire arguments for a live tool row, when the event carried them. */
  toolArgs?: Record<string, unknown>;
  /**
   * Structured tool result, kept alongside the flattened `text` so the tool
   * renderers can read `details` (diffs, per-file results) instead of parsing
   * prose. `undefined` means the transport carried no structured result — the
   * renderer must then say so rather than inventing an outcome.
   */
  toolResult?: ToolResultLike;
  /**
   * The `customType` of the entry this row came from, when it was a custom
   * message. Kept because a few host types need dedicated rendering — an advisor
   * card carries structured note/severity data that the flattened text loses.
   */
  customType?: string;
  /** The entry's `details` payload, verbatim, for those same renderers. */
  customDetails?: unknown;
}

/** Structural mirror of the guest renderer's `ToolResultLike` (no host import). */
export interface ToolResultLike {
  content: readonly { type: string; text?: string; mimeType?: string; data?: string }[];
  details?: unknown;
  isError?: boolean;
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
  /**
   * The one live protocol notice, as the host sent it.
   *
   * Single-slot by design (a newer notice displaces the older one): this is the
   * same reducer field it has always been, and no second store is introduced.
   * How it *renders* is the level's business, not the reducer's — `error` keeps a
   * bounded alert row, `warning` a bounded warning row, and `info` (which carries
   * routine participant chatter like "… joined the collab session") a quiet muted
   * line, so a join can no longer occupy a bright full-width bar. The text is
   * never truncated: a long notice is clamped visually and expands on tap.
   */
  notice: { level: "info" | "warning" | "error"; message: string } | null;
  /**
   * Live agent activity, keyed by agent id — the structured replacement for the
   * old unbounded `notice` string.
   *
   * A `task:subagent:progress` frame used to be concatenated into one notice
   * (`${agent}: ${task}${progress}${tool}`) whose `task` is the **full** brief, so
   * a multi-page task became a multi-page banner. Here the fields stay separate
   * and the task body is kept whole only for Agent Detail; the compact row uses a
   * bounded preview. Keyed by the host's agent id, so two agents cannot overwrite
   * each other and a reconnect cannot multiply rows.
   */
  agentActivity: Record<string, AgentActivity>;
  uiRequests: { current: CollabUiRequest | null; queue: CollabUiRequest[] };
  lastUiRequestSettlement: number | null;
  transcriptRequests: Record<string, TranscriptRequest>;
  transcripts: Record<string, TranscriptReply>;
}

/**
 * One agent's most recent live activity.
 *
 * `task` is the full text as the host sent it and is never truncated here — the
 * *view* bounds its preview. Losing it would lose the only copy on a live-only
 * channel.
 */
export interface AgentActivity {
  agentId: string;
  agent: string;
  /** Full task body, verbatim. */
  task: string;
  lifecycle: string | null;
  currentTool: string | null;
  status: string | null;
  level: "info" | "warning" | "error";
  /** True when this came from a bus frame, which OMP does not persist. */
  liveOnly: boolean;
  updatedAt: number;
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
    agentActivity: {},
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

/**
 * Structured tool result from untrusted wire JSON.
 *
 * Returns `undefined` — never a synthesized empty result — when the payload is
 * not a `{content: [...]}` record, because "the transport carried no structured
 * result" and "the tool returned nothing" must render differently: only the
 * first is allowed to say "View tool details".
 */
export function toToolResult(value: unknown): ToolResultLike | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as { content?: unknown; details?: unknown; isError?: unknown };
  if (!Array.isArray(record.content)) return undefined;
  const content: { type: string; text?: string; mimeType?: string; data?: string }[] = [];
  for (const block of record.content) {
    if (typeof block !== "object" || block === null) continue;
    const part = block as { type?: unknown; text?: unknown; mimeType?: unknown; data?: unknown };
    if (typeof part.type !== "string") continue;
    content.push({
      type: part.type,
      ...(typeof part.text === "string" ? { text: part.text } : {}),
      ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}),
      ...(typeof part.data === "string" ? { data: part.data } : {}),
    });
  }
  return {
    content,
    ...(record.details === undefined ? {} : { details: record.details }),
    ...(record.isError === true ? { isError: true } : {}),
  };
}

function messageCorrelation(message: WireMessage): string {
  if (message.role === "toolResult") return `tool:${message.toolCallId}`;
  return `message:${message.role}:${message.timestamp}:${JSON.stringify(message.content)}`;
}
export function textFromContent(content: string | readonly { type: string; text?: string; mimeType?: string; data?: string; thinking?: string; name?: string; arguments?: unknown; intent?: string; id?: string }[]): string {
  if (typeof content === "string") return content;
  let text = "";
  let afterBlock = false;
  for (const part of content) {
    const block = transcriptBlocksFromContent([part])[0]!;
    if (block.type === "text") {
      if (afterBlock && text && !text.endsWith("\n")) text += "\n";
      text += block.text;
      afterBlock = false;
      continue;
    }
    if (text && !text.endsWith("\n")) text += "\n";
    if (block.type === "toolCall") text += `[Tool call: ${block.name}${block.intent ? ` — ${block.intent}` : ""}] ${JSON.stringify(block.arguments, null, 2)}`;
    else if (block.type === "image" && block.dataUrl) text += `![Attachment](${block.dataUrl})`;
    else text += block.type === "image" ? block.label : block.text;
    afterBlock = true;
  }
  return text;
}

export function transcriptBlocksFromContent(content: string | readonly { type: string; text?: string; mimeType?: string; data?: string; thinking?: string; name?: string; arguments?: unknown; intent?: string; id?: string }[]): TranscriptBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part): TranscriptBlock => {
    if (part.type === "text") return { type: "text", text: part.text ?? "" };
    if (part.type === "toolCall") return { type: "toolCall", name: part.name ?? "unknown", arguments: part.arguments ?? {}, ...(part.id === undefined ? {} : { id: part.id }), ...(part.intent ? { intent: part.intent } : {}) };
    if (part.type === "image" && /^(?:image\/(?:png|jpeg|gif|webp|avif))$/.test(part.mimeType ?? "") && part.data) return { type: "image", label: "Image attachment", dataUrl: `data:${part.mimeType};base64,${part.data}` };
    if (part.type === "image") return { type: "image", label: `[Image attachment not displayed${part.mimeType ? ` (${part.mimeType})` : ""}]` };
    if (part.type === "thinking") return { type: "notice", text: `[Reasoning]\n${part.thinking ?? ""}` };
    if (part.type === "redactedThinking") return { type: "notice", text: "[Reasoning redacted by host]" };
    return { type: "notice", text: `[Unsupported content: ${part.type}]` };
  });
}


function displayMessage(entry: SessionEntry): TranscriptMessage | null {
  if (entry.type === "custom_message") {
    // A `collab-prompt` is the user's own text and is always a user row. Every
    // OTHER custom message is system chatter (nudges, notices, loop redirects)
    // and OMP marks the ones it intends humans to see with `display: true`;
    // `display: false` — or absent, on records written before the field existed —
    // means hidden, and rendering it would leak internal prompts into the
    // transcript. Absence is checked as truthiness, not `!== false`, because the
    // journals really do omit the field.
    const prompt = entry.customType === "collab-prompt";
    if (!prompt && !entry.display) return null;
    // An advisor card is the one custom message whose payload the UI renders
    // structurally (severity, advisor name, note text), so its type and details
    // ride along on the row. Everything else keeps the flattened-text behaviour
    // it had; the fields are additive and ignored by rows that do not read them.
    const isAdvisor = entry.customType === "advisor";
    const details = entry.details === undefined ? "" : `\n${JSON.stringify(entry.details, null, 2)}`;
    const text = isAdvisor
      // The advisor's own structured details are not repeated as JSON here: the
      // compact card prints the notes themselves, and the raw payload is still
      // reachable through the card's own disclosure.
      ? textFromContent(entry.content)
      : prompt ? textFromContent(entry.content) : `${entry.customType}: ${textFromContent(entry.content)}${details}`;
    return {
      id: entry.id,
      identity: entry.id,
      role: prompt ? "user" : "notice",
      text,
      blocks: transcriptBlocksFromContent(entry.content),
      source: "entry",
      customType: entry.customType,
      ...(entry.details === undefined ? {} : { customDetails: entry.details }),
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
    text: `Branch summary from ${entry.fromId}: ${entry.summary}`,
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
      return { id: entry.id, identity: entry.id, eventIdentity: messageCorrelation(message), role: "user", text: textFromContent(message.content), blocks: transcriptBlocksFromContent(message.content), source: "entry" };
    case "assistant": {
      const blocks = transcriptBlocksFromContent(message.content);
      const content = textFromContent(message.content);
      const isError = message.stopReason === "error" || message.stopReason === "aborted";
      const errorText = message.stopReason === "aborted" ? "Assistant response aborted" : message.errorMessage ?? "Assistant response failed";
      // The failure reason is appended as a trailing block as well as into `text`:
      // when `blocks` exists the renderer shows the blocks, so a suffix that lived
      // only in `text` would vanish the moment the durable entry replaced the live
      // row. Both paths must show the reason.
      return {
        id: entry.id,
        identity: entry.id,
        eventIdentity: messageCorrelation(message),
        role: "assistant",
        text: isError ? `${content}${content ? "\n\n" : ""}${errorText}` : content,
        blocks: isError ? [...blocks, { type: "notice" as const, text: errorText }] : blocks,
        isError,
        source: "entry",
      };
    }
    case "toolResult": {
      const details = message.details === undefined ? "" : `\n${JSON.stringify(message.details, null, 2)}`;
      return {
        id: entry.id,
        identity: entry.id,
        eventIdentity: messageCorrelation(message),
        role: "tool",
        text: `${textFromContent(message.content)}${details}`,
        blocks: transcriptBlocksFromContent(message.content),
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        toolResult: toToolResult(message),
        isError: message.isError,
        source: "entry",
      };
    }
    case "developer":
      return { id: entry.id, identity: entry.id, eventIdentity: messageCorrelation(message), role: "notice", text: `Developer message: ${textFromContent(message.content)}`, blocks: transcriptBlocksFromContent(message.content), source: "entry" };
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
    case "assistant": {
      const content = textFromContent(message.content);
      const isError = message.stopReason === "error" || message.stopReason === "aborted";
      const errorText = message.stopReason === "aborted" ? "Assistant response aborted" : message.errorMessage ?? "Assistant response failed";
      return { id, identity, eventIdentity, role: "assistant", text: isError ? `${content}${content ? "\n\n" : ""}${errorText}` : content, isError, source: "event" };
    }
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
        toolCallId: message.toolCallId,
        toolResult: toToolResult(message),
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

function toolRow(toolCallId: string, toolName: string, text: string, isRunning: boolean, isError?: boolean, toolResult?: ToolResultLike, toolArgs?: Record<string, unknown>): TranscriptMessage {
  return {
    id: `live:tool:${toolCallId}`,
    identity: `tool:${toolCallId}`,
    eventIdentity: `tool:${toolCallId}`,
    role: "tool",
    text,
    toolName,
    toolCallId,
    // Kept structured so a renderer reads the argument it was given instead of
    // re-parsing the JSON string in `text`.
    ...(toolArgs === undefined ? {} : { toolArgs }),
    isRunning,
    isError,
    // A running row carries the streamed partial as `text` but must not claim a
    // completed result; only `tool_execution_end` passes `toolResult`.
    ...(toolResult === undefined ? {} : { toolResult }),
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
    return { ...state, messages: upsertMessage(state.messages, toolRow(event.toolCallId, event.toolName, stringify(event.args), true, undefined, undefined, typeof event.args === "object" && event.args !== null && !Array.isArray(event.args) ? (event.args as Record<string, unknown>) : undefined)) };
  }
  if (event.type === "tool_execution_update") {
    return { ...state, messages: upsertMessage(state.messages, toolRow(event.toolCallId, event.toolName, stringify(event.partialResult), true)) };
  }
  if (event.type === "tool_execution_end") {
    const result = typeof event.result === "string" ? event.result : stringify(event.result);
    // The result already IS the structured payload when the host sends JSON;
    // `toToolResult` returns undefined for anything else so the renderer can say
    // "diff unavailable" rather than parroting a truncated string as success.
    //
    // The end event carries no `args`, and the identity match below replaces the
    // row wholesale, so the arguments captured by `tool_execution_start` would be
    // lost the moment the call finishes — which is exactly when the user opens the
    // row. Carry them forward from the row being replaced.
    const started = state.messages.find((message) => message.identity === `tool:${event.toolCallId}`);
    return { ...state, messages: upsertMessage(state.messages, toolRow(event.toolCallId, event.toolName, result, false, event.isError, toToolResult(event.result), started?.toolArgs)) };
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
        notice: null,
        agentActivity: {},
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
      // Field names are the host's, verified against
      // `packages/tui/src/overlays/session-observer-registry.ts:10-40`:
      //   progress  → { index, agent, task, assignment?, progress: AgentProgress }
      //               and the agent id lives at `progress.id` (`wire/src/index.ts:254-257`)
      //   lifecycle → { id, agent, description?, status, ... } with the id top-level
      const record = frame.data && typeof frame.data === "object" ? (frame.data as Record<string, unknown>) : {};
      const progress = record.progress && typeof record.progress === "object" ? (record.progress as Record<string, unknown>) : null;
      const isProgress = frame.channel === "task:subagent:progress";
      const status = isProgress
        ? (typeof progress?.status === "string" ? progress.status : null)
        : (typeof record.status === "string" ? record.status : null);
      const level = status === "failed" ? "error" : status === "aborted" ? "warning" : "info";
      const agent = typeof record.agent === "string" ? record.agent : "Subagent";
      const agentId = isProgress
        ? (typeof progress?.id === "string" && progress.id !== "" ? progress.id : null)
        : (typeof record.id === "string" && record.id !== "" ? record.id : null);
      if (agentId === null) {
        // Without the host's id there is nothing to attach activity to, and keying
        // on the display name would merge two agents that share one. The generic
        // notice stays bounded and carries no task body, so it cannot become the
        // giant banner this branch used to produce.
        return { ...state, notice: { level, message: `${agent} ${status ?? "updated"}` } };
      }
      const task = isProgress
        ? (typeof record.task === "string" ? record.task : "")
        : (typeof record.description === "string" ? record.description : "");
      const currentTool = typeof progress?.currentTool === "string" ? progress.currentTool : null;
      const previous = state.agentActivity[agentId];
      return {
        ...state,
        agentActivity: {
          ...state.agentActivity,
          [agentId]: {
            agentId,
            agent,
            // The fullest task text seen for this agent is kept: a later frame may
            // carry only a tool update, and this is the only copy of a live-only
            // channel. Bounding happens in the view, never here.
            task: task !== "" ? task : previous?.task ?? "",
            lifecycle: isProgress ? previous?.lifecycle ?? null : status,
            currentTool: currentTool ?? previous?.currentTool ?? null,
            status,
            level,
            liveOnly: true,
            updatedAt: Date.now(),
          },
        },
      };
    }
  }
}
