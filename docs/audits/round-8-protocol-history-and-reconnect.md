# Round 8 — Protocol history and reconnect audit

## Scope and evidence

Source review plus current follow-up regression checks. No live native OMP session or real agent was launched and no images were opened or interpreted. Vendored guest and current upstream wire/host sources remain protocol authority. Exact follow-up verification results are recorded below; `ConversationView.tsx` was not changed and no browser specs were run in this follow-up.

The vendored declarations align with upstream for the frame/payload shapes cited below (`packages/collab-protocol/src/types.ts:57-271`, `packages/guest/src/vendor/wire/index.ts:183-447`). Upstream links: [`packages/wire/src/index.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/wire/src/index.ts), [`packages/coding-agent/src/collab/host.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/collab/host.ts), [`packages/coding-agent/src/collab/relay-client.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/collab/relay-client.ts), [`packages/coding-agent/src/session/agent-session.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/agent-session.ts), [`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts), and [`packages/coding-agent/src/tools/approval.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/tools/approval.ts). References without a repository prefix below name these upstream paths; upstream links target current `main`.

## Host → guest frames

`CollabSocket.onFrame` passes encrypted host frames to `reduceHostFrame` (`apps/web/src/components/ConversationView.tsx:161-169`). Wire authority: vendored upstream `packages/guest/src/vendor/wire/index.ts:404-445`; app union `packages/collab-protocol/src/types.ts:250-271`.

| Type | Handled? | App file:line | Consequence if unhandled / current behavior |
|---|---|---|---|
| `welcome` | Partial | `apps/web/src/transcript.ts:326-338`; `apps/web/src/components/ConversationView.tsx:149-155` | Starts replacement snapshot and updates status/agents; header and `readOnly` ignored. Read-only controls remain enabled and host rejects mutations; ranked defect 4 (`packages/coding-agent/src/collab/host.ts:770-772,998-1000`). |
| `snapshot-chunk` | Yes | `apps/web/src/transcript.ts:340-355`; upstream emitter `packages/coding-agent/src/collab/host.ts:915-940` | Buffers multiple chunks until `final` or entry count, then publishes in order. Large transfers still incur quadratic copying/search (ranked finding 1). |
| `entry` | Partial | `apps/web/src/transcript.ts:113-145,168-179,357-360` | Stores all variants and deduplicates durable entries by ID; visible rows are user/assistant/toolResult and `collab-prompt`; persisted markers/developer/custom entries are omitted (ranked defect 2). Live/durable overlap is paired one-to-one (dedup section). |
| `event` | Partial | `apps/web/src/transcript.ts:224-275`; coalescing `apps/web/src/components/ConversationView.tsx:157-173` | Assistant stream, tool start/update/end and notice/status events are reduced; non-assistant partial messages and `message_start` do not show content rows. |
| `state` | Partial | `apps/web/src/transcript.ts:314-315,365-366` | Only `isStreaming` updates visible state; model/context/participant/queue/aborting/cwd are not rendered. |
| `agents` | Partial | `apps/web/src/transcript.ts:367-368`; `apps/web/src/components/SubagentPanel.tsx:46-93` | Replaces agent snapshots; panel shows name/status and transcript, not kind, parent, session-file or timestamps. |
| `bus` | Partial | `apps/web/src/transcript.ts:379-392`; guest structured handling `packages/guest/src/lib/client.ts:432-440` | Both task channels become a concise status notice; app does not retain per-agent progress/lifecycle state for `SubagentPanel`. |
| `ui-request` | Yes | `apps/web/src/transcript.ts:369-370,308-312`; `apps/web/src/components/ConversationView.tsx:620-643` | Queues request; displays help, descriptions, selection marker, initial/checked indices and count. Exact selected host label is sent unchanged. |
| `ui-request-end` | Yes | `apps/web/src/transcript.ts:371-372,297-305`; `apps/web/src/components/ConversationView.tsx:365-368` | Removes matching active/queued request and advances queue. |
| `transcript` | Yes | `apps/web/src/transcript.ts:282-295,373-374`; `apps/web/src/components/ConversationView.tsx:174-185,384-417` | Correlates reply/error with requested agent by request ID. |
| `bye` | Partial | `apps/web/src/transcript.ts:377-378` | Marks disconnected and stores reason; UI shows generic connection state, not reason. |
| `error` | Partial | `apps/web/src/transcript.ts:375-376`; banner `apps/web/src/components/ConversationView.tsx:526-529` | Marks status unknown and stores message; banner shows generic state, not host error. |

Relay control is outside `HostFrame`: guest receives `room-closed`; host receives `peer-joined`/`peer-left` (`packages/collab-protocol/src/types.ts:275-278`). Socket parses them (`packages/collab-protocol/src/socket.ts:32-34,142-149`) but `ConversationView` sets no `onControl`; room close has only generic socket close status.
| Relay control type | App handles it? | App file:line | Consequence if unhandled / current behavior |
|---|---|---|---|
| `peer-joined`, `peer-left` (host receives) | Parsed, no UI callback | `packages/collab-protocol/src/socket.ts:32-34,142-149`; `ConversationView` sets no `onControl` | Peer roster changes are not surfaced in app. |
| `room-closed` (guest receives) | Parsed, no UI callback | Same socket callback/parser; `apps/web/src/components/ConversationView.tsx:271-281` | No room-closed-specific message; socket close still updates generic connection status. |

