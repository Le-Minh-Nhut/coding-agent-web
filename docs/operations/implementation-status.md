# Implementation status

Updated: 2026-10-25. Honest ledger. Raw evidence: `docs/operations/evidence.md`.
Audits: `docs/audits/round-1-architecture.md` (architecture/concurrency),
`docs/audits/round-2-security.md` (security),
`docs/audits/reconciliation-verification.md` (real-process reconciliation),
`docs/audits/round-3-post-fix-verification.md` (post-fix pass).

Legend: **verified** = ran it and saw it work · **built** = code + tests pass,
integration not exercised · **pending** · **blocked**.

## M0 — research and feasibility: verified

Repo and tooling audited; six research reports; two ADRs; the proof-of-concept
record in `docs/research/proof-of-concept.md`. Observed on this machine against
OMP 18.12.2: a tmux-hosted agent hosts itself; a private relay replaces the hosted
one; a browser guest and a terminal both drove the same process; **closing the
browser does not stop the agent** and a fresh browser adopted the same room;
resuming an existing native session works under a managed launch; a second writer
forks rather than corrupting, which is why the pre-launch lease guard exists.

## M1 — foundation: verified

`pnpm -r typecheck` clean; capability probe 18/18; the whole suite green (count
below). Contracts, adapters, relay, runtime, vendored guest client, web app and
server all exist as real code with tests.

## M2 — native session lifecycle: verified against real processes

`CAW_COMPAT=1 npx vitest run tests/compat` → **8 passed**: managed launch with a
recorded `$N`, terminal attach showing the agent's own TUI, duplicate-writer
refusal with exactly one session left, stop by recorded id, and six reconciliation
scenarios (adopt a live agent; a dead process with surviving history becomes
`stopped`; never kill what we did not record; a foreign writer is `unknown`; an
unreadable registry never yields a clean slate; an unowned room is `external`).

Qualification recorded honestly in the reconciliation audit: OMP does not write a
journal without a prompt, so one scenario seeded an OMP-shaped header, leaving
survival of a *real* OMP-written journal **UNVERIFIED**.

## M3 — live chat integration: verified end to end

`node scripts/acceptance-ui-drives-agent.mjs` against a live server → **7/7 PASS**
at a 390×844 viewport:

```
PASS  login through the UI lands on the projects screen
PASS  conversation created (launches a real agent) — tmux $1
PASS  the agent published its native session — 01a16fce-…
PASS  state reflects a live agent — idle
PASS  a live session link is minted — 200, access "full", 109-byte secret
PASS  our UI opened a guest socket to the relay — (open, not looping)
PASS  the conversation screen reports a live session — "Connected — no turn in flight"
```

A visual inspection of the screenshot confirmed: composer bottom-anchored, no
clipping, agent identity and state legible, nothing misleading.

## M4 — security: audit complete, P1s closed

Threat model in `docs/architecture/security-model.md`. Independent security audit:
11 findings, each with a reproduction. Verified working: scrypt with per-password
salt and constant-time compare; hashed session keys; `__Host-` cookie flags; CSRF
bound to the session; no CORS header; 413 body limit; foreign WebSocket origin
refused; guest cap and frame cap; unenumerable room ids; content-blind relay; link
never in a generated URL or a log; `no-referrer` everywhere; `shell:false` argv
everywhere; every path-policy adversarial input refused; `0700`/`0600` state.

Closed after the audit: relay `role=host` upgrades are isolated to a private loopback
listener (`config.relayPort`, default 8792) that Serve must never proxy; the guest client no
longer writes the bearer link into the URL or history; the view-only link path is
reachable via `?access=view`; login throttling no longer locks the owner out;
duplicate launch names are impossible because the name is derived from the
conversation id.

## M5 — QA, audits, release: audits and final verification complete

- `npx vitest run` → **334 passed | 8 skipped** (the skips are the opt-in real-OMP
  suite).
- `CAW_COMPAT=1 npx vitest run tests/compat` → **8 passed**.
- Playwright E2E, Chromium at 390×844 → **24 passed**, including: a prompt reaches
  a live host exactly once; a dropped connection is reported as reconnecting and
  recovers without resubmitting; a prompt sent while the host is gone never becomes
  a silent success; `unknown` is its own state; renaming or deleting a project
  never touches the directory on disk.
