# @caw/relay

The private Collab relay for Coding Agent Web: one loopback HTTP listener that serves the built
browser guest client at `/` and speaks the OMP Collab relay contract at
`GET /r/<roomId>?role=host|guest`.

## Why this exists

The public relay (`wss://my.omp.sh`) is not self-hostable, and routing the owner's session metadata
through a third party is out of policy (ADR 0001). Upstream ships a local stand-in
(`packages/collab-web/scripts/local-relay.ts`) but no production server: it omits the static client,
`/healthz`, the room cap, and any admission control. This package is that server.

## Contract

Everything below was reverse-engineered from the upstream tarball at
`/tmp/caw-poc/oh-my-pi` and verified end-to-end against real OMP clients.

| Rule                                                           | Implementation                                            | Upstream evidence                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Endpoint `GET /r/<roomId>?role=host\|guest`                    | `src/relay.ts` upgrade gate + `wss.handleUpgrade`         | `packages/collab-web/scripts/local-relay.ts:51-61`; `packages/coding-agent/src/collab/relay-client.ts:506` |
| Room id `^[A-Za-z0-9_-]{10,64}$`                               | `ROOM_PATH_RE`                                            | `collab/protocol.ts:179`; `local-relay.ts:20`                                                              |
| Envelope `[4B uint32 BE peerId][sealed payload]`               | 4-byte prefix read/written in place                       | `collab/protocol.ts:152-173`; `collab-web/src/lib/link.ts:58-72`                                           |
| Host peerId `0` → broadcast to all guests, forwarded unchanged | `peerId === 0` fan-out                                    | `local-relay.ts:88-91`                                                                                     |
| Host peerId `N` → that guest only, forwarded unchanged         | `guests.get(peerId)`                                      | `local-relay.ts:92-94`                                                                                     |
| Guest frame → host, prefix rewritten to the sender's peerId    | `frame.writeUInt32BE(peerId, 0)`                          | `local-relay.ts:97-99`; `protocol.ts:170-173`                                                              |
| Sealed bytes never touched, reordered, or re-encrypted         | only bytes 0-3 are ever written                           | `collab-web/src/lib/codec.ts:28-38`                                                                        |
| Relay TEXT to host: `{"t":"peer-joined","peer":N}`             | sent on guest admission                                   | `local-relay.ts:81`; `packages/wire/src/index.ts:445-448`                                                  |
| Relay TEXT to host: `{"t":"peer-left","peer":N}`               | sent on guest close                                       | `local-relay.ts:117-119`                                                                                   |
| Host loss: TEXT `{"t":"room-closed"}` then close `4001`        | on host close / `stop()`                                  | `local-relay.ts:108-114`                                                                                   |
| Client TEXT frames are ignored                                 | both directions drop `!isBinary`                          | `local-relay.ts:84`                                                                                        |
| `ping`/`pong` are answered                                     | `ws` handles pongs natively; relay also probes idle peers | `relay-client.ts:57-59`                                                                                    |

### Close codes

| Code   | Reason                                      | When                                                    |
| ------ | ------------------------------------------- | ------------------------------------------------------- |
| `4000` | `bad request`                               | path is not `/r/<id>` or `role` is not `host`/`guest`   |
| `4001` | `room closed`                               | the host left, or the relay stopped                     |
| `4004` | `no such room`                              | guest joined a room no host holds                       |
| `4009` | `a host is already connected for this room` | second host for a live room                             |
| `4029` | `room is full`                              | guest beyond the cap, or the peer-id space is exhausted |
| `1001` | `relay shutting down`                       | host socket on `stop()`                                 |
| `1009` | —                                           | frame larger than `MAX_FRAME_BYTES` (`ws` `maxPayload`) |
| `1013` | `peer too slow`                             | peer exceeded the send-buffer ceiling                   |

`4001`, `4004`, `4009`, `4029` match upstream's client table verbatim
(`collab/relay-client.ts:18-23`). `1001` matches the reference relay's shutdown close
(`local-relay.ts:133`).

`4000` is ours, not upstream's: the reference relay answers a bad path/role with HTTP `404` before
upgrading (`local-relay.ts:55-60`), so no close code exists there. We upgrade first (the `ws` server
owns the handshake) and then close the completed socket with `4000 bad request`, which is the
bad-request code both PoCs that were verified end-to-end against real OMP clients used
(`/tmp/ws-poc/relay.mjs:17`, `/tmp/ws-poc/combined.mjs:55`). No upstream client special-cases it —
only `4001`/`4004`/`4009`/`4029` drive reconnect behaviour (`relay-client.ts:708-720`).

### Documented limits