Nested payloads are separate from top-level `HostFrame` variants above. The tables below enumerate upstream session-entry and agent-event variants to distinguish ingestion from visible rendering.
## Nested transcript entry and event variants

`SessionEntry` variants from upstream are listed below. Entry frames are ingested/stored by `apps/web/src/transcript.ts:168-179,357-360`; visible row rendering is separate.

| Nested type | Rendered? | App file:line | Consequence |
|---|---|---|---|
| `message` (`user`, `assistant`) | Yes | `apps/web/src/transcript.ts:124-130` | User/assistant content becomes rows. |
| `message` (`toolResult`) | Yes | `apps/web/src/transcript.ts:131-141` | Tool result becomes a row keyed durably by entry ID. |
| `message` (`developer`) | No | `apps/web/src/transcript.ts:124-143` | Stored but no row; vendored guest also omits developer messages (`packages/guest/src/components/transcript/Transcript.tsx:266-268`). |
| `custom_message` (`collab-prompt`) | Yes | `apps/web/src/transcript.ts:113-123` | Prompt appears as user row. |
| `custom_message` (other custom types) | No | `apps/web/src/transcript.ts:113-123` | Stored but omitted even if `display` is true; vendored guest renders displayed custom entries (`packages/guest/src/components/transcript/Transcript.tsx:290-298`). |
| `compaction` | No | `apps/web/src/transcript.ts:124` | Stored, no context-compaction marker (guest renders it at `packages/guest/src/components/transcript/Transcript.tsx:300-306`). |
| `branch_summary` | No | `apps/web/src/transcript.ts:124` | Stored, no branch marker (guest `packages/guest/src/components/transcript/Transcript.tsx:308-312`). |
| `model_change` | No | `apps/web/src/transcript.ts:124` | Stored, model marker omitted (guest `packages/guest/src/components/transcript/Transcript.tsx:314-318`). |
| `thinking_level_change` | No | `apps/web/src/transcript.ts:124` | Stored, thinking marker omitted (guest `packages/guest/src/components/transcript/Transcript.tsx:320-326`). |

Upstream `AgentEvent` variants (`packages/guest/src/vendor/wire/index.ts:183-240`):

| Event variant | Handled? | App file:line | Consequence |
|---|---|---|---|
| `agent_start`, `turn_start` | Yes | `apps/web/src/transcript.ts:225` | Sets turn status running. |
| `agent_end`, `turn_end` | Yes | `apps/web/src/transcript.ts:226` | Sets idle and clears partial assistant stream. |
| `message_start` | Partial | `apps/web/src/transcript.ts:227-229` | Assistant sets streaming message; non-assistant start has no UI effect. |
| `message_update` | Partial | `apps/web/src/transcript.ts:227-229`; coalescing `apps/web/src/components/ConversationView.tsx:167-173` | Assistant stream coalesces at 100ms; non-assistant partial content is ignored. |
| `message_end` | Partial | `apps/web/src/transcript.ts:230-237` | User/assistant/toolResult gets final row; developer message has no visible row. |
| `tool_execution_start`, `tool_execution_update` | Yes | `apps/web/src/transcript.ts:239-244`; row `apps/web/src/components/ConversationView.tsx:53-68` | Shows running tool row and updates its output. |
| `tool_execution_end` | Yes | `apps/web/src/transcript.ts:245-247` | Updates same tool row with final result/error. |
| `notice` | Yes | `apps/web/src/transcript.ts:249`; banner `apps/web/src/components/ConversationView.tsx:546-550` | Displays latest info/warning/error notice. |
| `auto_compaction_start`, `auto_compaction_end` | Yes | `apps/web/src/transcript.ts:250-260` | Shows compacting/result notice; skipped compaction leaves notice unchanged. |
| `auto_retry_start`, `auto_retry_end` | Yes | `apps/web/src/transcript.ts:262-269` | Shows retry and result/failure notice. |
| `thinking_level_changed` | Yes | `apps/web/src/transcript.ts:271-273` | Shows thinking-level notice. |


## Guest → host frames

| Type | App sends it? | App file:line | Consequence if unhandled / current behavior |
|---|---|---|---|
| `hello` (guest → host) | Yes | `apps/web/src/components/ConversationView.tsx:274-278`; gate `packages/collab-protocol/src/socket.ts:64-75,105-111,152-166` | App sends hello on open; socket rejects non-hello frames until welcome, rather than buffering mutating commands ahead of peer registration. |
| `prompt` (guest → host) | Yes | `apps/web/src/components/ConversationView.tsx:301-335` | Prompt has no idempotency key; rejected sends preserve draft and report failure. |
| `ui-response` (guest → host) | Yes | `apps/web/src/components/ConversationView.tsx:358-370` | Exact value is sent; UI settles request only on successful socket send and leaves it visible with an error on refusal. |
| `abort` (guest → host) | Yes | `apps/web/src/components/ConversationView.tsx:353-355` | Without frame Stop cannot interrupt turn through Collab. |
| `agent-cmd` (guest → host) | **No** | No producer in `ConversationView.tsx` or `SubagentPanel.tsx` | App cannot issue protocol chat/kill/revive commands (vendored guest supports them). |
| `fetch-transcript` (guest → host) | Yes | `apps/web/src/components/ConversationView.tsx:384-417` | Without request agent transcripts cannot load; request ID correlates replies. |

