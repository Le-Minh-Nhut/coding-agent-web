# ADR 0002 — Private relay and remote access: loopback + Tailscale Serve

- Status: accepted
- Date: 2026-10-24
- Depends on: ADR 0001

## Context

OMP's Collab transport requires a relay, and a browser guest needs a *secure
context* to use WebCrypto (AES-256-GCM sealing of every frame). The published
production relay is closed-source and not distributed for self-hosting, and its
deployment option places room metadata on a third party's infrastructure.

Three deployment options were on the table:

1. Use the hosted relay (`wss://my.omp.sh`) with informed opt-in.
2. Run a private relay and reach it over the tailnet.
3. Use plain `ws://` on the LAN for simplicity.

## Decision

**Run our own relay on loopback, and reach it from the iPhone over Tailscale
with `tailscale serve` providing TLS.** The relay binds `127.0.0.1`; OMP
connects to it as `ws://localhost:<port>`; the phone connects through
`https://<machine>.<tailnet>.ts.net/`.

## Evidence

- OMP rejects a non-localhost plaintext relay
  (`packages/coding-agent/src/collab/protocol.ts:216`), so option 3 is not
  available to the agent side at all, and option 1/2 both need TLS for the browser.
- A private relay is viable and was proven: OMP hosted against
  `collab.relayUrl: ws://localhost:7466` and reported `relayConnected: true`;
  a real `omp join` guest and a real Chromium guest both drove the host agent
  through it.
- The deep-link format carries web and relay separately
  (`formatCollabWebLink`, `protocol.ts:283`): `<webUrl>/#<relayLink>`. The
  browser may therefore be served by us while the relay is addressed by OMP as
  `localhost` — the phone never needs to speak `ws://`.
- On this machine `tailscale` is present at 1.104.1 and its tailnet DNS name is
  issued (`heheboiz-legion-5-15arh7.tail8d8eff.ts.net`). `tailscale serve`
  currently requires root or an operator grant (`sudo tailscale set
  --operator=$USER`) — recorded as a setup step, not a code dependency.

## Consequences

- **Positive.** No room metadata leaves the tailnet. The relay is
  content-blind by construction (it forwards sealed bytes), so it is a
  metadata-only trust anchor, and we can keep it that way by never logging
  payloads, keys, or links.
- **Positive.** One origin serves the browser client and the room endpoint, so
  there is no cross-origin CSP or cookie problem, and the room link never
  reaches an origin we do not control.
- **Positive.** The same origin is `https://`, which is what iOS requires for
  WebCrypto, for service-worker-free PWA install, and for `Secure` cookies.
- **Negative.** Remote access depends on the tailnet being up. That is the
  intended failure mode: the alternative is exposing the control plane publicly.
- **Negative.** `tailscale serve` needs a one-time privileged grant. We document
  it and degrade gracefully: with no TLS front, the app still runs on loopback
  and reports `capability_missing` for browser-guest features instead of
  pretending to work.
- **Explicitly out of scope.** `tailscale funnel` must never be used: it would
  publish the control plane to the public internet.

## Rules this decision commits us to

1. The relay binds loopback unless an explicit override is set, and the override
   is documented as unsafe in the config file itself.
2. Browser guests are only served when the request origin matches the configured
   web origin; otherwise the relay refuses the upgrade.
3. `Referrer-Policy: no-referrer` on every response we serve, so a room link can
   never leak outward through a referer header.
4. Room links live only in the URL fragment the user's phone requested, and in
   server memory for the lifetime of a handoff. They are never written to the
   metadata store, never logged, and never sent in a push notification.
5. **The room endpoint is split by privilege over one room table.** The app origin
   — the one `tailscale serve` proxies — accepts guests only and refuses a
   `role=host` upgrade outright; a second listener, bound to `127.0.0.1`, is the
   only place a host upgrade is accepted, and our managed agents connect there.
   The reason is mechanical: Serve rewrites every remote caller's peer address to
   loopback, so a proxied host endpoint would let anyone on the tailnet claim a
   room's host role. The relay port must therefore never be proxied, and the
   deployment docs say so explicitly. Residual, stated honestly: any process
   already running on this machine that can reach the relay port can claim a host
   role, because OMP builds its socket URL internally and cannot present a
   per-launch credential. That is a topology control, not agent authentication.
6. **A room link handed to a browser is always a deep link**: `<publicOrigin>/#<relayLink>`.
   The room path therefore lives in the fragment, which no server ever receives.
   Because OMP derives its own link from `collab.relayUrl` — which points at the
   internal host listener — the origin is rewritten on the way out, preserving the
   room id and secret byte for byte. A link in any other form is refused rather
   than normalized: the URL parser folds dot segments and rewrites paths, so an
   input that does not survive a parse-and-reprint unchanged is not one we can
   vouch for, and silently rewriting that fragment would move the credential into
   bytes the network can see.
