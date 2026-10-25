# Collab Data Model & Client Protocol Specification

This specification documents the exact data model, wire types, cryptography, frame semantics, and client lifecycle required to implement a native mobile web client for the Oh My Pi (OMP) Collab protocol (`COLLAB_PROTO = 3`).

All source citations refer to the extracted upstream source under `/tmp/caw-poc/oh-my-pi`.

---

## 1. TypeScript Wire Grammar Specification

Source definitions live in `packages/wire/src/index.ts` (`@oh-my-pi/pi-wire`), supplemented by host serialization definitions in `packages/coding-agent/src/collab/protocol.ts` and status-line definitions in `packages/tui/src/status-line/types.ts`.

### 1.1 Content Blocks & Messages

```typescript
// packages/wire/src/index.ts:18-21
export interface TextContent {
  type: "text";
  text: string;
}

// packages/wire/src/index.ts:23-29
export interface ImageContent {
  type: "image";
  /** Base64-encoded image data. */
  data: string;
  /** e.g. "image/png". */
  mimeType: string;
}

// packages/wire/src/index.ts:31-34
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

// packages/wire/src/index.ts:36-39
export interface RedactedThinkingContent {
  type: "redactedThinking";
  data: string;
}

// packages/wire/src/index.ts:41-47
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  intent?: string;
}

// packages/wire/src/index.ts:49
export type AssistantContent = TextContent | ThinkingContent | RedactedThinkingContent | ToolCallContent;

// packages/wire/src/index.ts:51
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// packages/wire/src/index.ts:53-60
export interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

// packages/wire/src/index.ts:66-73
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  /** True if the message was injected by the system (e.g. auto-continue). */
  synthetic?: boolean;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
}

// packages/wire/src/index.ts:75-79
export interface DeveloperMessage {
  role: "developer";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

// packages/wire/src/index.ts:81-89
export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  model: string;
  usage: WireUsage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

// packages/wire/src/index.ts:91-99
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

// packages/wire/src/index.ts:101
export type WireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;
```

### 1.2 Session Header & Session Entries

The host filters all internal session entries down to the 6 variants defined in `WIRE_SESSION_ENTRY_TYPES` (`packages/coding-agent/src/collab/host.ts:103-110`).

```typescript
// packages/wire/src/index.ts:108-114
export interface SessionHeader {
  type: "session";
  id: string;
  title?: string;
  timestamp: string;
  cwd: string;
}

// packages/wire/src/index.ts:116-120
export interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

// packages/wire/src/index.ts:122-125
export interface MessageEntry extends EntryBase {
  type: "message";
  message: WireMessage;
}

// packages/wire/src/index.ts:127-133
export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

// packages/wire/src/index.ts:135-141
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  shortSummary?: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

// packages/wire/src/index.ts:143-147
export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
}

// packages/wire/src/index.ts:149-154
export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  /** Model in "provider/modelId" format. */
  model: string;
  role?: string;
}

// packages/wire/src/index.ts:156-159
export interface ThinkingLevelChangeEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel?: string | null;
}

// packages/wire/src/index.ts:161-167
export type SessionEntry =
  | MessageEntry
  | CustomMessageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry;

// packages/wire/src/index.ts:170
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

// packages/wire/src/index.ts:173-175
/** `details` shape of `custom_message` entries with `customType === "collab-prompt"`. */
export interface CollabPromptDetails {
  from?: string;
}
```

### 1.3 State, Participants, and Agent Registry

