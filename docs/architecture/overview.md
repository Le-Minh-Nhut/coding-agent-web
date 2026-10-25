# Architecture overview

Coding Agent Web is a single-owner control plane for native OMP sessions on the owner's Ubuntu laptop. OMP remains the runtime and journal authority; the browser is a Collab guest, not another agent loop. Remote access is intended to use Tailscale Serve TLS to loopback. Decisions and ownership rules: `docs/adr/0001-runtime-architecture.md`, `docs/adr/0002-private-relay-and-remote-access.md`, `docs/architecture/session-lifecycle.md`.

## Component map

| Component | Single responsibility | Must never |
| --- | --- | --- |
| `apps/web/src/` | Mobile React UI, API client and native Collab guest view. | Persist room links outside component memory, or make agent-authored text executable HTML. |
| `apps/server/src/` | Fastify API, authentication, folder policy, metadata and runtime composition. `server.ts` wires adapters/supervisor and reconciles at startup. | Trust unchecked HTTP bodies, expose owner controls unauthenticated, or guess runtime state. |
| `packages/contracts/src/index.ts` | Shared API types and Zod wire schemas. | Treat unvalidated network values as trusted contracts. |
| `packages/runtime/src/` | Conversation lifecycle, writer-lease launch refusal and reconciliation. | Launch against a live/unknown writer, stop external work, or kill by tmux name. |
| `packages/omp-adapter/src/` | OMP registry/journal/lease and tmux adapters; only package invoking `omp`/`tmux`. | Build shell command strings or treat names as stable session identity. |
| `packages/collab-protocol/src/` | Parse links and implement sealed frames, envelopes and WebSocket client. | Log or persist room keys/write tokens, or diverge from OMP protocol. |
| `packages/relay/src/` | Loopback WebSocket relay and static guest asset handler. | Decode, log or persist frame payloads or room secrets. It sees routing/traffic metadata. |
| `packages/guest/src/` | Vendored, patched upstream guest, built by `scripts/build-guest.mjs`. | Weaken protocol checks or render hostile transcript content without sanitization. Standalone guest uses URL fragment for its supplied link; it is not owner UI handoff. |
| `~/.local/state/coding-agent-web/` (configurable) | Password hash and JSONL metadata (`auth-password.json`, `metadata.jsonl`). | Store Collab links, room keys or write tokens. |
| `~/.omp/agent/sessions/`, `~/.omp/` | Native OMP journals, settings and owner credentials. Adapter catalog discovers journals; OMP owns them. | Be copied into web metadata or treated as proof of a live process without runtime observation. |

`tests/{server,adapter,runtime,protocol,relay,guest,web,e2e,compat}/` holds unit/component, browser, and real-OMP compatibility tests (`tests/compat/omp-lifecycle.test.ts`, `tests/compat/reconciliation.test.ts`).

## Four product journeys

The UI and server components are fully integrated: `apps/server/src/server.ts` starts the private relay (serving guest joins on `config.port` and host upgrades on loopback `config.relayPort`), serves `apps/web/dist` and `packages/guest/dist`, and `apps/server/src/app.ts` provides `/api/projects/:id/sessions`, `POST /api/conversations/:id/link`, attach instructions, and runtime status. Safe methods bypass JSON and CSRF checks; mutating requests require session CSRF and an allowed Origin. When deployed behind Tailscale Serve, `publicOrigin` sets the public origin used to mint browser deep links, and `relayAllowedOrigins` (or `trustTailscaleOrigin`) configures admitted browser origins.

### 1. Create a chat remotely

Intended deployment is Tailscale Serve TLS to the loopback server (`docs/adr/0002-private-relay-and-remote-access.md`), with same-origin web hosting by the server (`apps/server/src/static-web.ts`). `App` calls `GET /api/auth/me`; `LoginView` submits `POST /api/auth/login`, which issues an HttpOnly session cookie and returns a CSRF token held in `apps/web/src/api.ts`. `ProjectsView` and `FolderBrowser` use `GET /api/projects`, `GET /api/browse`, and `POST /api/projects`; the server canonicalizes the chosen path via `WorkspacePathPolicy` and appends project metadata. On `POST /api/projects/:id/conversations`, `ProjectDetailView` invokes `createSupervisor()` through the server; successful launch records tmux/native/host identity and lifecycle events (`packages/runtime/src/supervisor.ts`, `apps/server/src/store.ts`). It refuses duplicate writers and active-agent-cap violations.

### 2. Continue a CLI conversation