## Deduplication and ordering

Durable entry de-duplication key is native `entry.id` (`apps/web/src/transcript.ts:168-179`). Durable visible rows use that ID as `id`/`identity`; live `message_end` rows use a per-event sequence identity and carry `eventIdentity = message:${role}:${timestamp}:${JSON.stringify(content)}` (tool results use `tool:${toolCallId}`) (`transcript.ts:103-105,181-200,230-237`). `upsertMessage` pairs an event row with one durable twin one-to-one by `eventIdentity`, removes the pairing marker after matching, and retains durable row identity (`transcript.ts:147-166`). Thus duplicate same-role/same-timestamp rows are no longer collapsed just because timestamps match. Matching requires equal role, timestamp, content and (for tool results) tool call ID. If content differs between a live event and its persisted entry due to upstream replication shrinking, those rows will not correlate; see open limitations below.

Exact implementation (`apps/web/src/transcript.ts:103-105,147-166,181-200`):

```ts
function messageCorrelation(message: WireMessage): string {
  if (message.role === "toolResult") return `tool:${message.toolCallId}`;
  return `message:${message.role}:${message.timestamp}:${JSON.stringify(message.content)}`;
}

function upsertMessage(messages: TranscriptMessage[], next: TranscriptMessage): TranscriptMessage[] {
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
```

**Fixed duplicate/loss defect:** two distinct durable messages with same role/timestamp/content retain distinct entry IDs; same-correlation live/durable duplicates are paired one-to-one. `tests/web/transcript.test.ts:95-129` covers colliding timestamps and repeated identical events. This fix is reducer-level source/test evidence, not a live OMP observation. A concrete ambiguity remains possible if two distinct same-role events have identical timestamp and serialized content, but within a room live source events each allocate an event row and durable entries are paired one-to-one in arrival order; protocol does not provide a shared event/entry ID or ordinal.

Ordering: snapshot retains upstream session-entry order; queued live entry/event frames apply afterward. `CollabSocket` serializes frame decrypt/dispatch (`packages/collab-protocol/src/socket.ts:152-170`); upstream snapshot emission is serialized ahead of later traffic (`packages/coding-agent/src/collab/host.ts:812-837`) and relay send queue preserves FIFO (`packages/coding-agent/src/collab/relay-client.ts:211-216`). No sequence/ordinal or sorting exists, so correctness relies on ordered delivery. The app does not reorder frames.



Upstream `message_update` carries the full accumulating message (`packages/guest/src/vendor/wire/index.ts:188-191`). App coalesces updates to latest frame per 100ms (`apps/web/src/components/ConversationView.tsx:157-173`) and sets `streamingMessage` (`apps/web/src/transcript.ts:224-229`). `message_end` commits a row and clears assistant stream (`:230-237`); an arriving durable entry replaces the matching live event row once by message correlation (`:147-166`). On reconnect, `welcome` clears partial body and snapshot restores committed entries only. Mid-stream disconnect therefore loses uncommitted partial text until a later update; if turn completed while offline, final persisted entry appears in snapshot. No durable truncation is shown by these paths, but no live reconnect was exercised.

See the dedicated Idempotency section below and ranked defect 3 for prompt framing, store-caller audit, stale documentation, and manual-retry risk.

## Resume, leases, and joining

- Catalog searches native session journal filenames by session ID (`packages/omp-adapter/src/session-catalog.ts:268-296`). Lease probe reads `/proc/net/unix`; returns true if expected OMP abstract socket exists, false if enumeration succeeds without it, otherwise `"unknown"` (`packages/omp-adapter/src/session-lease.ts:126-159`).
- UI offers Resume in app only for `live === false`; live and unknown leases are blocked with terminal-attach text (`apps/web/src/components/ProjectDetailView.tsx:160-175`). Resume API creates new conversation tied to old session ID (`:60-69`; `apps/server/src/app.ts:229-239`). Runtime spec validates journal ID/project cwd and passes `--resume <path>` to newly launched process (`apps/server/src/server.ts:62-95,370-382`). It resumes history as a new writer, not reconnecting old process; lifecycle docs say this explicitly (`docs/architecture/session-lifecycle.md:134-140`).
- `Supervisor.start` reserves conversation/native identity/resume path before probes (`packages/runtime/src/supervisor.ts:361-377`); existing reservation returns `conflict_owner` (`:371-375`). Registry, tmux, aliases/live owners and lease are checked before launch (`:380-459`). `launchVerdict` refuses lease true and unknown as `conflict_owner`; only false proceeds (`packages/runtime/src/state.ts:240-255`). Server returns 409; UI says no second agent started (`apps/server/src/app.ts:240-243`; `ProjectDetailView.tsx:67-69`). Fail-closed unknown means lease unreadable/unverifiable never launches second writer.
- Joining is separate from resume: `createMintLink` only returns link for matching registered host with `relayConnected === true` and matching instance/generation (`apps/server/src/server.ts:237-272`); link API/socket path `apps/server/src/app.ts:294-312`, `ConversationView.tsx:243-283`. That joins an existing writer as Collab guest. Resume button does not join live/unknown sessions.

