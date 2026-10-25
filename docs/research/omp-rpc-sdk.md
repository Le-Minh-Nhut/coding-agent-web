# OMP RPC vs native Collab

Comparison uses Architecture A = tmux + native Collab; Architecture B = `--mode rpc`/`rpc-ui` + supervisor + explicit terminal handoff. Local binary was `omp v18.12.2`; upstream docs/source refer to `main` and npm results report `18.12.6`, so version-specific differences remain possible.

## RPC surface and evidence

- **Exists:** local `omp --help` (`omp v18.12.2`) lists `--mode=<value> Output mode: text (default), json, rpc, or rpc-ui`. Same help lists `--no-ui`, `--no-session`, `--resume`, and `--continue`. Upstream [`docs/rpc.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md#startup) describes both RPC modes.
- **Transport:** stdio, not socket: newline-delimited JSON objects on stdin/stdout; it is not JSON-RPC 2.0. Cached docs: `/tmp/caw-research/rpc.md:3-17,36-49`. `rpc-ui` uses same transport. Direct RPC is local-only; it opens no remote endpoint. A web/mobile bridge would be a separate supervisor responsibility. [INFERENCE: network exposure depends on that bridge's design.]
- **Observed handshake:** ran `printf '' | timeout 8 omp --mode rpc --no-session --cwd /tmp`; first raw stdout frame was `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}\n`. Further extension UI and available-command frames followed. The process needs a moment to initialize. Protocol startup/frame details: `/tmp/caw-research/rpc.md:31-39,81-106`.
- **UI-relevant messages:** submit `prompt` (and optional images/steer-vs-follow-up behavior); receive `message_start`/`message_update`/`message_end`, including streamed text/thinking/tool-call deltas; observe `tool_execution_start/update/stream_update/end`; abort with `abort` or `abort_and_prompt`; inspect state via `get_state`, with state and lifecycle events. Sources: `/tmp/caw-research/rpc.md:122-157,224-236,821-874,1148-1177`; command/result semantics: `:313-353`.
- **Protocol vs definition:** `docs/rpc.md` documents contract; `packages/coding-agent/src/modes/rpc/rpc-types.ts` defines `RpcCommand` and wire shapes; `rpc-mode.ts` implements stdio framing/dispatch; `packages/coding-agent/src/modes/rpc/wire` is schema for generated clients. Source URLs: [`rpc-types.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts), [`rpc-mode.ts`](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts). Docs identify canonical paths at `/tmp/caw-research/rpc.md:10-17,122-125,1575-1620`.

## Published package check

Ran each requested command. Raw results:

```text
$ npm view @oh-my-pi/pi-coding-agent version
18.12.6
$ npm view @oh-my-pi/collab-web version
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@oh-my-pi%2fcollab-web - Not found
npm error 404
npm error 404  '@oh-my-pi/collab-web@*' is not in this registry.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.
npm error A complete log of this run can be found in: /home/heheboiz/.npm/_logs/2026-10-24T16_48_42_907Z-debug-0.log
$ npm view @oh-my-pi/pi-tui version
18.12.6
```

Conclusion for these exact npm names: `pi-coding-agent` and `pi-tui` published; `collab-web` unpublished (registry returned E404). SDK docs recommend Bun install for the in-process package and RPC for process isolation: `/tmp/caw-research/sdk.md:1-17`.

## Native TUI continuity and resume

**Resume later: yes, when RPC has persisted a session.** RPC state exposes `sessionFile`/`sessionId`; sessions are file-backed JSONL. CLI accepts `--resume <id-or-path>` and `--continue`. Evidence: `/tmp/caw-research/rpc.md:430-519`; `/tmp/caw-research/session.md:63-69,114-119`; `/tmp/caw-research/cli-reference.md:82-98`. After RPC stops, a native OMP launch can resume that saved session.

**Attach to an RPC turn live: no supported native TUI attach path found; treat as impossible.** RPC owns stdin/stdout as its command/event channel (`/tmp/caw-research/rpc.md:3-8,31-38`); TUI is a separate launch mode (local `omp --help`). RPC `handoff` is a saved-session handoff operation, not a terminal-attachment mechanism, and fails while response streams (`/tmp/caw-research/rpc.md:224-236`). Do not run RPC and TUI simultaneously against one session file: concurrent-write safety is **UNVERIFIED**. Planned explicit handoff should finish/stop RPC before starting TUI with `--resume`.

## Approvals and client concurrency

