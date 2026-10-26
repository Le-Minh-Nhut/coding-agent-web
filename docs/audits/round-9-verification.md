# Round 9: audit fixes, feature work, and verification

Round 9 addressed the external audit of `5a49b7c` and delivered requested feature work. Final code HEAD: `53ef59bc9572d7af100ab565496491032abacf2a`. Hosted CI run [#7](https://github.com/Le-Minh-Nhut/coding-agent-web/actions/runs/40322743953) completed **success**: every `verify` step passed, including Browser E2E; the `compat` job was skipped by design (manual `workflow_dispatch` only).

## A01–A12 findings

| Finding | Status | Change / files | Evidence and remaining ceiling |
|---|---|---|---|
| A01 — wrong host adopted when two agents share a cwd | **Fixed** | `packages/runtime/src/supervisor.ts`, `packages/omp-adapter/src/tmux.ts`, `packages/omp-adapter/src/types.ts` | Adoption now requires host PID to equal the launched pane PID or be its process descendant, checked by walking `/proc/<pid>/stat`; unavailable identity is `unknown`, never a match. No cwd/highest-PID selection; a known `nativeSessionId` cannot fall back to another session. `tests/runtime/supervisor.test.ts` covers inverted publish/PID order, wrapper lineage, unavailable lineage, and known-session mismatch. Not exercised against a real agent. |
| A02 — restart silently dropped `--resume` | **Fixed** | `apps/server/src/server.ts`, `tests/server/app.test.ts` | `createRuntimeSpec` refuses restart when a known session journal is missing, unreadable, or belongs to another project. Blanket `allowMissingResumeSession` flag removed. Tests cover refusal and valid journal resolution; real-agent restart remains unverified below. |
| A03 — overlay write errors swallowed; unsupported idle state | **Fixed** | `apps/server/src/server.ts`, `packages/runtime/src/supervisor.ts`, `tests/server/app.test.ts`, `tests/runtime/supervisor.test.ts` | Overlay write failure aborts launch; publish timeout remains `starting` or `unknown` with status detail instead of claiming idle without evidence. Fault-injection test proves no launch after overlay failure. |
| A04 — error frame locked composer | **Fixed** | `apps/web/src/transcript.ts`, `apps/web/src/components/ConversationView.tsx`, `tests/web/mobile-reading-ux.test.tsx` | Command errors are distinct from transport status; host message is shown verbatim, next valid state recovers, while `bye`/close remain conservative. |
| A05 — connection continued after unmount | **Fixed** | `apps/web/src/components/ConversationView.tsx`, `tests/web/mobile-reading-ux.test.tsx` | Connection-generation guard spans awaits; replaced sockets close and stale callbacks are ignored. |
| A06 — slow send wiped a newer draft | **Fixed** | `apps/web/src/components/ConversationView.tsx`, `tests/web/app-drafts.test.tsx`, `tests/web/mobile-reading-ux.test.tsx` | Per-send version token and parent draft preserve edits made after send began. |
| A07 — Enter submitted on touch | **Fixed** | `apps/web/src/components/ConversationView.tsx`, `tests/web/mobile-reading-ux.test.tsx` | Coarse-pointer Enter inserts newline; Send submits. Desktop Enter submits, Shift+Enter inserts newline; IME composition guard remains. |
| A08 — subagent transcript read only first chunk | **Fixed** | `apps/web/src/transcript.ts`, `apps/web/src/components/ConversationView.tsx`, `tests/web/transcript.test.ts` | `newSize` is byte cursor, partial JSONL lines carry between reads, shrink resets, polling occurs only while panel is open and timers clear on close. Upstream OMP v18.12.2 contract: [`collab/host.ts:1202-1237`](https://github.com/can1357/oh-my-pi/blob/v18.12.2/packages/coding-agent/src/collab/host.ts#L1202-L1237): 4 MiB cap; EOF reply reports `newSize = stat.size`. |
| A09 — setup token was reusable | **Fixed** | `apps/server/src/auth.ts`, `apps/server/src/app.ts`, `tests/server/auth-routes.test.ts` | One-time pending token; forced password setup centrally permits only `POST /api/auth/set-password`, `POST /api/auth/logout`, and `GET /api/auth/me` (reload recovery). Password change revokes other sessions. Local reset: `pnpm --filter @caw/server exec tsx src/auth.ts reset`. Legacy `{salt,hash}` records remain supported. |
| A10 — quadratic snapshot reduction | **Fixed and measured** | `apps/web/src/transcript.ts`, `tests/web/transcript.test.ts` | On this machine (16 cores, Node `v20.19.5`), output equivalence asserted for message count, order, and entry count. Median before → after: 300 entries, 2.70 → 0.60 ms (4.5×); 1,000, 9.59 → 1.04 ms (9.2×); 5,000, 150.20 → 6.29 ms (23.9×); 20,000, 5,105.65 → 43.94 ms (116×). Temporary benchmark removed. |
| A11 — compatibility workflow untrustworthy | **Fixed; hosted compat not exercised** | `.github/workflows/ci.yml`, `scripts/compat-check.mjs` | Workflow is `workflow_dispatch` only; no schedule and no schedule claim. OMP install is pinned to `v18.12.2`, fails closed, and checks installed version; capability probe runs after install. `hosts=0` remains warn; malformed rows remain fail; self-check remains. Local probe: **17 ok / 1 warn / 0 fail**. Hosted compat job has never been dispatched. |
| A12 — “Latest” overlapped content | **Fixed** | `apps/web/src/components/ConversationView.tsx`, `apps/web/src/styles.css`, `tests/e2e/screens.spec.ts` | Latest control is docked in normal flow, with at least 8 px gap above composer and no transcript intersection; capture spec fails loudly otherwise. Geometry is 74×44 at 375/390/430 px. |

## Two acceptance defects with highest impact

1. Browser discarded collaboration-link write token before sending `hello`; every app-managed session therefore connected read-only and phone could not prompt. Fixed in `apps/web/src/components/ConversationView.tsx`; encrypted-hello tests cover both secret lengths.
2. Socket acceptance did not guarantee host acceptance during startup. Previously the draft cleared and a fabricated user row remained after host refusal. Now the optimistic row is removed, draft restored, exact host message shown, and no automatic resend occurs. Covered by `tests/web/mobile-reading-ux.test.tsx`.

## Feature work

- **Model catalog:** authenticated `GET /api/models` returns `{models, source: "omp"|"unavailable", reason}`. UI disclosure distinguishes preferred-for-next-launch from effective-model-reported-now; free-text custom model IDs remain available. Catalog failure never clears saved preference. Files: `apps/server/src/app.ts`, `apps/server/src/server.ts`, `packages/omp-adapter/src/model-catalog.ts`, `apps/web/src/api.ts`, `apps/web/src/components/ConversationView.tsx`.
- **Read-only history:** `welcome.readOnly` is stored and enforced; banner shown, composer/approval/Stop omitted rather than disabled. Host remains final enforcer. Files: `apps/web/src/transcript.ts`, `apps/web/src/components/ConversationView.tsx`.
- **Saved history:** authenticated `GET /api/conversations/:id/history`, bounded to 500 entries / 2 MiB, refuses live or foreign journals, and reuses transcript renderer. Files: `apps/server/src/app.ts`, `apps/server/src/server.ts`, `packages/omp-adapter/src/session-catalog.ts`, `apps/web/src/components/ConversationView.tsx`.
- **Browse pagination:** `limit`, signed cursor, and `hasMore`; cursor bound to canonical directory; forged cursors refused. Files: `apps/server/src/path-policy.ts`, `apps/server/src/app.ts`, `apps/web/src/components/FolderBrowser.tsx`.
- **Link capability ceiling:** view-only host cannot be upgraded; minted link access must equal host grant. Files: `packages/omp-adapter/src/collab-registry.ts`, `apps/server/src/server.ts`.

## Round-8 findings superseded

- `welcome.readOnly` is stored and enforced: `apps/web/src/transcript.ts:486`, `apps/web/src/components/ConversationView.tsx:433,519,532,888,902`.
- Displayed custom entries, compaction, branch summary, model-change, thinking-level, and developer messages are rendered: `apps/web/src/transcript.ts:148-215`.
- Snapshot reduction is indexed and measured: `apps/web/src/transcript.ts:248-297`.
- Prompt-idempotency documentation claims were corrected before this round; no wire-level idempotency key is claimed.

The round-8 audit remains byte-identical to its committed version. Rewritten variant is preserved outside the repository at `$HOME/.cache/caw-round9/round8-audit-revised.md`.

## Real-OMP acceptance

Real OMP `18.12.2`, isolated scratch profile, **15 PASS / 2 FAIL / 0 SKIP** in **30.26 s**. Harness command:

```sh
node scripts/acceptance-ui-drives-agent.mjs --base http://127.0.0.1:8801 --tmp $HOME/.cache/caw-acc-final2 --root $HOME/.cache/caw-acc-final2/roots --password 'a-12-character-secret' --only check1,check2,check4,check5,check7,check9,check10
```

Isolation used its own `HOME`, `PI_CODING_AGENT_DIR`, `XDG_STATE_HOME`, and private state/session directories; copied `config.yml`, `models.yml`, and `agent.db` into scratch. No owner session or profile was used as the run target. Recorded tmux sessions and OMP PIDs exited, owner's process count was unchanged (4 before/after), and scratch was deleted.

Verbatim acceptance evidence:

```text
PASS provider database copied to scratch without logging secrets — /home/heheboiz/.cache/caw-acc-final2/omp-agent/agent.db (mode 0600)
PASS login through the UI (seeded password) lands on the projects screen — url=http://127.0.0.1:8801/
PASS project created from a folder typed in the UI — id=bd057638-2c4b-42b9-b158-0b1d8d31db7c; folderText="📁 proj-caw-acc-a42aa1\nSELECTED" browserSelectedPath=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 UI-selected-path=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 UI-card-visible=true API-status=200 API-project-path=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 API-projects=Acceptance CAW-ACC-a42aa1: /home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1
PASS project path matches selected folder and typed folder — selected=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 API=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1
PASS chat launch published tmux, native-session, and host identity — state=idle tmux=$0 native=01a17839-0c0c-7386-afa6-8b504bfa5aaa host=ccec7024375c6dab
PASS tmux pane cwd equals the project path — pane_current_path=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1
PASS user echo appears exactly once in transcript — marker=CAW-ACC-a42aa1-4 attempts=1 startupRefusals=0
PASS a real assistant reply follows the prompt — CAW-ACC-a42aa1-4 ACK
PASS journal on disk contains the prompt marker — native=01a17839-0c0c-7386-afa6-8b504bfa5aaa path=/home/heheboiz/.cache/caw-acc-final2/omp-agent/sessions/-tmp-roots-proj-caw-acc-a42aa1/2026-10-26T12-39-26-988Z_01a17839-0c0c-7386-afa6-8b504bfa5aaa.jsonl
PASS journal contains the assistant reply text — needle=CAW-ACC-a42aa1-4 ACK
PASS draft typed after sending survives — value="CAW-ACC-a42aa1-5draft"
PASS both sent markers reached the host journal — CAW-ACC-a42aa1-5a + CAW-ACC-a42aa1-5b
PASS history restored exactly once after leaving and returning — user rows containing marker=1
FAIL nothing was silently resent (one user journal row) — user journal rows containing marker=0
PASS identity survives a backend restart — native=01a17839-0c0c-7386-afa6-8b504bfa5aaa tmux=$0 state=idle
PASS no second writer appeared — private tmux sessions 1→1, lease sockets 13→13
FAIL check10 ran to completion — locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element Call log: - waiting for locator('#<redacted>

The harness reports the two failures exactly; check7b’s journal-role count was `0`, while the returned transcript contains one matching row. Check10’s code calls `fill()` on `#conversation-model` before the “Save & restart agent” click; the locator error therefore occurred **before touching restart**. Agent restart/resume was not exercised.

Local Chromium verification for A12 measured Latest at 74×44 px at 375, 390, and 430 px viewports. It remains in normal document flow with the required 8 px composer gap and no transcript overlap.

The protected round-8 audit is byte-identical to its committed version; only `round-8-mobile-reading-ux.md` remains modified in `docs/audits/`.

## Known gaps after round 9

- No join of a live untracked session.
- Restart/resume unproven against a real agent; acceptance check10 did not execute.
- Duplicate-resend check is unmeasurable as written; risk remains unproven.
- `bus`, notice, compaction, and retry frames remain minimally represented.
- Directory pagination is not a snapshot: a changing directory can duplicate or skip rows between pages.
- Directory-creation TOCTOU remains detect-and-refuse, not atomically closed.
- Physical-iPhone behavior remains unverified.
- Hosted compat job was never dispatched.
- A provider key under `~/.omp` was surfaced once in an agent transcript during this round; owner may wish to rotate it.
