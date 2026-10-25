# Mobile client integration: running our own guest UI on the native protocol

## The seam

We do not re-implement Collab. We consume the same sealed frame grammar the
native guest does, so the phone sees exactly what the TUI guest sees.

```
phone (our UI)             our server                 OMP host process
     │                          │                            │
     │  fetch link (session     │                            │
     │  cookie + CSRF)          │── omp collab link ────────►│
     │◄─── {url} (bearer!) ─────│◄────────── url ────────────│
     │                          │                            │
     │  ws://…/r/<room>?role=guest   (relay, TLS at the edge) │
     ├──────────────────────────┼───────────────────────────►│
     │  hello + sealed prompt   │                            │
     │◄─ welcome/snapshot/event ┼────────────────────────────│
```

Two decisions follow from the verified frame grammar
(`packages/coding-agent/src/collab/protocol.ts`, `packages/collab-web/src/lib/*`):

1. **The link is handed to the browser at most once.** It is a bearer
   credential; the server never stores it, never logs it, and never re-serves it
   from cache. `POST /api/conversations/:id/link` mints a fresh deep link
   (`<publicOrigin>/#<relayLink>`) each call, bound to the generation observed
   immediately before, and the response carries `Cache-Control: no-store`.
2. **The UI is a thin renderer over four frame kinds** — `entry` /
   `snapshot-chunk` (history), `event` (live), `state` (session footer),
   `agents` + `bus` (subagents) — plus `ui-request` for host questions.

## Why not reuse the upstream client wholesale

We vendored and patched it (`packages/guest`) because the upstream page loads a
third-party analytics script, ships no CSP, and leaves one markdown renderer
path without a scheme gate. Reusing it in the product also means every upstream
cosmetic decision becomes our UI, and its offline/PWA story is thin.

Reuse is still the right call for **protocol code**: `link.ts`, `socket.ts`,
`codec.ts` and the frame types are small, correct, and expensive to get wrong
(base64url without Buffer, the 4-byte envelope, AES-GCM sealing order). Those
are vendored with attribution; the React surface is ours.

## Honest capability reporting

The guest protocol cannot do everything the local TUI can. These are surfaced in
the UI as unavailable rather than faked:

| Capability | Guest | We show |
| --- | --- | --- |
| Prompt, abort, subagent kill/revive | yes | enabled |
| Read-only viewer link | yes | offered as a safe-share action |
| Host questions (`select`/`editor`) | yes | rendered as approval UI |
| Tool approvals that need a terminal prompt | degraded | shown as a `select`, labelled as such |
| Slash commands, `/model`, bash, python | no | hidden |
| Terminal attach | no | "How to attach" card with a real private-socket tmux command |

## Reconnect behaviour

- The socket reconnects with exponential backoff while the tab is open.
- On reconnect the client re-syncs from the host's snapshot rather than
  replaying its own buffer, so a missed window is repaired authoritatively.
- A dropped socket is reported as `disconnected`, which is distinct from
  `stopped`. We never infer completion from a closed connection.
- Prompts carry a UUID idempotency key inside the sealed Collab frame: the
  agent host validates it, so a retry after a flaky network cannot queue the
  same prompt twice.