## UI requests, approvals, and disconnects

Current approval shapes align: upstream `{kind:"select",title,options,...metadata}` / `{kind:"editor",title,prefill}` matches app and vendored types (`packages/collab-protocol/src/types.ts:221-238`; `packages/guest/src/vendor/wire/index.ts:359-376`). The app displays help, descriptions, markers, checked/initial indices and count; selected value is host-provided label unchanged (`apps/web/src/components/ConversationView.tsx:620-637,358-369`; `tests/web/approvals.test.tsx:115-138`). **No current approval type mismatch.** Upstream approval requests race local terminal UI against writable guest answers; current production requests opt into reconnect retention, and unresolved requests replay to a newly authenticated writable peer (`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts:930-954,1000-1120`; `packages/coding-agent/src/collab/host.ts:355-383,833-836,1083-1086`). Closing the phone does not answer/deny; local terminal may still decide. If no terminal/guest answers, request waits; no timeout/fallback is evidenced. If phone reconnects, retained request may be answered. Source-traced only, not exercised live.

## Idempotency

`GuestFrame.prompt` has no idempotency key: app and vendored protocol are `{t:"prompt",text,images?}` (`packages/collab-protocol/src/types.ts:242-248`; `packages/guest/src/vendor/wire/index.ts:378-399`); app sends no key (`apps/web/src/components/ConversationView.tsx:317`); upstream host invokes a new `promptCustomMessage` for each authorized prompt (`packages/coding-agent/src/collab/host.ts:996-1028`). `MetadataStore.recordCommandOnce()` exists (`apps/server/src/store.ts:27,162-172`), but there is no production caller, only a store test (`tests/server/store.test.ts:16-17`). `docs/architecture/mobile-client.md:66-68` and `docs/operations/troubleshooting.md:53-56` falsely claim the browser sends a UUID and the host deduplicates it; `docs/architecture/overview.md:46` likewise claims the prompt frame includes a key, while line 47 correctly says no production handler records it. Automatic reconnect does not replay an accepted prompt; ambiguous manual resend is a fresh prompt and may duplicate work.

## Ranked confirmed defects and minimal fixes

1. **P2 — Large transcript snapshots can block the UI through quadratic reducer work** (`apps/web/src/transcript.ts:340-355,168-179,147-166`). Each chunk copies all buffered entries; each added entry and message searches/copies growing arrays. Upstream snapshot chunks are byte-bounded, not count-bounded (`packages/guest/src/vendor/wire/index.ts:127-132`; `packages/coding-agent/src/collab/host.ts:915-940`). Minimal fix: accumulate entries/rows in mutable local arrays and ID/correlation maps, publish once on final chunk. No large-snapshot stress run.
2. **P2 — History silently omits persisted transcript entries** (`apps/web/src/transcript.ts:113-145`). Reducer stores entries but renders only user/assistant/tool-result messages and `collab-prompt`; compaction, branch, model/thinking changes, developer messages and other displayed custom messages have no visible row. Guest renderer supports context markers and displayed custom entries (`packages/guest/src/components/transcript/Transcript.tsx:266-326`). Minimal fix: render these durable entry variants as rows/markers. Live notices/events are handled separately; do not conflate them with restored history.
3. **P2 — Ambiguous manual prompt retry can execute work twice; documentation promises nonexistent deduplication** (`packages/collab-protocol/src/types.ts:242-248`; `apps/web/src/components/ConversationView.tsx:302-334`; upstream `packages/coding-agent/src/collab/host.ts:996-1028`). Prompt frame has no request ID, and each authorized prompt calls `promptCustomMessage`; `recordCommandOnce()` has no production caller (`apps/server/src/store.ts:27,162-172`). Automatic reconnect does not resend an accepted prompt. Minimal fix: remove false UUID/idempotency claims from `docs/architecture/mobile-client.md:66-68`, `docs/operations/troubleshooting.md:53-56`, `docs/architecture/overview.md:46`; if exactly-once retry is required, add upstream-supported request ID plus durable host dedup before retrying automatically.
4. **P3 — Read-only link capability is ignored by UI** (`apps/web/src/transcript.ts:326-338`; `apps/web/src/components/ConversationView.tsx:302-334,620-643`). `welcome.readOnly` is not retained, so controls permit prompt/approval attempts that host rejects. No second writer results; host rejects read-only mutation (`packages/coding-agent/src/collab/host.ts:770-772,998-1000`). Minimal fix: persist read-only state from welcome and disable mutating controls.

Resolved in current tree and covered by focused regressions: colliding durable message timestamps no longer collapse (durable row identity is entry ID; `tests/web/transcript.test.ts:95-129`); snapshot/live overlap pairs message-end and entry rows once (`:63-93,118-132`); sends during reconnect before `welcome` are refused rather than buffered (`tests/protocol/socket.test.ts:225-280`); bus and live event updates produce notices/tool rows (`tests/web/transcript.test.ts:177-200`); select approval metadata and host-return values are preserved (`tests/web/approvals.test.tsx:115-138`). These are source/test findings, not live OMP observations.

No prompt resend is automatic in reconnect source path; at-least-once risk is manual retry after ambiguous delivery, not snapshot replay.
## Not verified