```typescript
// packages/wire/src/index.ts:204-209
export interface WireModel {
  id: string;
  name: string;
  provider: string;
  contextWindow: number | null;
}

// packages/wire/src/index.ts:211-215
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

// packages/wire/src/index.ts:217-222
export interface Participant {
  name: string;
  role: "host" | "guest";
  /** True when the guest joined through a read-only (view) link. */
  readOnly?: boolean;
}

// packages/wire/src/index.ts:225-236
/** Debounced footer snapshot broadcast by the host. */
export interface SessionState {
  isStreaming: boolean;
  queuedMessageCount: number;
  sessionName?: string;
  /** Host cwd — display only; the guest never chdirs. */
  cwd: string;
  model?: WireModel;
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  participants: Participant[];
  isAborting?: boolean;
}

// packages/tui/src/status-line/types.ts:20-28 and packages/coding-agent/src/collab/protocol.ts:47
/** Host-side session state object before wire transport serialization */
export type CollabSessionState = SessionState & {
  model?: WireModel | Record<string, unknown>; // Host supplies full Model object
  contextUsage?: ContextUsage;
};

// packages/wire/src/index.ts:238-248
export interface AgentSnapshot {
  id: string;
  displayName: string;
  kind: "main" | "sub";
  parentId?: string;
  status: "running" | "idle" | "parked" | "aborted";
  /** Whether the host has a transcript file for this agent (gates remote transcript fetch). */
  hasSessionFile: boolean;
  createdAt: number;
  lastActivity: number;
}
```

### 1.4 Agent Events

These 16 variants correspond exactly to `WIRE_AGENT_EVENT_TYPES` (`packages/coding-agent/src/collab/host.ts:84-101`) and `packages/wire/src/index.ts:181-198`:

```typescript
// packages/wire/src/index.ts:181-198
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: WireMessage }
  /** Carries the FULL accumulating partial message — no delta tracking needed. */
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
```

### 1.5 Subagent Bus Payloads

Mirroring is restricted to `TASK_SUBAGENT_PROGRESS_CHANNEL` and `TASK_SUBAGENT_LIFECYCLE_CHANNEL` (`packages/coding-agent/src/collab/host.ts:111-114`):

```typescript
// packages/wire/src/index.ts:347
export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

// packages/wire/src/index.ts:254-279
export interface AgentProgress {
  index: number;
  id: string;
  agent: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  task: string;
  description?: string;
  lastIntent?: string;
  currentTool?: string;
  currentToolArgs?: string;
  /** Argument key selected for the display preview, when known. */
  currentToolArgsKey?: string;
  /** Intent the model attached to the current call; undefined when that call carried none. */
  currentToolIntent?: string;
  currentToolStartMs?: number;
  recentTools: { tool: string; args: string; argsKey?: string; intent?: string; isError?: boolean; endMs: number }[];
  recentOutput: string[];
  toolCount: number;
  requests: number;
  tokens: number;
  contextTokens?: number;
  contextWindow?: number;
  cost: number;
  durationMs: number;
  resolvedModel?: string;
}

// packages/wire/src/index.ts:281-289
export interface SubagentProgressPayload {
  index: number;
  agent: string;
  task: string;
  parentToolCallId?: string;
  assignment?: string;
  progress: AgentProgress;
  sessionFile?: string;
}

// packages/wire/src/index.ts:291-299
export interface SubagentLifecyclePayload {
  id: string;
  agent: string;
  description?: string;
  status: "started" | "completed" | "failed" | "aborted";
  sessionFile?: string;
  parentToolCallId?: string;
  index: number;
}
```

### 1.6 Collab UI Requests & Responses

```typescript
// packages/wire/src/index.ts:305
export type CollabUiSelectItem = string | { label: string; description?: string };

// packages/wire/src/index.ts:307
export type CollabUiResponseValue = string | undefined;

// packages/wire/src/index.ts:309-324
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
  | {
      kind: "editor";
      title: string;
      prefill?: string;
    };

// packages/wire/src/index.ts:326
export type CollabUiRequest = CollabUiRequestDraft & { reqId: number };
```

### 1.7 Frame Unions & Protocol Version

