/**
 * Ported from https://github.com/can1357/oh-my-pi (MIT License)
 * Upstream files:
 * - packages/wire/src/index.ts
 * - packages/coding-agent/src/collab/protocol.ts
 */

export const COLLAB_PROTO = 3;
export const ENVELOPE_HEADER_LENGTH = 4;
export const ROOM_ID_BYTES = 16;
export const ROOM_KEY_BYTES = 32;
export const WRITE_TOKEN_BYTES = 16;
export const DEFAULT_RELAY_URL = "ws://127.0.0.1:7466";

// Content blocks
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  mimeType: string;
  data: string; // base64
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface RedactedThinkingContent {
  type: "redactedThinking";
  data: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  intent?: string;
}

export type AssistantContent = TextContent | ThinkingContent | RedactedThinkingContent | ToolCallContent;

export interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

// Messages
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  synthetic?: boolean;
  timestamp: number;
}

export interface DeveloperMessage {
  role: "developer";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  model: string;
  usage: WireUsage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

// why: upstream wire uses this persisted role and payload shape, not `tool`/`result` (`packages/wire/src/index.ts:91-99`).
// Upstream wire calls tool outputs `toolResult`; `tool` is not a Collab role.
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type WireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

// Session entries
export interface SessionHeader {
  type: "session";
  id: string;
  title?: string;
  timestamp: string;
  cwd: string;
}

export interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: WireMessage;
}

export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  shortSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  model: string;
  role?: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel?: string | null;
}

export type SessionEntry =
  | MessageEntry
  | CustomMessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry;

// Events
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: WireMessage }
  | { type: "message_update"; message: WireMessage }
  | { type: "message_end"; message: WireMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
  | { type: "auto_compaction_start"; reason: string; action: string }
  | { type: "auto_compaction_end"; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "thinking_level_changed"; thinkingLevel?: string };

// State & agents
export interface WireModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number | null;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface Participant {
  name: string;
  role: "host" | "guest";
  readOnly?: boolean;
}

// why: Collab state exposes `isStreaming`; it does not carry a `busy` alias (`packages/wire/src/index.ts:266-278`).
export interface SessionState {
  isStreaming: boolean;
  queuedMessageCount: number;
  sessionName?: string;
  cwd: string;
  model?: WireModel;
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  participants: Participant[];
  isAborting?: boolean;
}

// why: upstream agent snapshots identify display name and tree kind (`packages/wire/src/index.ts:280-289`).
export interface AgentSnapshot {
  id: string;
  displayName: string;
  kind: "main" | "sub";
  parentId?: string;
  status: "running" | "idle" | "parked" | "aborted";
  hasSessionFile: boolean;
  createdAt: number;
  lastActivity: number;
}

export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

// UI Request / approval
export type CollabUiSelectItem = string | { label: string; description?: string };

// why: wire requests preserve `kind`, `title`, and select choices (`packages/wire/src/index.ts:359-376`).
export type CollabUiRequestDraft =
  | {
      kind: "select";
      title: string;
      options: CollabUiSelectItem[];
      initialIndex?: number;
      selectionMarker?: "radio" | "checkbox";
      checkedIndices?: number[];
      markableCount?: number;
      helpText?: string;
    }
  | { kind: "editor"; title: string; prefill?: string };

export type CollabUiRequest = CollabUiRequestDraft & { reqId: number };

// why: upstream prompt frame has no idempotency key; host reads only text/images (`packages/wire/src/index.ts:328-347`; `packages/coding-agent/src/collab/host.ts:997-1011`).
// Guest -> Host frames
export type GuestFrame =
  | { t: "hello"; proto: number; name: string; writeToken?: string }
  | { t: "prompt"; text: string; images?: ImageContent[] }
  | { t: "ui-response"; reqId: number; value?: string }
  | { t: "abort" }
  | { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
  | { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number };

// Host -> Guest frames
export type HostFrame =
  | {
      t: "welcome";
      proto: number;
      header: SessionHeader;
      state: SessionState;
      agents: AgentSnapshot[];
      entryCount: number;
      readOnly?: boolean;
    }
  | { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
  | { t: "entry"; entry: SessionEntry }
  | { t: "event"; event: AgentEvent }
  | { t: "state"; state: SessionState }
  | { t: "bus"; channel: BusChannel; data: unknown }
  | { t: "agents"; agents: AgentSnapshot[] }
  | { t: "ui-request"; request: CollabUiRequest }
  | { t: "ui-request-end"; reqId: number }
  | { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
  | { t: "bye"; reason: string }
  | { t: "error"; message: string };

export type WireFrame = GuestFrame | HostFrame;

// Relay control
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;

export interface ParsedCollabLink {
  wsUrl: string;
  roomId: string;
  key: Uint8Array;
  writeToken?: Uint8Array;
}