- Seven independent audit passes delivered, plus a dedicated reconciliation
  verification: architecture and concurrency (`round-1`), security (`round-2`),
  post-fix (`round-3`), final (`round-4`), verification of round 4 (`round-5`), of
  the P0 fixes (`round-6`), and of the ownership fixes (`round-7`). Each later pass
  ran against code the earlier one had changed, and each found something the
  previous one had not — which is the argument for doing them sequentially rather
  than once.
- `node scripts/acceptance-ui-drives-agent.mjs` → **7/7 PASS** against a live server,
  with the credential invariant checked independently: the minted link's secret
  decodes to 48 bytes (32-byte key + 16-byte write token), the room path appears
  **only in the URL fragment**, and the host is registered with `relayConnected: true`.

### Closed after being re-opened by round 6

Round 6 (`docs/audits/round-6-verification-of-p0-fixes.md`) found both round-5 fixes
still partial, with real-tmux reproductions. Both were then fixed at the root:

- **Ownership was inferred from a display name.** A live managed session renamed out
  of the `caw-` prefix vanished from enumeration, so accounting undercounted and a
  third agent launched against a cap of two. Ownership now comes from enumerating
  every session on the app's own private tmux socket; a name is a label, and the
  socket is the boundary.
- **An unreachable socket is not a dead process.** `serverIdentity() === null` also
  occurs when a socket pathname is unlinked while the server and agent keep running,
  and `stop()` reported `stopped` for a live agent. The verdict now corroborates on
  the recorded **pane pid** — the process it is actually condemning — and only
  `ESRCH` settles. Alive, unsignalable, or legacy-unknown pids refuse to settle and
  leave the conversation at `stopping`.

Round 7 (`docs/audits/round-7-verification-of-ownership-fixes.md`) verified the
stop fix (**B**) as genuinely closed and left one bypass in **A**: after a socket
pathname was unlinked and a new server took the same path, enumeration saw only the
new server and a launch was admitted while the previously recorded process was
still alive.

That is now closed from the recorded process identity, the same way stop decides:
an enumeration is **not** evidence that a previously known process is gone, so a
row whose session is absent is judged on its recorded pane pid — alive ⇒ refuse
(`conflict_owner`), `ESRCH` ⇒ stale row, launch may proceed, uncheckable or legacy
⇒ fail closed. `start()` and `activeCount()` share the rule, and an unreadable
server reports `known: false` rather than a confident zero.

**Ceiling, named rather than hidden:** a process that was **never observed** — a
session created directly on an unlinked server that no listing ever saw — leaves no
record to check, so its liveness cannot be established. Nothing available
distinguishes it, and the code comment says so instead of implying otherwise. In
practice this requires an actor with shell access on the laptop, who already has
more direct ways to interfere than racing a socket.

Two residuals remain honest rather than closed: pid reuse can make a dead process
look alive and leave a stop at `stopping` (the safe direction — a hung stop, never
a live agent reported dead), and the never-observed case above.

### Closed after round 5

The two remaining holes were both fixed and re-verified:

- **Ownership now survives our own restart.** A live managed tmux session with no
  recorded owner makes every launch refuse with `conflict_owner` until a human
  accounts for it, so a new supervisor over the same store cannot start a third
  agent past a cap of two. Deliberately blunt, and verified with the audit's own
  reproduction: a failed metadata write plus a failed guarded kill, then a retry
  through a fresh supervisor.
- **A stop verdict is attributed, not assumed.** The session probe is bracketed by
  matching server-identity reads, so a dead stranger at a reused `$N` cannot confirm
  a stop. The remaining window — a tmux restart after the final identity read and
  before the store write — is named in a code comment rather than hidden.

Fixing the second one exposed a regression worth recording: treating a *null* server
identity as a mismatch meant a genuine stop could never be confirmed, because tmux
3.6 removes a server as soon as its last session ends. The real-OMP compatibility
suite caught it (`expected 'stopping' to be 'stopped'`), which is exactly why that
suite exists. A confirmed-gone server is now a confirmed stop, on both the pre-kill
guard and the poll.