OMP writes its native journal; `DefaultNativeSessionCatalog` in `packages/omp-adapter/src/session-catalog.ts` discovers journals and `DefaultSessionLeaseProbe` checks ownership. `ProjectDetailView` calls `GET /api/projects/:id/sessions`, which returns available sessions for the project while filtering out already tracked ones (`apps/server/src/app.ts`). On `POST /api/projects/:id/conversations` with a resume session ID, the runtime spec resolves and verifies its journal and project. A held lease without an existing room is refused with `conflict_owner` rather than letting OMP fork history (`packages/runtime/src/state.ts`). Phone continuation of CLI sessions is fully supported.

### 3. Leave the phone and attach a terminal

`ConversationView` owns a `CollabSocket` and raw room link in a React ref; unmount closes only the guest socket and clears the ref (`apps/web/src/components/ConversationView.tsx`). Host/room survive while OMP remains connected to relay (`packages/relay/src/relay.ts`); terminal attachment reaches that same process and native journal (`docs/adr/0001-runtime-architecture.md`). `GET /api/conversations/:id/attach` exists and emits the command targeting the app's private tmux socket (`tmux -S <socketPath> attach -t <tmuxSessionId>`), gated on the recorded tmux server identity matching the live server (`packages/runtime/src/supervisor.ts`, `apps/server/src/app.ts`).

### 4. Run several conversations at once

Each stored conversation has separate app ID, native session ID, tmux `$N`, host instance/generation and runtime state (`packages/contracts/src/index.ts`, `docs/architecture/session-lifecycle.md`). `MetadataStore` stores rows/events independently; wired supervisor checks writer lease and configured `maxActiveAgents` (default three) before launch (`packages/runtime/src/supervisor.ts`, `apps/server/src/config.ts`), counting concurrency from live sessions. Multiple conversations run concurrently in independent tmux sessions, each hosting its own room on the private relay.

## One prompt: data flow and link lifetime

The requested path is HTTP → agent process → relay → phone. Current implementation differs:

1. **Client-to-agent prompt:** `ConversationView` calls `POST /api/conversations/:id/link` to obtain a fresh room deep link (`<publicOrigin>/#<relayLink>`), connects its `CollabSocket` to the relay as a guest, and sends `prompt` frames directly over the encrypted WebSocket connection (`apps/web/src/components/ConversationView.tsx`). The frame carries text/images, not an idempotency key; the browser's local monotonic `user-${++localIdRef.current}` identifies only its optimistic row. There is no prompt HTTP endpoint; prompts travel over the room socket.
2. **Idempotency:** `commandSchema` defines an HTTP command shape and `MetadataStore.recordCommandOnce()` stores one JSONL command row per key (`packages/contracts/src/index.ts`, `apps/server/src/store.ts`), but no production handler calls it. The Collab wire has no prompt idempotency key, so a manual resend after an ambiguous disconnect can enqueue duplicate work.
3. **Agent and relay:** If a guest is connected, the browser seals prompt frames using the shared OMP protocol (`packages/collab-protocol/src/codec.ts`). OMP handles the prompt in its tmux-hosted process and appends to its native journal. The private relay forwards ciphertext and rewrites only the 4-byte peer prefix (`packages/relay/src/relay.ts`); it does not run an agent loop. `apps/server/src/server.ts` attaches the guest relay endpoint to the app's HTTP listener (`config.port`) and opens a dedicated loopback listener for the host role at `config.relayPort`.
4. **Response:** OMP's sealed response frames travel through relay to `CollabSocket`, which decrypts and renders transcript state in `apps/web/src/components/ConversationView.tsx`.

OMP link issuance is available in `DefaultCollabRegistryService.link()` (`packages/omp-adapter/src/collab-registry.ts`) and exposed at `POST /api/conversations/:id/link`. Links carry room ID, AES key and optional write token; they are bearer credentials, returned with `Cache-Control: no-store` and rewritten to `<publicOrigin>/#<relayLink>` so the room path lives exclusively in the URL fragment. The main UI retains the raw link in a React ref only while mounted and clears it on unmount. A room-generation change invalidates an old link; the client re-mints on demand.

## Deliberately not here

- **No microservices:** one laptop is one owner and trust boundary; extra hops add no isolation.
- **No queue:** native OMP owns scheduling, session continuity and recovery.
- **No Redis:** single-host metadata and in-process coordination suffice.
- **No external database:** metadata stays local; current storage is JSONL (`apps/server/src/store.ts`).
- **No agent-loop reimplementation:** OMP owns tools, approvals, history and lifecycle; the app brokers Collab.
- **No terminal emulator as primary UI:** native Collab is structured mobile chat; tmux preserves terminal continuity without ANSI scraping (`docs/adr/0001-runtime-architecture.md`).
