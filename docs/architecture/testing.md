# Test strategy

The product's hard part is not rendering a chat: it is not losing an agent, not
creating a second one, and not lying about state. The test pyramid is weighted
accordingly — lifecycle and safety first, pixels last.

## Layers

| Layer | Location | Runs in CI | Cost |
| --- | --- | --- | --- |
| Unit + Integration | `tests/{server,adapter,runtime,protocol,relay,guest,web}/**` | yes (`pnpm test`) | free (simulated OMP, isolated tmux) |
| Browser E2E | `tests/e2e/**` | yes (`pnpm test:e2e`; Chromium, phone viewport) | free |
| Real-OMP compatibility | `tests/compat/**` | **opt-in** (`CAW_COMPAT=1 pnpm vitest run tests/compat`) | launches agents; LLM-backed cases cost money |

The compatibility layer is gated by environment variable on purpose: a normal
`pnpm test` must never start an agent or spend the owner's provider credits.

## What each layer must prove

### Unit — the invariants we cannot afford to get wrong

- **Lease naming.** `leaseName('01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e')` must
  equal `omp-file-lock-8d8c8d3727dacea282d09ee9f3d89461`. This vector was
  reproduced independently against a live session; if the hash regresses, we
  silently lose the ability to see that a session is being written and start
  forking duplicates.
- **Path policy.** Sibling-prefix escapes, symlink escapes, traversal, NUL
  bytes, NFC/NFD, and non-directories. Each is an attack we claim to stop.
- **Session bucket encoding.** A wrong cwd bucket means we look for a
  conversation in a directory it will never be written to.
- **Metadata command storage.** `recordCommandOnce()` stores one command row per key; `tests/server/store.test.ts` proves that store-level behavior only. No prompt route calls it, and no test proves one agent-visible effect.
- **Event ordering.** Per-conversation sequence numbers are monotonic, and a
  replay after a cursor returns exactly the missing suffix.

### Integration — process and lifecycle behaviour

With fake OMP processes and a private tmux socket per test:

- launch → registry visible → stop → process gone;
- a stored `$N` that no longer exists becomes `stopped`/`error`, never `running`;
- an unreadable registry marks conversations `unknown` and never `stopped`;
- two simultaneous launch requests for one conversation yield exactly one process;
- a conversation whose native session is leased by a foreign process is refused
  with `conflict_owner` and **nothing is launched**;
- the relay closes a room when its host dies and guests see `room-closed` with 4001;
- orphan protection: an unrecorded tmux session is never killed, because reconciliation acts only on recorded sessions.

### Browser E2E — the surfaces a phone actually uses

Chromium at 390×844 (and WebKit where the runner has it):

- login, wrong password, logout, cookie flags;
- project create → folder browse → new chat;
- live streaming render, tool card expansion, long-history scroll;
- **Reconnect**: the mock-host E2E sends a prompt, drops the socket, and asserts
  recovery does not automatically resubmit it. The composer unit test double-clicks
  one draft and asserts one prompt frame. Neither test exercises a manual resend
  after ambiguous delivery; the wire has no request ID, so duplicate work remains
  possible.
- forbidden path is refused with a visible error, not a blank screen.

### Real-OMP compatibility — opt-in

Runs against the installed `omp` with disposable directories:

1. `omp --version` matches the recorded baseline (or records a new one);
2. start a session through our launcher, confirm `omp collab list --json` shows it;
3. confirm the browser deep link's relay origin is ours;
4. attach with `tmux` and assert the same process answers;
5. stop it, assert the journal survives and a later `--resume` reads it;
6. assert no second writer was created (lease probe before/after).

## Failure injection

Simulated explicitly, because these are the cases that turn a demo into a tool:
closed browser, lost Wi-Fi, expired session cookie, backend crash mid-turn,
unexpected OMP exit, missing tmux, unreachable relay, malformed session journal,
stale room generation, simultaneous prompts, pending approval during a
disconnect, and two agents editing one working tree.

## What automated tests cannot prove

Playwright WebKit is not iOS Safari. Viewport emulation does not reproduce the
software keyboard, safe-area insets, background suspension of WebSockets, or
AIM/ITP cookie eviction. Those require a physical iPhone, and the operations
runbook lists the checks that must be performed there by hand.
