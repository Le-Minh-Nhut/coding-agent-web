# Implementation status

Updated: 2026-10-26. Honest ledger. Raw evidence: `docs/operations/evidence.md`.
Audits: `docs/audits/round-1-architecture.md` (architecture/concurrency),
`docs/audits/round-2-security.md` (security),
`docs/audits/reconciliation-verification.md` (real-process reconciliation),
`docs/audits/round-3-post-fix-verification.md` (post-fix pass), and the round-eight evidence listed below.

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

Round-eight worker report: fresh-clone `pnpm -r typecheck` passed. Capability
probe now reports **17 ok / 1 warn / 0 fail**; the warning is correct when no
Collab hosts are running, because per-host shape cannot be checked without a
host. The previous 18/18 count is stale. Contracts, adapters, relay, runtime,
vendored guest client, web app and server exist as real code with tests.

## M2 — native session lifecycle: verified against real processes

Round-eight worker report: `CAW_COMPAT=1 npx vitest run tests/compat` →
**8 passed**. Managed launch with recorded `$N`, terminal attach, duplicate-writer
refusal, stop by recorded ID, and six reconciliation cases are covered. The
worker reported the clean process baseline restored after the run.

Qualification recorded honestly in the reconciliation audit: OMP does not write a
journal without a prompt, so one scenario seeded an OMP-shaped header, leaving
survival of a *real* OMP-written journal through failure **UNVERIFIED**.
## M3 — live chat integration: verified end to end

Round-eight worker report: `node scripts/acceptance-ui-drives-agent.mjs` against
a live server → **7/7 PASS**. The run drove a real agent through the UI, minted
a live link, and opened the guest socket; the worker reported a clean process
baseline afterwards. Exact evidence and cleanup record: `docs/operations/acceptance-run-plan.md`.

The earlier 390×844 visual review remains a separate historical observation; it
does not establish physical-iPhone behavior.

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


## M5 — QA, audits, release: round-one-to-seven evidence retained

The earlier suite counts and audit-round summary are historical, not current
verification; round-eight evidence and current gaps follow. Round-eight checks
were run by separate workers and are attributed as reports below, not as runs by
the ledger editor.

## Round 8 — clean checkout, integration, and delivered work

### Clean checkout and CI

Round-eight worker report: a fresh clone passed `pnpm install --frozen-lockfile`,
`pnpm -r typecheck`, `npx vitest run`, `node scripts/build-guest.mjs`,
`pnpm --filter @caw/web build`, the CI bundle-origin grep, `pnpm --filter
@caw/server build`, and Playwright Chromium (**24 passed**). The Vitest report
recorded **334 passed | 8 skipped**. Nine `packages/guest/src/lib/` files had
been untracked because the Python-template `lib/` ignore rule swallowed them; the
ignore rule was fixed and all nine files are tracked. `tsx` was promoted to a
root devDependency so a clean clone can start the E2E launcher. The clean clone
reported in the worker run used these fixes.

Hosted CI: **NOT VERIFIED** for current HEAD. `gh` was unavailable; the only
observable hosted run was for an old, pre-fix commit. See
`docs/audits/round-8-build-ci-and-test-inventory.md` for the recorded run and
clean-checkout evidence; its earlier E2E-blocked observation predates the root
`tsx` fix and is superseded by the later worker report above.

### Real OMP and acceptance

Round-eight worker report: `CAW_COMPAT=1 npx vitest run tests/compat` →
**8 passed**; the acceptance script → **7/7 PASS**. Both runs reported a clean
process baseline afterwards. The machine capability probe reports **17 ok / 1
warn / 0 fail**; the warning is the correct “no collab hosts running; per-host
shape unverifiable” case, not a failure. Details: `docs/operations/acceptance-run-plan.md`.

### Delivered

