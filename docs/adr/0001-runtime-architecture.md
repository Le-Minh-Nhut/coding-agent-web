# ADR 0001 — Runtime architecture: tmux-hosted native OMP sessions with a private Collab relay

- Status: accepted
- Date: 2026-10-24
- Baseline: OMP 18.12.2, tmux 3.6, Ubuntu 26.04, Tailscale 1.104.1

## Context

The product must let an iPhone drive OMP running on an Ubuntu laptop without
losing work, without creating a second agent, and without giving up the ability
to walk over to the laptop and attach a terminal to the same running session.

Three architectures were considered:

- **A.** tmux + native OMP Collab + a workspace manager that programmatically
  launches sessions, reads the local host registry, and hands the browser a link.
- **B.** OMP `--mode rpc` / `rpc-ui` + a process supervisor + an explicit
  stop-then-resume terminal handoff.
- **C.** tmux + a browser terminal (xterm.js) + a structured monitoring adapter
  that scrapes or wraps terminal output.

## Decision

**Architecture A.** The runtime of record is an OMP process owned by a tmux
session, hosting itself over Collab. Coding Agent Web never speaks to the agent
loop directly: it launches, supervises, discovers, and links.

## Evidence

All of the following were observed on the baseline machine, not inferred from docs.

1. **A tmux-hosted OMP hosts itself.** Launching
   `omp --config=<overlay with collab.autoStart: control>` inside tmux produced a
   registry entry from `omp collab list --json` with `relayConnected: true`,
   `access: control`.
2. **A terminal attaches to the exact same process.** `tmux attach` /
   `tmux send-keys` during a live turn acted on the same agent; `capture-pane`
   showed the guest's prompt and the agent's reply in the host's own TUI.
3. **A browser guest drives that process.** The upstream browser client, loaded
   at a deep link in a 390×844 viewport, connected through a private relay,
   accepted a prompt, and rendered the streamed reply (`BROWSER-OK`).
4. **A private relay is viable.** A ~120-line Node relay speaking the published
   contract (`GET /r/<roomId>?role=host|guest`, 4-byte big-endian peer prefix,
   sealed payloads forwarded verbatim) served both the static client and the
   WebSocket endpoint; OMP connected to it with `collab.relayUrl` and a guest
   exchanged prompts through it.
5. **A guest over a private relay drives the agent.** `omp join <link>` against
   the private relay produced `RELEAY-OK` from the host agent.
6. **Writer safety is real but silent.** A second process opening a live
   session does not corrupt it and does not reject: it **forks** to a new file
   with `parentSession` set. This is safe for data but dangerous for intent, so
   the workspace must detect ownership *before* launching and refuse to start a
   duplicate writer for a conversation it already runs.
7. **Liveness is externally detectable.** A live session holds a Linux abstract
   Unix socket named `omp-file-lock-<xxh64(lockPath)×2>`, keyed by
   `~/.omp/run/session-owners/<sessionId>.lock`; the name was reproduced
   independently and found in `/proc/net/unix` for a live session. This is the
   primitive used for "is this conversation actually running".

## Rejected alternatives

- **B (RPC supervisor).** Independent research (`docs/research/omp-rpc-sdk.md`)
  found no supported way to attach a TUI to a *running* RPC turn — continuity
  would degrade to stop-then-resume, which breaks the core invariant. RPC also
  requires us to reimplement the UI surface Collab already provides natively.
  Kept as a future adapter path for non-collab transports, not the runtime.
- **C (browser terminal + scraping).** Scraping ANSI output to synthesize
  structured tool/agent events is explicitly disallowed when an official
  structured transport exists, and a phone-sized terminal is the wrong default
  UX. Rejected as the primary transport; the terminal handoff we do support is
  the *native* tmux attach, which needs no emulator.

## Consequences

- **Positive.** Native session files stay authoritative, so CLI and browser
  share one history. Terminal continuity is free. We reuse a supported,
  encrypted, structured transport instead of reimplementing agent internals.
- **Positive.** Room links grant access by possession, matching the product's
  single-owner model; we never need the agent's provider credentials in the web tier.
- **Negative.** We depend on the `collab.*` surface, so upstream changes to the
  registry JSON or frame grammar can break us. Mitigated by an explicit
  compatibility check and a recorded baseline version.
- **Negative.** The published production relay is not self-hostable, so the
  product ships its own relay. A private relay must therefore be treated as part
  of the trusted computing base: it must never log or persist frames (it cannot
  decrypt them, but it can correlate room ids and sizes).
- **Negative.** Hosted-relay deployment would place room metadata on a third
  party's infrastructure. Deployment policy is recorded in ADR 0002.

## Invariants this decision commits us to

1. Exactly one writer per conversation: an app conversation maps to at most one
   tmux session, and a conversation whose native session is already leased is
   never launched again.
2. Closing a browser detaches a viewer; it never stops an agent.
3. Status is reported from observed registry/lease/process facts, and unknown is
   reported as unknown.
4. A browser deep link is a bearer credential: never logged, never persisted in
   the web tier's storage beyond an in-memory handoff.