- No live OMP/Collab reconnect, large multi-chunk transfer, writer-lease conflict, phone-close approval or prompt resend was exercised; these verdicts are source-traced.
- No CAW_COMPAT test or real agent was run; no provider credits spent. Historical 47/51 web-test output is not current-tree verification.
- No image files were opened or interpreted. No browser/full-app visual probe was run for this audit.

## Round 8 follow-up — reducer and socket hardening

- **Transcript deduplication:** durable rows use `entry.id`; live event rows carry message correlation and pair one-to-one with a durable twin. Distinct durable messages sharing timestamps remain separate. Regression coverage tests timestamp collisions, repeated identical events, and snapshot/live overlap (`apps/web/src/transcript.ts:103-105,147-179,181-200`; `tests/web/transcript.test.ts:63-93,95-129`).
- **Pre-hello sends:** `CollabSocket.send()` refuses and resolves `false` while socket is closed or until `welcome` acknowledges `hello`; no buffering into reconnect handshake (`packages/collab-protocol/src/socket.ts:64-75,108-112,152-166`). Socket regression confirms unsent prompt stays absent and post-welcome prompt sends (`tests/protocol/socket.test.ts:225-280`). Existing UI caller preserves draft/reports unsent (`apps/web/src/components/ConversationView.tsx:317-334`).
- **Reducer event outcomes:** task bus progress/lifecycle, notice, compaction start/end, retry start/end, thinking-level change, and tool start/update/end now have explicit notices or tool rows; reducer test checks each event/channel (`apps/web/src/transcript.ts:239-273,379-392`; `tests/web/transcript.test.ts:177-200`). This is concise notice/tool-row behavior, not full guest HUD parity.
- **Approval metadata:** app displays host help, descriptions, selection marker, initial/checked indices and count, then submits exact selected host label unchanged (`apps/web/src/components/ConversationView.tsx:620-637,358-369`). Test covers mapped metadata and exact response (`tests/web/approvals.test.tsx:115-138`). Upstream and app approval shapes match.
- **Still open:** snapshot chunks and per-entry reducer insertion still copy/search growing arrays quadratically (`apps/web/src/transcript.ts:340-355,168-179,147-166`); no large-snapshot stress check. Prompt protocol still has no idempotency key and `recordCommandOnce()` has no production caller (`packages/collab-protocol/src/types.ts:242-248`; `apps/server/src/store.ts:162-172`). UUID/dedup claims remain stale in `docs/architecture/mobile-client.md:66-68`, `docs/operations/troubleshooting.md:53-56`, and `docs/architecture/overview.md:46`.

Verification run in this follow-up:

| Exact command | Result |
|---|---|
| `pnpm vitest run tests/web/transcript.test.ts tests/protocol` | 5 files passed; 50 tests passed. |
| `pnpm vitest run tests/web/approvals.test.tsx tests/web/transcript.test.ts tests/protocol` | 6 files passed; 59 tests passed. |
| `pnpm --filter @caw/web build` | Passed; 47 modules transformed. |
| `pnpm typecheck` | Passed; 8 workspace projects typechecked. |
| `pnpm test` | 42 files passed, 2 skipped; 382 tests passed, 8 skipped. No CAW_COMPAT agent tests ran. |

## Round 8 independent review — folder creation and resume

### 1. Directory names