- `MAX_GUESTS_PER_ROOM = 8`. Upstream's reference relay has no cap and accepts guests until the
  process dies (`docs/research/collab-relay-selfhost.md` §3), while upstream's client already handles
  `4029` (`relay-client.ts:22`). Eight bounds relay memory per room and is far above this product's
  real usage (the owner's phone plus a spare device).
- `MAX_FRAME_BYTES = 8 MiB`. Upstream's host caps its own payload at
  `MAX_REPLICATED_PAYLOAD_BYTES = 1 MiB` (`collab/replication-shrink.ts:55`), chunks snapshots at
  512 KiB (`collab/host.ts:134`), and its regression test stands in for a relay with an 8 MB ceiling
  (`packages/coding-agent/test/collab/replication-shrink.test.ts:310`). Bun's WebSocket default is
  16 MB; 8 MiB is 8x the largest legitimate frame.
- `MAX_BUFFERED_BYTES = 4 MiB` per socket, `HEARTBEAT_INTERVAL_MS = 30 s`, `SHUTDOWN_FLUSH_MS = 1 s`.
- Peer ids are `uint32`, assigned from 1 and never reused while a room lives; the assignment is
  guarded so the counter cannot wrap.

### The relay does not implement the host reclaim window

Upstream hosts keep retrying a `4009` for up to `HOST_RECLAIM_WINDOW_MS = 150_000`
(`relay-client.ts:28-50`) because a relay may hold a dead socket open for ~40-120 s. This relay
retires the room the moment the host's socket closes and probes idle peers every 30 s, so a
reconnecting host gets a clean room immediately. That is strictly more available than upstream's
assumption requires, not less.

## Trust model

- **Content-blind.** Every payload after the 4-byte prefix is AES-256-GCM ciphertext produced by the
  clients. The relay never holds the room key or the write token: both ride in the URL _fragment_
  (`protocol.ts:278-287`), which browsers and native clients never send over the socket.
- **What the relay can see:** room ids (in the path), client IPs and connection timestamps, the
  number of participants per room, ciphertext sizes, and the plaintext 4-byte peerId of each frame —
  i.e. which guest a frame was addressed to. Payload length and timing are the only side channels.
- **Never logged:** payload bytes, room keys, write tokens, and full collab links. Room ids _are_
  logged (they are low-entropy handles that appear in the URL path anyway) together with peer
  counts. The logger signature only accepts a single pre-composed string, so there is no object
  channel that could leak a frame.
- **Admission.** Browser sockets on the app listener are checked against the `allowedOrigin` allowlist plus
  `Sec-Fetch-Site`; native OMP clients send no `Origin` and are admitted (they cannot be driven by a
  page). Serve must expose the app listener only. The separate host listener stays on loopback and MUST NOT
  be proxied; the host-role limitation is described below.

- **Host-role access is local-network scoped, not managed-agent authentication.** The host role is reachable by any process on this machine that can reach `127.0.0.1:<relayPort>`. This is a topology control, not authentication of the managed agent; distinguishing our agent from another local process would require a credential OMP cannot present (its socket URL is built internally and accepts no headers). Tailscale Serve must proxy only the app port, never the private relay port.
- **No persistence.** Rooms live in a `Map` for the process lifetime. Restarting the relay drops
  every room; a host reconnecting recreates its room under the same id.

## Usage

```ts
import { startRelayFromEnv } from "@caw/relay";
const relay = await startRelayFromEnv(); // or createRelay({...}) directly
await relay.stop();
```

Environment (`src/index.ts`):

| Variable                    | Meaning                               | Default                     |
| --------------------------- | ------------------------------------- | --------------------------- |
| `CAW_RELAY_PORT`            | listen port (`0` = ephemeral)         | `7466`                      |
| `CAW_RELAY_HOST`            | bind address                          | `127.0.0.1`                 |
| `CAW_RELAY_ALLOWED_ORIGINS` | comma-separated exact browser origins | loopback origins (dev only) |
| `CAW_RELAY_STATIC_DIR`      | built guest client directory          | none (relay only)           |

`GET /healthz` returns
`{"ok":true,"version":"0.1.0","rooms":N,"guests":N,"uptimeMs":N}`.

In production OMP points at `ws://localhost:7466` (`collab.relayUrl`, allowed because `ws://` is
restricted to localhost — `protocol.ts:216`) and the browser reaches the same relay as
`wss://<host>.tailnet.ts.net/`, with `tailscale serve` terminating TLS.

## Static serving

`src/static.ts` resolves exact paths only: decode once, reject a NUL or backslash, reject `""`/`"."`/
`".."` segments and any segment containing a separator, open with `O_RDONLY | O_NOFOLLOW`, then
confirm on the _handle_ that the file is a regular file and still inside the root (via
`/proc/self/fd/<fd>`, which also closes the check-then-open race for intermediate symlinks). No
directory listing, no SPA fallback: the guest client is a single page loaded at `/`, so an unknown
asset path is a `404`, never a mislabelled `index.html`. `/healthz` is exempt from the root check so
a relay-only listener still reports health.

Every static response carries `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`
(the fragment holds the room key, so a leaked `Referer` would be a leaked credential).

## Tests

```bash
pnpm --filter @caw/relay typecheck
pnpm vitest run tests/relay
```

`tests/relay/relay.test.ts` drives the wire contract with real `ws` clients (routing, prefix
rewrite, control frames, every close code, the guest cap, frame cap, Origin policy, a 100-frame
deterministic fuzz in both directions), `tests/relay/static.test.ts` covers traversal, symlink
escapes, headers, 404s and `/healthz`, and `tests/relay/package.test.ts` pins the version and env
wiring.