```typescript
// packages/wire/src/index.ts:401
export const COLLAB_PROTO = 3;

// packages/wire/src/index.ts:328-344
export type GuestFrame =
  | {
      t: "hello";
      proto: number;
      name: string;
      /**
       * base64url write token proving full-link possession; absent for
       * read-only (view) links. The host marks peers without a valid token
       * read-only and rejects their mutating frames.
       */
      writeToken?: string;
    }
  | { t: "prompt"; text: string; images?: ImageContent[] }
  | { t: "ui-response"; reqId: number; value?: CollabUiResponseValue }
  | { t: "abort" }
  | { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
  | { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number };

// packages/wire/src/index.ts:349-385
export type HostFrame =
  | {
      t: "welcome";
      proto: number;
      header: SessionHeader;
      state: SessionState;
      agents: AgentSnapshot[];
      /**
       * Total number of SessionEntry items the host will deliver in the
       * snapshot-chunk frames that follow.
       */
      entryCount: number;
      /** True when this peer joined through a read-only (view) link. */
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

// packages/wire/src/index.ts:386
export type WireFrame = GuestFrame | HostFrame;
```

### 1.8 Relay Control Messages & Link Constants

Relay control messages travel in plaintext JSON over the WebSocket connection (unsealed):

```typescript
// packages/wire/src/index.ts:445-448
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;

// packages/wire/src/index.ts:410-438
export const ENVELOPE_HEADER_LENGTH = 4;
export const ROOM_ID_BYTES = 16;
export const ROOM_KEY_BYTES = 32;
export const WRITE_TOKEN_BYTES = 16;
export const DEFAULT_RELAY_URL = "wss://my.omp.sh";

export interface ParsedCollabLink {
  wsUrl: string;       // "wss://<host[:port]>/r/<roomId>"
  roomId: string;      // Base64URL string (16 bytes)
  key: Uint8Array;     // Exactly 32 bytes (AES-256 key)
  writeToken?: Uint8Array; // 16 bytes if write-enabled, undefined if view-only
}
```

---

## 2. Guest Join Sequence & Snapshot Accumulation

Step-by-step connection flow from link parsing to interactive prompting (`packages/collab-web/src/lib/client.ts`, `packages/collab-web/src/lib/socket.ts`, and `packages/coding-agent/src/collab/host.ts`).

### Step 1: Link Parsing
- Given string link format:
  - Full link: `wss://<host[:port]>/r/<roomId>.<base64url(key ∥ writeToken)>` (secret = 48 bytes)
  - View link: `wss://<host[:port]>/r/<roomId>.<base64url(key)>` (secret = 32 bytes)
  - Compact link: `<roomId>.<key>` (resolves to `DEFAULT_RELAY_URL` = `"wss://my.omp.sh"`)
  - Web deep link: `https://<domain>/#<collab-link>` (fragment extracted first)
- Parsing (`packages/collab-web/src/lib/link.ts:150-189`):
  1. Extract `roomId` and the base64url secret.
  2. Decode secret: if 32 bytes, `key = secret[0..32]`, `writeToken = undefined`. If 48 bytes, `key = secret[0..32]`, `writeToken = secret[32..48]`. Other lengths fail.
  3. Yields `wsUrl = "wss://<host[:port]>/r/<roomId>"`.

### Step 2: WebSocket Connection
- Connect WebSocket to:
  ```text
  `${parsed.wsUrl}?role=guest`
  ```
  (`packages/collab-web/src/lib/socket.ts:112`).
- Binary mode set to `arraybuffer`:
  ```typescript
  ws.binaryType = "arraybuffer";
  ```
- Subprotocols: None.

### Step 3: Cryptography Initialization & First Sealed Frame (`hello`)
- Crypto algorithm: `AES-GCM` (`packages/collab-web/src/lib/codec.ts:10-27`).
- Import key:
  ```typescript
  const cryptoKey = await crypto.subtle.importKey("raw", parsed.key, "AES-GCM", false, ["encrypt", "decrypt"]);
  ```
- Sealed payload structure (`packages/collab-web/src/lib/codec.ts:34-37`):
  ```text
  [12 bytes random IV][AES-GCM ciphertext + 16-byte auth tag]
  ```