The route parses `createDirectorySchema` before invoking the path policy (`apps/server/src/app.ts:217-222`). Its name is trimmed, limited to 64 characters, and rejects empty names, `.`/`..`, ASCII `/` and `\`, NUL and ASCII controls (`packages/contracts/src/index.ts:306-312`). The path policy repeats segment/separator/control rejection for non-route callers (`apps/server/src/path-policy.ts:117-120`). Invalid schema input returns `400 bad_request`; a policy rejection maps to `403 path_forbidden` (`apps/server/src/app.ts:389-398`).

| Input | Result and rejecting layer |
|---|---|
| `.`, `..`, `../../etc`, `a/b`, `a\\b`, `/etc`, `C:\\etc`, NUL, newline/control | Schema rejects: `packages/contracts/src/index.ts:308-312`; if called directly, path policy rejects at `apps/server/src/path-policy.ts:117-120`. |
| Empty and whitespace-only names | `.trim()` then `.min(1)` rejects at `packages/contracts/src/index.ts:308-310`. Leading/trailing ordinary spaces are removed before creation. |
| `a∕b` using U+2215 DIVISION SLASH | Accepted and created on this POSIX host: neither layer treats this Unicode character as `/`; it is an ordinary filename character, not a path separator. Executed in a temporary directory. |
| NFC name `café` when NFD-equivalent `cafe\u0301` already exists | **Confirmed defect:** the create path does not normalize `name` before `mkdir` (`apps/server/src/path-policy.ts:121-124`), so this host creates a second, NFC-equivalent directory. Subsequent path lookup finds multiple NFC matches and rejects the path as ambiguous (`:69-71`). Executed: create succeeded; `assertInsideRoots(created, true)` returned `path_forbidden: Path is ambiguous after Unicode normalization`. |
| ` trailing ` and `trailing. ` | Zod trims the first to `trailing`; second becomes `trailing.` and is created (`packages/contracts/src/index.ts:308`). Linux preserves trailing dots. Windows/filesystems that strip dots or spaces were not exercised; deployment baseline is Ubuntu. |
| Name equal to an existing symlink entry (`target`) | `mkdir` returns `EEXIST`, mapped to `already_exists` (`apps/server/src/path-policy.ts:123-128`); no directory was created in the symlink destination. Executed with a symlink under the root pointing outside. |

Unicode slash-like characters therefore do not escape the parent on the supported POSIX host. Unicode NFC/NFD collision is a reproducible navigation failure, not an escape. No separator-bearing name escapes through `join(parent, name)` because both public schema and path-policy method reject actual path separators first.

### 2. Parent path and canonicalization

**Static paths are checked correctly.** Configured roots are `realpath`-canonicalized and must be directories (`apps/server/src/path-policy.ts:16-30`). Parent input must be absolute, lexically under a configured root, and free of `.`/`..`, backslash, and controls (`:48-58`). Each existing component is found from `readdir`, resolved with `realpath`, and checked against canonical roots; outside symlink targets are rejected (`:59-80`). `assertInsideRoots(..., true)` then requires the canonical parent to be within a root and `lstat` to be a directory (`:84-97`). A static in-root symlink to an in-root directory is intentionally canonicalized to its target; an outside symlink is rejected. A file parent returns `not_a_directory`. The outside-parent and file-parent route cases are also covered in `tests/server/app.test.ts:91-117`; `tests/server/path-policy.test.ts:30-50` covers symlink, traversal, and file checks.

**TOCTOU window is real.** `createDirectory` obtains the canonical path from `assertInsideRoots`, then separately joins and calls `mkdir` by pathname (`apps/server/src/path-policy.ts:121-124`); it does not pin the parent directory with a handle or use descriptor-relative creation. I executed a deterministic temporary reproduction: pause after `assertInsideRoots` returns; rename the validated in-root parent; replace its old pathname with a symlink to an outside directory; resume `mkdir`. Result: `outsideCreated: true`, while returned path remained lexically beneath the configured root. No repository file was changed. This race requires another process able to rename/replace a directory inside the workspace during those calls. Under a strictly single trusted local actor it is difficult to trigger, but workspace code/agent processes share filesystem access and can mutate the workspace, so it is security-relevant if those processes are not trusted. This is not proof of exploitation against a running server.

### 3. Creation and conflicts

`mkdir(target, { recursive: false })` creates only the final child and cannot create missing ancestors (`apps/server/src/path-policy.ts:121-124`). It has no overwrite behavior. `EEXIST` for a directory, regular file, or symlink is consistently mapped to `PathPolicyError("already_exists")` (`:125-128`) and HTTP `409` (`apps/server/src/app.ts:389-392`). The message explicitly says “A file or directory with that name already exists”; I separately executed an existing-regular-file case and observed `already_exists` while the file remained a file. Route tests cover existing-directory conflict and no new entry (`tests/server/app.test.ts:119-123`).

### 4. Existing invariants

- Directory creation route has `protectedHook` (`apps/server/src/app.ts:217`) and is covered by unauthenticated-route tests (`tests/server/app.test.ts:27-38`). Global request hook requires allowed Origin for unsafe methods, rejects cross-site `Sec-Fetch-Site`, requires JSON when a body exists, and verifies CSRF (`apps/server/src/app.ts:100-132`). The new route uses POST with JSON body, so all apply.
- The route does not shell out; it calls `paths.createDirectory` (`apps/server/src/app.ts:217-222`). Native OMP/tmux launch remains in the adapter; existing `execFile` calls use `shell: false` (`packages/omp-adapter/src/collab-registry.ts:141-142,170`; `packages/omp-adapter/src/tmux.ts:87-89`).
- The new path operation uses `WorkspacePathPolicy`; the route does not directly call `mkdir` or read arbitrary paths (`apps/server/src/app.ts:87,217-222`; policy implementation `apps/server/src/path-policy.ts:117-131`). Other server reads relevant to browsing are routed through `assertInsideRoots` (`apps/server/src/server.ts:435-437`).
- Project deletion remains metadata-only: route returns `filesRemoved: false` (`apps/server/src/app.ts:194-198`), with a test confirming the project directory remains present (`tests/server/app.test.ts:67-76`).

### 5. Error mapping and resume safety

Policy errors retain their codes because route catches and passes them to `pathError`; `path_forbidden` maps to 403, `path_not_found` to 404, `already_exists` to 409, and `not_a_directory` to 400 (`apps/server/src/app.ts:217-223,389-398`). Zod name/path validation errors intentionally become `400 bad_request` before policy evaluation (`:218-219`). Other OS errors such as `EACCES`/`EPERM` and `EIO` become sanitized `500 internal` responses (`:394-398`); they are not mislabeled as missing/forbidden. Tests verify path-policy code mapping for forbidden, missing, and file cases (`tests/server/app.test.ts:91-123`) and the permission-error response (`:126-135`).

Resume still fails closed. UI only exposes “Resume in app” when `sess.live === false`; `true` and `unknown` render refusal guidance, and `handleResume` refuses tracked sessions (`apps/web/src/components/ProjectDetailView.tsx:60-69,149-175`). Catalog liveness is `true`/`false`/`unknown`; inability to inspect `/proc/net/unix` or an invalid session ID returns unknown (`packages/omp-adapter/src/session-lease.ts:126-138`). Even a direct API call reaches `Supervisor.start`, which checks active reservations, hosts, managed tmux, and session lease before launch (`packages/runtime/src/supervisor.ts:361-459`); lease `true` and `unknown` both return `conflict_owner` (`packages/runtime/src/state.ts:240-255`). Resume spec also resolves the requested journal and checks its session ID and canonical cwd against the project (`apps/server/src/server.ts:62-82`). App maps refusal to conflict and tells the UI no second writer started (`apps/server/src/app.ts:229-243`; `ProjectDetailView.tsx:67-69`). No source path found here that turns a live/unknown native session into a second writer.

### Findings and limits

1. **Confirmed path-policy defect:** NFC/NFD-equivalent directory names can both be created; subsequent navigation rejects the ambiguous name. Minimal fix belongs in the creation path: normalize accepted name to NFC before `mkdir` and handle collision as `already_exists` (or refuse the normalized collision).
2. **Confirmed race:** parent can be swapped to an outside symlink after validation and before pathname-based `mkdir`; deterministic temporary reproduction succeeded. Mitigation requires anchoring creation to a verified directory handle / descriptor-relative operation or another atomic containment strategy. Impact depends on whether another local workspace process is in the threat model.
3. **Could not verify:** no live HTTP server, hostile concurrent process, alternate OS/filesystem with trailing-dot stripping, OMP process launch, or actual external writer race was exercised. Server/UI/auth/resume verdicts are source-traced; only filename and controlled TOCTOU reproductions were executed. No project files were changed by reproductions.

## Round 8 independent review — frontend reading UX and sanitizer

Source review of current frontend files plus local pure-function, SSR, and isolated Chromium probes; no full-app browser automation or agent launch. Probes exercised hostile Markdown shapes, `parseInline` on long inputs, colliding transcript entries, and data-URL SVG image loading. These establish emitted markup/reducer outcomes, not visual behavior across real mobile devices.

### Confirmed findings

1. **P2 — Malformed inline Markdown can freeze rendering** (`apps/web/src/sanitize.ts:47-52,56-80,120-132`; called for each streamed update at `apps/web/src/components/ConversationView.tsx:110-113,163-166,573-579`). For input consisting of 80,000 `[` characters, `parseInline` took about 3,004 ms in the local Bun probe. At each unmatched `[` it tries regexes that rescan the remaining suffix, then slices off one character; work is quadratic. The streamed Markdown renderer repeats this over growing prefixes. Minimal fix: make unmatched-marker scanning consume each character once (linear scanner), or enforce a conservative input/render limit before parsing.

2. **P2 — Distinct durable messages can collapse to one row** (`apps/web/src/transcript.ts:97-101,142-160,278-293`). Reproducer: deliver two assistant `SessionEntry`s with different IDs (`e1`, `e2`) but the same role and message timestamp `42` in one snapshot. The reducer retains both in `entries` but `messageIdentity` returns `message:assistant:42` for both; `upsertMessage` replaces `e1`'s row with `e2`, so rendered transcript contains only `e2`. The local reducer probe observed exactly that. `Date.now()` timestamps are not unique IDs. Minimal fix: use a unique durable `entry.id` for rows and explicit event-to-entry correlation, rather than treating `(role,timestamp)` as globally unique.

3. **P2 — Latest button can remain visible after reader reaches tail by resize** (`apps/web/src/components/ConversationView.tsx:185-212,619`; `apps/web/src/styles.css:397-405`). Reproducer: detach with a 100px gap, then rotate/resize so `clientHeight` grows by 50px without changing `scrollTop`; gap becomes 50px (inside the 80px threshold). The `ResizeObserver` sees the change but only scrolls when `followTailRef` is already true and never recalculates `isDetached`, so button can remain visible at the tail. Conversely, its state can lag after other content-size changes until a scroll event. Minimal fix: recompute the tail lock from the ResizeObserver callback (after any follow-tail scroll).

4. **P2 — Known slash command can bypass interception with colon syntax** (`apps/web/src/commands.ts:63-66`; `apps/web/src/components/ConversationView.tsx:298-321`; upstream parser `packages/coding-agent/src/slash-commands/helpers/parse.ts:16-30`; Collab host `packages/coding-agent/src/collab/host.ts:997-1011`). Concrete input `/compact:reason` makes `findSlashCommand` compare the whole `/compact:reason` token and return no match, so `sendPrompt` sends it as an ordinary `{t:"prompt",text}` frame without showing the explicit “Send as plain text anyway” action. Upstream OMP command syntax splits at either whitespace or `:`; the Collab host then accepts text/images as a custom prompt rather than dispatching a slash command, so this bypass reaches the model as prose. Minimal fix: parse command name using the same colon/whitespace separators before matching/intercepting.

5. **P2 — Large snapshot reduction does quadratic copying/search** (`apps/web/src/transcript.ts:142-161,278-293`). Each snapshot entry copies the full `entries` array, searches it by ID, then searches/copies the `messages` array in `upsertMessage`; repeating for N entries is O(N²) work and allocations. Upstream intentionally supports large histories and streams many chunks; a big reconnect can block the phone before first transcript paint. Minimal fix: build entries and rows in local maps/arrays for the snapshot, then publish once while preserving ordered output.

6. **P3 — Code fade can obscure trailing code even without horizontal overflow** (`apps/web/src/styles.css:348-352`). Mask gradient is unconditional for every code `<pre>`; a short line that ends in the last 20px of the box is faded although there is no overflow to signal. Minimal fix: apply fade only while `scrollWidth > clientWidth`, or use a non-masking overflow affordance.

7. **P3 — Transcript has 140px of unnecessary blank tail space** (`apps/web/src/styles.css:233-242,408-418`). `.messages-scroll` is a flex sibling above the sticky composer, so the composer already occupies layout space; `padding-bottom: ... + 140px` adds a further 140px after the final row. It makes the tail readable but leaves dead space, not composer clearance. Minimal fix: remove the fixed 140px or size clearance only for an actual overlay.

### Attacks checked; no execution path found

- Unclosed triple-backtick fence at EOF, a fence indented inside a list, and four-backtick delimiters: parser may render non-CommonMark structure, but code is emitted as React text inside `<code>`; it does not become raw markup.
- Fence language containing `https://javascript:...` or tag-like text: language is a text child of toolbar `<span>` (`sanitize.ts:168-177,245-255`), not an href/attribute.
| Table cells containing `[x](javascript:...)`, `![x](data:text/html,x)`, and a valid HTTPS link: cells pass through `parseInline` (`sanitize.ts:197-206`); unsafe schemes become spans/placeholders, only HTTPS produces an `<a>` (`:78-100`), and images use HTTPS or `data:image/` (`:56-75`). SSR probe emitted no executable element or unsafe href. An isolated Chromium probe loaded an SVG data URL with an SVG `onload` handler inside image context; `onload` was not able to mutate the parent page (`pwned: 0`). No full-app browser XSS run was performed.
- Nested emphasis such as `**bold *nested***`: this small parser produces malformed emphasis/text, but React text/element children remain inert. No scriptable markup produced.
- Raw `<img onerror>`/`<script>` tags in paragraphs and fences: renderer creates no raw HTML sink (`sanitize.ts:139-229,245-257`); React escapes text. SSR probes emitted no executable tags, event-handler attributes, or unsafe hrefs.
- A 100,000-character plain-text line rendered as text in the SSR probe. A 100,000-character run of unmatched `[` was not an XSS path, but is covered by the quadratic-rendering finding above.
- `MessageRow` memoization does not retain stale row content under the reducer's current update path: changed rows are replaced with new objects (`transcript.ts:142-149,151-161,193-211`), so shallow `memo` sees changed props; live-to-durable transitions also change `id` from `live:${identity}` to `entry.id` and remount (`:164-180`; render key `ConversationView.tsx:571`). The identity collision finding above is distinct from memo staleness.
- Stream coalescing preserves the latest pending full-message update: every non-`message_update` frame flushes the pending frame before reducing itself (`ConversationView.tsx:153-169`); JS timer and frame callbacks run serially, so a same-tick race is ordered rather than simultaneous. Upstream emits assistant `message_end` for normal and aborted assistant messages (`packages/agent/src/agent-loop.ts:2356,2839`); reducer adds that final row and clears the stream (`transcript.ts:193-199`), while `turn_end`/`agent_end` clear any remaining stream (`:187-190`). `welcome` clears partial stream on reconnect and a committed final is restored by snapshot (`:264-276`). No runtime reconnect/abort was exercised.
- Approval response preserves exact option label: UI derives `label` from the host option and passes that same value to `handleUiResponse`, which sends it unchanged (`ConversationView.tsx:596-603,344-350`). The `ghost`/`primary` class is presentation-only. First response synchronously removes/promotes the request in `transcriptRef`; a repeated stale-button click fails the active/queued `reqId` check (`:344-350`; reducer `transcript.ts:235-249`). Existing tests exercise supplied label, double-click exactly-once, FIFO advancement, and host settlement (`tests/web/approvals.test.tsx:149-226`).
- Slash interception for exact known commands is fail-closed: `findSlashCommand` match sets the interception and returns before sending (`commands.ts:63-66`; `ConversationView.tsx:298-305`). Only “Send as plain text anyway” calls with `allowSlashCommand=true`; Cancel only clears interception state and leaves both draft values untouched (`ConversationView.tsx:329-336,637-647`). Unknown commands are sent as ordinary text by design. Colon-form bypass is the exception above.
- Scroll behavior does not programmatically yank detached readers during content growth, tool expansion, or modal open/close: follow-tail writes are gated by `followTailRef` (`ConversationView.tsx:193-207`); fixed modal overlay is out of flow (`styles.css:477-486`). At tail, ResizeObserver maintains bottom following. Composer is an in-flow flex sibling (`styles.css:408-418`); bottom padding adds whitespace rather than clearing it.
- IME Enter guard checks both React composition ref and native `isComposing` (`ConversationView.tsx:45-50,658-665`); composer autogrow caps at 140px with internal overflow (`:37-43,220`); changed draft resets duplicate-send guard and permits follow-up prompts while running (`:298-335`). No additional defect found in these paths from source review.

No full-app visual/security test, orientation-change test, or real OMP session was performed for this review; the isolated Chromium SVG probe and local reducer/SSR probes are described above.