## Defects found by audit and closed

| ID | Sev | Defect | Status |
| --- | --- | --- | --- |
| ARCH-1 | P0 | Launch guard was check-then-act; two concurrent requests could both launch a writer for one native session | fixed, test fails pre-fix |
| ARCH-2 | P0 | A recorded tmux `$N` could be reused after a server restart, so adopt or stop could hit a stranger's session | fixed; identity gate plus server-identity test |
| ARCH-3 | P1 | A link could cross a session switch and point the phone at the successor room | fixed; generation+instance comparison |
| ARCH-4 | P1 | `busy === null` rendered as `idle` | fixed; only `false` means idle |
| ARCH-5 | P1 | Failed observations (lease/registry) reported as confident states | fixed; unknown propagates |
| SEC-1 | P1 | Bearer link written into the URL and session history | fixed; `replaceState`, bundle assertion |
| SEC-2 | P1 | Relay `role=host` unauthenticated, no room cap, no rate limit | fixed |
| SEC-3 | P1 | View-only link unreachable | fixed; `?access=view` |
| SEC-5 | P2 | Process-global login backoff locked the owner out | fixed |
| SEC-6 | P2 | Duplicate titles produced colliding launch names | fixed |
| — | P1 | Concurrency slots counted from stored state, so a dead agent's slot wedged the cap forever | fixed; counted from live sessions |
| — | P1 | Web UI reopened its socket on every render (44 sockets in 9 s) | fixed; ref-stable frame handler |

## Delivered after the audit rounds

Two P1 requirements from the brief were completed after the final audit, and both
were verified against a live server:

- **PWA installation metadata.** A same-origin manifest (`display: standalone`,
  `start_url` and `scope` at the app root), a committed 180×180 Apple touch icon
  plus 192 and 512 sizes, and the iOS home-screen meta tags. Safe-area padding now
  covers all four edges so a standalone launch keeps the composer reachable. Fixing
  this surfaced a real bug: the production entry point never imported the
  stylesheet, so the built app had no CSS at all.
- **User-controlled model selection.** A per-conversation preference, validated
  server-side (trimmed, non-empty, bounded) and applied through
  `RuntimeLaunchSpec.model` on the next launch. The UI keeps the *effective*
  model the registry reports distinct from the *saved preference* and states that
  a change applies on restart. Enumeration of OMP's model list would need
  `ModelCatalogService.listModels(): Promise<string[]>` in the adapter, which was
  out of scope; the documented free-text fallback shipped instead.

Verifying the restart path found and fixed a second real defect: a restart after a
stop failed with a 500 when no journal existed yet, which is exactly the
"change the model, then restart" flow. Restart now launches a fresh session when
there is nothing to resume, while an **explicit** resume of an unknown session id
is still refused (404) rather than silently starting a different one. The action
schema is `strict()` so an unsupported field is a 400 rather than being silently
dropped.

## Known gaps

| Gap | Impact | Plan |
| --- | --- | --- |
| Any local process can claim a relay host role | The host listener is loopback-only, which closes the network path, but OMP cannot present a per-launch credential, so this is not agent authentication | Documented in the relay README, the code comment, and the release notes. Acceptable only under the single-owner trust model that already assumes the machine is yours. |
| Non-Linux lease detection | Returns `unknown`, which blocks launch rather than guessing | Out of scope (Ubuntu target), documented not faked |
| `tailscale serve` needs a one-time privileged grant | Remote access depends on it | Documented; degrades to loopback-only |
| Physical iPhone validation | Keyboard, safe-area, tab-suspend behaviours unproven | Manual checklist in the iPhone setup doc |
| Real OMP-written journal through a failure scenario | One reconciliation qualification | Recorded UNVERIFIED |
| Approval (`ui-request`) against a live host that asks a question | Untested end to end — the queue and exactly-once answer are covered by unit tests, but no real host has raised one | Notifications and approval polish deferred by design |
| Single-process launch guard | A second backend on the same machine would need a cross-process lease | Named as a ceiling in the code |
| OMP upstream drift | `collab.*` is not a stability guarantee | `scripts/compat-check.mjs`, recorded baseline, upgrade procedure |