- Wire envelope structure (`packages/collab-web/src/lib/link.ts:58-63`):
  ```text
  [4 bytes uint32 BE targetPeer = 0][sealed payload]
  ```
  *(Guest always sends `targetPeer = 0`. Relay rewrites prefix to sender's assigned peerId before delivering to host).*
- On WebSocket `open` (`packages/collab-web/src/lib/client.ts:263-268`), guest MUST immediately send sealed `hello`:
  ```typescript
  {
    t: "hello",
    proto: 3, // COLLAB_PROTO = 3
    name: displayName,
    writeToken: parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined
  }
  ```
- Start 30 s `welcomeTimer` (`WELCOME_TIMEOUT_MS = 30_000`, `packages/collab-web/src/lib/client.ts:79, 190-195`).

### Step 4: Host Verification & Welcome Response
Host `#handleHello` (`packages/coding-agent/src/collab/host.ts:788-845`):
1. Verifies `proto === COLLAB_PROTO (3)`. Mismatch sends `{ t: "error", message: "protocol mismatch..." }` and drops join.
2. Checks session status: if `session.isSessionTransitioning`, sends error and stops.
3. Checks `writeToken` via `timingSafeEqual`: sets `canWrite = true` if matches, else marks peer read-only.
4. Registers peer in `#peers` map with `canWrite` permission.
5. Emits host-to-guest `welcome` frame targeted to `fromPeer` (`packages/coding-agent/src/collab/host.ts:819-830`):
   ```typescript
   {
     t: "welcome",
     proto: 3,
     header: SessionHeader,
     state: SessionState,
     agents: AgentSnapshot[],
     entryCount: number, // Total SessionEntry count across subsequent snapshot-chunk frames
     readOnly?: true     // Present and true if guest has no valid write token
   }
   ```
6. If guest has `canWrite`, host also replays all pending UI requests via targeted `{ t: "ui-request", request }` (`host.ts:832-837`).

### Step 5: Snapshot Chunk Accumulation
Immediately after `welcome`, host transmits chunked history using `sendBatch` (`packages/coding-agent/src/collab/host.ts:831, 915-940`):
- Chunks are bounded by `SNAPSHOT_CHUNK_BYTES = 524_288` (512 KiB) to prevent WebSocket frame drops.
- Format: `{ t: "snapshot-chunk", entries: SessionEntry[], final: boolean }`.
- Empty transcript case: Host transmits one chunk with `entries: []` and `final: true`.

Guest accumulation algorithm (`packages/collab-web/src/lib/client.ts:344-393`):
1. On `welcome`:
   - Store `header`, `state`, `agents`, `readOnly`.
   - Clear existing stream ghost and active tools.
   - If `entryCount === 0`: mark `phase = "live"`.
   - If `entryCount > 0`: initialize `pendingSnapshot = { entries: [], live: [], total: frame.entryCount }`.
   - Arm `snapshotProgressTimer` (30 s, `packages/collab-web/src/lib/client.ts:82, 307-313`).
2. On `snapshot-chunk`:
   - Append `frame.entries` to `pendingSnapshot.entries`.
   - If `!frame.final && pendingSnapshot.entries.length < pendingSnapshot.total`: reset 30 s progress timer.
   - If `frame.final === true` OR `pendingSnapshot.entries.length >= pendingSnapshot.total`:
     - Concatenate accumulated snapshot entries + any live `entry` frames received during loading (`pendingSnapshot.live`).
     - Commit to published transcript.
     - Clear `pendingSnapshot`.
     - Clear progress timer.
     - Transition connection `phase = "live"`.
3. If an `entry` frame arrives while `pendingSnapshot !== null`:
   - Push to `pendingSnapshot.live` (`packages/collab-web/src/lib/client.ts:401-404`). Do NOT render yet.

### Step 6: When is Client Allowed to Prompt?
- **Host permission gate** (`packages/coding-agent/src/collab/host.ts:741-744, 769-786`):
  1. Guest must have sent `hello` with valid `writeToken`. If read-only, rejected with: `prompting is disabled on a read-only link`.
  2. Host must have finished startup (`#guestActionsReady()`): if still starting up, rejected with: `prompting is unavailable until the host finishes starting up`.
  3. Session must not be transitioning (`!isSessionTransitioning`).
- **Client UX condition** (`packages/collab-web/src/lib/client.ts:50-75, 216-218`):
  - Client state must have `phase === "live"`.
  - Client must have `readOnly === false`.
  - Composer input should be disabled during `"connecting"`, `"waiting"` (welcome), and while `loading` (accumulating snapshot chunks).

---

## 3. Client Egress Operations

All guest frames travel as JSON sealed with AES-256-GCM (fresh 12-byte IV prepended) and packed in the 4-byte BE envelope (`[0x00, 0x00, 0x00, 0x00][IV][Ciphertext+Tag]`).

### 3.1 Prompt Submission
- **Method**: `packages/collab-web/src/lib/client.ts:216-218`
- **Frame Shape**:
  ```typescript
  {
    t: "prompt",
    text: string,
    images?: Array<{
      type: "image",
      data: string, // Base64 data
      mimeType: string // e.g. "image/png"
    }>
  }
  ```
- **Host handling** (`packages/coding-agent/src/collab/host.ts:996-1029`):
  - Injected as `custom_message` with `customType: "collab-prompt"` (`COLLAB_PROMPT_MESSAGE_TYPE`).
  - Attribution: `"user"`.
  - Details: `{ from: guestName }`.
  - Steers live generation if agent is already working (`streamingBehavior: "steer"`).

### 3.2 Abort / Interrupt
- **Method**: `packages/collab-web/src/lib/client.ts:228-230`
- **Frame Shape**:
  ```typescript
  {
    t: "abort"
  }
  ```
- **Host handling** (`packages/coding-agent/src/collab/host.ts:1048-1062`):
  - Invokes `session.abort({ reason: USER_INTERRUPT_LABEL })`.
  - Emits notice: `"<guestName> interrupted"`.

### 3.3 UI Response
- **Method**: `packages/collab-web/src/lib/client.ts:220-226`
- **Frame Shape**:
  ```typescript
  {
    t: "ui-response",
    reqId: number,
    value?: string // string value selected/entered, or undefined on cancel
  }
  ```
- **Host handling** (`packages/coding-agent/src/collab/host.ts:942-964`):
  - Resolves pending host-side dialog `Promise`.
  - Broadcasts `{ t: "ui-request-end", reqId }` to all guests.

### 3.4 Subagent Management (`agent-cmd`)
- **Method**: `packages/collab-web/src/lib/client.ts:232-234`
- **Frame Shape**:
  ```typescript
  {
    t: "agent-cmd",
    cmd: "chat" | "kill" | "revive",
    agentId: string,
    text?: string // Required for "chat", omitted for "kill" / "revive"
  }
  ```
- **Host handling** (`packages/coding-agent/src/collab/host.ts:1167-1216`):
  - `"chat"`: Ensures subagent session is live and prompts it (`session.prompt(text, { streamingBehavior: "steer" })`).
  - `"kill"`: Aborts subagent if running and releases with `{ tombstone: true }`.
  - `"revive"`: Calls `AgentLifecycleManager.global().ensureLive(agentId)`.
  - Defensive check: Advisor transcripts (`ref.kind === "advisor"`) reject `agent-cmd` with `advisor transcripts are read-only`.

### 3.5 Subagent Transcript Incremental Fetch
- **Method**: `packages/collab-web/src/lib/client.ts:241-251`
- **Request Frame Shape**:
  ```typescript
  {
    t: "fetch-transcript",
    reqId: number,
    agentId: string,
    fromByte: number
  }
  ```
- **Host Response Frame Shape** (`packages/coding-agent/src/collab/host.ts:1219-1259`):
  ```typescript
  {
    t: "transcript",
    reqId: number,
    text: string,     // Decoded UTF-8 JSONL records up to last complete newline
    newSize: number,  // Byte offset for next request (or stat.size if EOF reached)
    error?: string    // Terminal error message if file inaccessible or advisor
  }
  ```
- Max read cap: `TRANSCRIPT_READ_CAP = 4 * 1024 * 1024` (4 MiB per round-trip).

---

## 4. AgentEvent Handling for Mobile UI

The host emits events over the `{ t: "event", event: AgentEvent }` frame. Upstream web client implementation: `packages/collab-web/src/lib/client.ts:521-601`.

### 4.1 The 5 Essential Event Categories for Mobile UI

| Event Variant | Upstream Interpretation | Mobile UI Requirement |
|---|---|---|
| **`message_start`**<br>`message_update`<br>`message_end` | `packages/collab-web/src/lib/client.ts:523-535`<br>Carries complete `AssistantMessage` snapshot in `event.message`. | **Live Streaming Bubble**: Render the model response. Note: `message_update` delivers the **entire accumulating message**, NOT a diff/delta. Replace the streaming message in state. Remove ghost once matching `entry` lands. |
| **`tool_execution_start`**<br>`tool_execution_update`<br>`tool_execution_end` | `packages/collab-web/src/lib/client.ts:536-566`<br>Updates `activeTools` map keyed by `toolCallId`. | **Active Tool Card**: Show tool name (`toolName`), intent/explanation (`intent`), arguments (`args`), and running execution spinner. Remove on `tool_execution_end`. |
| **`agent_start`**<br>`agent_end` | `packages/collab-web/src/lib/client.ts:567-572`<br>Sets `working = true` on start, `false` on end. | **Agent Status Indicator**: Working spinner in header/composer. Reconciled authoritatively by `SessionState.isStreaming`. |
| **`notice`** | `packages/collab-web/src/lib/client.ts:573-575`<br>Appends to transient notices list (`MAX_NOTICES = 50`). | **Toasts / System Notices**: Info, warning, or error banners. Accompanies oversized payload warnings or peer join/leave notices. |
| **`auto_compaction_start`**<br>`auto_compaction_end`<br>`auto_retry_start`<br>`auto_retry_end` | `packages/collab-web/src/lib/client.ts:576-596`<br>Converted into user-facing notices. | **Context Maintenance Notices**: Alert user when context is being compacted or model calls are retrying with exponential backoff. |

*Ignored Events*: `turn_start`, `turn_end`, and `thinking_level_changed` are benignly ignored by `applyEvent` because turn state is governed by `agent_start`/`agent_end` and thinking level is reflected in debounced `SessionState`.

---

## 5. Host-Side Omissions & Protocol Boundaries

To present an honest UI on mobile, the client must acknowledge features that are deliberately host-only and cannot be driven over collab:

1. **Interactive Slash Commands Are Not Interpreted**:
   - Guest prompts are passed directly to `session.promptCustomMessage({ customType: "collab-prompt", ... })` (`packages/coding-agent/src/collab/host.ts:1011-1021`).
   - The CLI interactive command dispatcher (`packages/coding-agent/src/modes/controllers/input-controller.ts`) is bypassed. Commands such as `/model`, `/compact`, `/tree`, `/fork`, `/branch`, `/resume`, `/settings`, and `/quit` are treated as literal prompt text to the LLM.
2. **Tool Approval Prompt Degradation**:
   - The rich terminal composer approval widget (`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts:675-685`) is converted into a generic `CollabUiRequest` of kind `"select"` with string choices from `approvalChoiceLabels(prompt)` (`packages/coding-agent/src/tools/approval.ts:745-758`).
   - If a guest types a prompt while an approval prompt is pending, the host's queue monitor automatically treats the prompt as a **deny-and-steer** message (`extension-ui-controller.ts:694-708`).
3. **Internal Session Events Are Not Forwarded**:
   - Host `isWireAgentEvent` (`packages/coding-agent/src/collab/host.ts:84-118`) filters out:
     - `cache_warming_start` / `cache_warming_end`
     - `retry_fallback_applied` / `retry_fallback_succeeded`
     - `model_changed`
     - `config_warnings_changed`
     - `advisor_cost_changed` / `advisor_yielded`
     - `ttsr_triggered`
     - `todo_reminder` / `todo_auto_clear`
     - `irc_message` (subagent internal IPC)
     - `goal_updated`
     - `queue_update`
4. **Internal Session Entries Are Not Forwarded**:
   - Host `isWireSessionEntry` (`packages/coding-agent/src/collab/host.ts:103-122`) filters the session tree to only 6 types: `message`, `custom_message`, `compaction`, `branch_summary`, `model_change`, and `thinking_level_change`.
   - The following internal entries are dropped: `ModelUsageEntry`, `ServiceTierChangeEntry`, `CustomEntry`, `LabelEntry`, `TitleChangeEntry`, `TtsrInjectionEntry`, `SessionInitEntry`, `ModeChangeEntry`, `CredentialPinEntry`, and `ResetBoundaryEntry`.
5. **Advisor Subagents Are Completely Filtered Out**:
   - `packages/coding-agent/src/collab/host.ts:1141-1144` explicitly drops advisor agents (`kind === "advisor"`): they never appear in `AgentSnapshot[]`, and `fetch-transcript` / `agent-cmd` reject advisor IDs.
6. **EventBus Channel Restrictions**:
   - Only `"task:subagent:progress"` and `"task:subagent:lifecycle"` are mirrored (`packages/coding-agent/src/collab/host.ts:111-114`). File watches, git status updates, linter events, and terminal outputs are excluded.
7. **Replication Shrink & 1 MB Payload Bounds**:
   - `MAX_REPLICATED_PAYLOAD_BYTES = 1 * 1024 * 1024` (1 MiB, `packages/coding-agent/src/collab/replication-shrink.ts:55`).
   - Payloads exceeding 1 MiB undergo string truncation and array clipping. Unshrinkable entries are replaced with `{ type: "custom_message", customType: "collab-entry-too-large", content: "…[... omitted for collab session: too large to replicate]" }` (`replication-shrink.ts:58, 376-386`).
   - If initial session history exceeds `WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024` (24 MiB), base64 images are stripped from welcome snapshot copies (`packages/coding-agent/src/collab/host.ts:83, 882-911`).
8. **No Terminal or PTY Access**:
   - Collab provides zero terminal emulation or shell access. Commands are run host-side by the agent via tools.

---

## 6. UNVERIFIED Assertions

1. **Large Subagent Transcripts Over Slow Mobile Radios**: While `fetch-transcript` is bounded to 4 MiB chunks (`TRANSCRIPT_READ_CAP`, `host.ts:125`), the client timeout is pinned to 10 seconds (`TRANSCRIPT_TIMEOUT_MS = 10_000`, `client.ts:78`). On unstable cellular connections, fetching multi-megabyte subagent logs may resolve `null` on timeout and require user retry.
2. **`ui-request` Race on Session Reset**: If the host triggers `/resume` or switches session branches while an ask dialog is displayed to the mobile client, `host.ts:966-994` defers UI response resolution across `waitForSessionTransition()`. Whether mobile clients need special UX handling for this deferred state or can just await `ui-request-end` remains unverified under cellular network latency.
3. **Relay Ping / Pong Intervals**: The public relay `my.omp.sh` ping frequency and dead-connection timeout thresholds are server-side configurations not declared in `@oh-my-pi/pi-wire`. Browser `WebSocket` APIs rely on OS-level TCP keepalives and relay ping frames.