Round-eight work delivered directory creation and hardening, multi-root browsing,
resume-in-app for confirmed-free untracked native sessions, honest browse errors,
lifecycle detail, transcript snapshot restore and deduplication, upstream-correct
approval shapes, `isStreaming`, `toolResult`/`displayName`, transcript `reqId`
correlation, mobile reading-UX changes, slash-command honesty, and model-catalog
enumeration through the `omp models --json` adapter. Evidence and scope notes:
`docs/audits/round-8-*.md`, `docs/research/slash-command-feasibility.md`,
`docs/research/model-catalog.md`, `docs/assets/screens/manifest.md`, and
`docs/operations/acceptance-run-plan.md`.

### Known gaps — round eight

- No join/adoption of a live untracked native session; refusal remains fail-closed
  by design. Resume-in-app is for confirmed-free sessions only.
- Snapshot reduction is indexed rather than quadratic; round-nine benchmark at
  20,000 entries measured 5,105.65 ms before and 43.94 ms after, output-equivalent.
- `bus`, notice, compaction, and retry frames remain intentionally ignored or only
  minimally represented.
- Directory pagination now uses signed cursors; it is not a snapshot, so changes
  between pages may duplicate or skip rows.
- `welcome.readOnly` is surfaced and enforced: the banner appears while composer,
  approval controls, and Stop are omitted; the host remains the final enforcer.
- Physical-iPhone behavior (keyboard, safe area, lock/unlock, PWA) is **UNVERIFIED**.
- The browser's local monotonic `user-${++localIdRef.current}` identifies only an
  optimistic row; no ID travels on the prompt wire. `recordCommandOnce()` exists
  but has no production caller; manual resend after ambiguous delivery can enqueue
  duplicate work. See the idempotency notes in architecture and troubleshooting.
- Hosted CI for `53ef59bc9572d7af100ab565496491032abacf2a`: **VERIFIED**; run #7
  completed with every `verify` step green, including Chromium Browser E2E.
  `compat` was skipped by design; see `docs/audits/round-9-verification.md`.
- Directory creation detects and refuses parent/containment changes but has a
  TOCTOU ceiling: portable Node `mkdir` cannot bind atomically to the validated
  parent with `mkdirat`; the race is not claimed closed.

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
  a change applies on restart. Round 8 added adapter model-catalog enumeration via
  `omp models --json` (`docs/research/model-catalog.md`); searchable server/API/UI
  catalog wiring remains absent. The existing free-text model field remains.

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
| Physical iPhone validation | Keyboard, safe-area, lock/unlock, and PWA behavior unproven | Manual checklist in `docs/operations/acceptance-run-plan.md` |
| Approval (`ui-request`) against a live host that asks a question | Untested end to end — the queue and exactly-once answer are covered by unit tests, but no real host has raised one | Notifications and approval polish deferred by design |
| Single-process launch guard | A second backend on the same machine would need a cross-process lease | Named as a ceiling in the code |
| OMP upstream drift | `collab.*` is not a stability guarantee | `scripts/compat-check.mjs`, recorded baseline, upgrade procedure |

## Round 9 — external audit fixes and acceptance

Final code HEAD `53ef59bc9572d7af100ab565496491032abacf2a`. Hosted CI run #7 completed successfully: every `verify` step passed, including Browser E2E; the manual-only `compat` job was skipped by design.

### Delivered

- Closed A01–A12 from the external audit: process-lineage host identity and strict resume-journal guards; fail-closed overlay and honest startup state; composer error/reconnect/draft fixes; mobile Enter behavior; incremental subagent transcript reads; one-time setup token and reset path; indexed snapshot reduction; pinned manual compatibility workflow; Latest layout geometry. Details and evidence: `docs/audits/round-9-verification.md`.
- Added model catalog API/UI with saved preference distinct from effective model, bounded saved-history API, signed browse pagination, and link capability ceilings.
- Fixed write-token loss before guest `hello`, which made app-managed sessions read-only, and host startup refusal behavior: restore draft/remove optimistic row/show exact host error without automatic resend.