Approvals are **not a dedicated approval RPC method**. Tool approval prompts go through the extension runner as a generic `extension_ui_request` with `method: "select"`; `docs/approval-mode.md` says RPC/ACP hosts receive the usual choices and full details. Thus wire request shape is `{type:"extension_ui_request", id, method:"select", title, options:[...], ...}`; approval options are `Approve`, `Approve <tool> for this session`, and `Deny` (ask-and-remember may include grant choices). Host answers `{type:"extension_ui_response", id, value:"<selected option>"}`. The generic select frame and response are documented at `/tmp/caw-research/rpc.md:1218-1259`; actual approval choices/payload behavior at [`docs/approval-mode.md`](https://github.com/can1357/oh-my-pi/blob/main/docs/approval-mode.md#per-tool-prompt-details). `--mode rpc-ui` retains tool UI; `--no-ui` makes approval-required calls fail closed, not auto-approve: `/tmp/caw-research/rpc.md:1206-1214`. [INFERENCE: there is no approval-specific wire frame; it is a generic `select` dialog.]

One logical peer per RPC process: the process consumes one stdin stream and emits one stdout stream; schema has request IDs, but no client identity/connection handshake (`/tmp/caw-research/rpc.md:3-8,108-118`). A supervisor could multiplex multiple callers over that one stream, but that broker is extra code. [INFERENCE: multiple independent direct RPC clients are unsupported; protocol does not establish a multi-client socket.] By contrast, Collab explicitly supports participants/guests and write-token access (`/tmp/caw-research/collab.md:129-141`).

## Verdict table

| Dimension | Relative verdict | Reason |
|---|---|---|
| Live CLI continuity | A better | A shares the same running native TUI/session; B is headless and requires process handoff. PoC fact: `tmux attach` attaches same OMP process; Collab shares that session (`/tmp/caw-research/collab.md:1-3`). |
| Native session compatibility | A better | Both persist native session data, and B can resume later; only A keeps the live TUI process attached. B cannot live-attach to the RPC turn. Session format/resume: `/tmp/caw-research/session.md:63-69`; `/tmp/caw-research/cli-reference.md:82-98`. |
| Mobile UX | A better today | Collab already provides browser transcript, tool cards, composer, prompt/interrupt (`/tmp/caw-research/collab.md:150-154`). B gives flexible UI primitives, but requires building UI and bridge. |
| Implementation complexity | A better | Existing tmux + auto-start Collab PoC avoids supervisor lifecycle, JSONL client, approvals, and TUI handoff orchestration. RPC primitives are broad, but do not remove those responsibilities. |
| Upstream maintainability | Equal | Both use upstream OMP; RPC has documented wire schema/client support (`/tmp/caw-research/rpc.md:1575-1645`), while Collab is a first-party native feature with web client (`/tmp/caw-research/collab.md:1-3,150-154`). |
| Security | A better by default | Collab documents AES-256-GCM payload encryption and distinct view/control bearer links (`/tmp/caw-research/collab.md:119-141`). RPC stdio is local-only, but B's remote supervisor bridge must supply its own auth/transport protections. |
| Reliability | Equal | A has same-process continuity; B has persisted sessions and graceful stdin-EOF disposal, but an extra supervisor/child-process boundary. EOF behavior: `/tmp/caw-research/rpc.md:31-34,77-79`. |
| Multi-session support | Equal | A lists all local Collab hosts (`/tmp/caw-research/collab.md:73-85`); B can run one RPC process per session, with supervisor required to manage them. |
| Testability | Equal | RPC has deterministic JSONL frames and bundled clients (`/tmp/caw-research/rpc.md:36-49,1575-1645`); Collab web offers offline `mock-host` (`/tmp/caw-research/collab.md:150-152`). |

## UNVERIFIED

- Concurrent RPC and TUI use of the same JSONL file; avoid until proven safe.
- Live interrupt/handoff corner cases, recovery after supervisor or laptop crash, and production performance; not tested here.
- Supervisor HTTP/auth/TLS/CSRF design, actual mobile interface, and its exposure boundary; not specified by RPC protocol.
- Exact RPC approval behavior for installed `18.12.2` vs upstream `main` (approval evidence is upstream docs; local help/handshake only verified).
- Whether package might be published under a different name; only the three requested names were queried.

## Decision

Reject B if requirement is switching a live turn into native TUI without interruption: no supported attachment exists. Accept B if custom UI and explicit stop-then-resume handoff are acceptable. Strongest reason to choose A: existing mobile Collab UI controls the same native TUI session. Strongest reason to choose B: local stdio RPC provides rich UI/event/state controls without Collab relay, while preserving later native session resume.