### Verification

| Check | Result |
|---|---|
| `pnpm -r typecheck` | Pass, 8 projects |
| `npx vitest run` | 43 files passed; 426 passed, 8 skipped |
| `TMPDIR=$HOME/.cache npx playwright test --project=chromium --workers=1` | 43/43 passed |
| `node scripts/compat-check.mjs` | 17 ok / 1 warn / 0 fail |
| Real OMP acceptance | 15 PASS / 2 FAIL / 0 SKIP; 30.26 seconds; details and limitations in the audit and acceptance plan |
| Hosted CI | Run #7, SHA `53ef59bc9572d7af100ab565496491032abacf2a`: all `verify` steps passed; `compat` skipped by design |

### Known gaps — round nine

- No join/adoption of a live untracked native session; fail-closed refusal remains.
- Restart/resume is not proven against a real agent: acceptance check10 filled a `<select>` as if it were a text field, so restart action never ran. Current evidence is unit tests only.
- Duplicate-resend risk remains unproven: transcript showed one row but harness found zero `user`-role journal rows because OMP stores the pre-turn prompt under another role.
- `bus`, notice, compaction, and retry frames remain minimally represented.
- Directory paging is not a snapshot; changing contents can duplicate or skip entries between pages.
- Directory creation retains detect-and-refuse TOCTOU limits.
- Physical-iPhone behavior remains unverified.
- Hosted manual compatibility job has never been dispatched.
- A provider key under `~/.omp` appeared once in an agent transcript during this round; owner may wish to rotate it.

The round-8 audit remains committed and unchanged. Round-9 report: `docs/audits/round-9-verification.md`.

## Round 12 — round-10/11 audit findings closed

All six findings from the round-10 and round-11 independent audits closed at commits `b9c633c`/`1fc7700`/`500bc2c`/`efcc857`. Details and evidence: `docs/audits/round-12-verification.md`.

### Verification

| Gate step | Check | Result |
|---|---|---|
| 1 | `pnpm -r typecheck` | Pass, all packages. Verbatim tail available in the gate log. |
| 2 | `npx vitest run --maxWorkers=8 --reporter=dot` | 53 files passed, 2 skipped; 485 tests passed, 8 skipped. |
| 3 | `node scripts/build-guest.mjs` | Pass. |
| 4 | `pnpm --filter @caw/web build` | Pass. |
| 5 | `pnpm --filter @caw/server build` | Pass. |
| 6 | `TMPDIR=$HOME/.cache CAW_E2E_PORT=4489 CAW_RELAY_PORT=8819 npx playwright test --project=chromium --workers=1` | 43 passed (59.9s). |
| 7 | `node scripts/compat-check.mjs` | 17 ok, 1 warn, 0 fail. This followed `fix(scripts): accept tmux no-server connect error in compat probe`; tmux 3.6 wording `error connecting to /tmp/tmux-1000/default (No such file or directory)` was previously a false FAIL. |
| 8 | Real OMP acceptance (harness, all checks) | PASS 38 / FAIL 2 / NOT RUN 2; both FAILs are harness artifacts (check9 composer-wait race after backend restart; check14 selects the Main agent card whose transcript is unreadable) — evidence in the audit report |

### Known gaps

- Real-OMP acceptance ran this round: 38 PASS / 2 FAIL (harness artifacts, not product defects — check9a/check9b backend-restart identity and writer-guard therefore unproven this run; check14 subagent transcript view not exercised). Physical iPhone remains UNVERIFIED. Prior round-9 acceptance: 15 PASS / 2 FAIL.
- Hosted compat job was never dispatched; it remains manual `workflow_dispatch` only.
- Oversized records still use bounded reads (2 MiB window); they are now honestly flagged instead of silently dropped.
- No join/adoption of live untracked session; behavior unchanged.

Round-10/11 audit evidence: `docs/audits/round-12-verification.md`.
