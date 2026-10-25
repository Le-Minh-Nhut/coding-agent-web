# Round 3 post-fix verification

**Verdict.** Three of ten claims are genuinely closed: SEC-1, SEC-3, and the reported reconnect-loop cause. Six are partial; SEC-2 is **NOT FIXED** for documented deployment. Most serious remaining hole is SEC-2: Tailscale Serve proxies remote WebSocket upgrades to loopback listener, while `authorizeHost` trusts every loopback peer before checking cookies. A remote caller can claim `role=host` and appear loopback under documented deployment; live Serve not exercised, so proxy behavior remains **UNVERIFIED**. ARCH-1 also has a reproducible same-journal double launch through supervisor API when one conversation has null native ID; whether supported HTTP flow can reach that combination is **UNVERIFIED**. Additional reproductions: ARCH-2 false-stopped report, ARCH-5 failed-observation confidence, and live-slot cap overflow.

Scope: source and tests cited below; focused command listed under “What I ran.” No repository source, test, or config files changed. Throwaway reproductions are under `/tmp`.

## 1. ARCH-1 — duplicate-writer race

**Claim:** serialized launch guard and keyed reservations prevent two writers for one native session and reserve `maxActive`.

**What code does:** `packages/runtime/src/supervisor.ts:82-97` serializes the critical section. `:278-287` keys reservations by known native ID, otherwise conversation ID. Reservation remains held through `waitForPublish()` at `:353-356`; outer `finally` releases it on normal return, publish-timeout return, or thrown wait. Errors inside lock callback release via inner catch at `:347-351`. Count/cap decision is serialized at `:294-327`; launch metadata is persisted before callback releases lock at `:333-346`. Lock is local to this backend process; comment `:77-80` says another backend process needs cross-process lease.

**What I tried:** throwaway two-start probe used one conversation with `nativeSessionId=null`, another with same native ID, both resuming same journal path. Command: `pnpm exec esbuild /tmp/caw-audit-reservation-keys.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-reservation-keys.mjs && node /tmp/caw-audit-reservation-keys.mjs`. Output: `{"launches":["unknown-id","known-id"],"bothResumeSamePath":true,"tmuxSessions":2}`. First key is `conversation:unknown-id`, second `session:same-native-session`; lease probes happen before lock (`:272-275`), so second can reuse earlier false after first launch. Live-owner scan compares stored native IDs (`:304-311`) and cannot match null to known ID. With maxActive 3 both launch. This exercises the public supervisor interface, but not HTTP route: current `apps/server/src/app.ts:220-223` stores `resumeSessionId` on the new conversation before `start()`, and `createRuntimeSpec()` only returns a resume path when given that ID (`apps/server/src/server.ts:65-76`). Reachability of the null-ID/same-journal combination through supported API is therefore **UNVERIFIED**.

Injected `updateConversation()` failure after adapter launch. Command: `pnpm exec esbuild /tmp/caw-audit-reservation.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-reservation.mjs && node /tmp/caw-audit-reservation.mjs`. Output: `first start rejected: simulated store write failure after tmux launch` and `{"launches":2,"liveTmuxSessions":2,"persistedTmuxId":"$2"}`. Inner catch releases reservation while first process survives unrecorded; retry launches another.

I also held first request inside publish wait, started a second same-native-session conversation, then released the first. Command: `pnpm exec esbuild /tmp/caw-audit-reservation-wait.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-reservation-wait.mjs && node /tmp/caw-audit-reservation-wait.mjs`. Output: `{"launches":1,"secondResult":"conflict_owner","firstPublishWasBlocked":true}`. This confirms reservation is held through the publish wait for same-key launches.

**Result: PARTIALLY FIXED.** Reservation covers ordinary same-key launch through publication wait and all observed exits. It misses unresolved-ID aliases and post-launch persistence failure; first case reproduces two writers. Another backend process is outside lock.

**What remains:** reserve by resolved resume/session identity, recheck lease inside critical section, preserve/clean ownership when recording launched process fails. Tests `tests/runtime/supervisor.test.ts:145-181` use known IDs or different known IDs, not null/known alias; both set `publishTimeoutMs:0`.

## 2. ARCH-2 — tmux ID reuse

**Claim:** recorded `$N` actionable only if recorded tmux server identity matches.

**What code does:** private socket configured in `apps/server/src/server.ts:166-167`; adapter captures identity in `packages/omp-adapter/src/tmux.ts:53-60,68-89`. `findManagedTmux()` requires stored identity and matches ID/name plus identity in `packages/runtime/src/supervisor.ts:182-190`; refresh uses it via observations (`:128-173,198-215`), adopt uses it (`:219-245`), reconcile checks mismatch before adoption (`:515-539`). `stop()` refuses null/mismatch (`:458-470`); adapter rechecks expected identity and server start time/pid before kill (`packages/omp-adapter/src/tmux.ts:185-203`). Null recorded identity is not adopted and `stop()` refuses it; reconcile marks unverifiable reference unknown (`supervisor.ts:182-185,461-467,525-539`).

**Bypasses:** attach endpoints `apps/server/src/app.ts:303-309,311-320` return `tmux attach -t '$N'` whenever ownership is managed and ID exists, without identity check. Command omits private socket and targets default tmux server; reused ID can attach stranger. `stop()` pre-kill checks identity, but post-kill poll calls `getTmux(recordedId)` and trusts only absent/alive (`supervisor.ts:474-482`); it does not compare returned identity. Reproduced false “stopped”: throwaway adapter changed to new server with `alive=false` stranger at same `$0` after guarded kill. Command: `pnpm exec esbuild /tmp/caw-audit-stop-reuse.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-stop-reuse.mjs && node /tmp/caw-audit-stop-reuse.mjs`. Output: `{"currentIdentity":"new:2:2","returnedState":"stopped","observedStrangerAlive":false,"observedServerIdentity":"new:2:2"}`. No stranger was killed, but state attributes stranger's ID to old process. `observationsFor()` maps identity-probe errors to null (`:130-145`); with stored non-null identity, null is not ownership-unknown (`:168-173`), conflating failure and confirmed server-down.

**What I tried:** focused runtime/adapter tests passed. `tests/runtime/supervisor.test.ts:458-466,574-585` checks mismatch for stop/reconcile; `tests/adapter/tmux.test.ts:78-95` restarts isolated tmux and old expected identity cannot kill replacement. Attach command not executed.

**Result: PARTIALLY FIXED.** Core lookup/adopt/kill path checks identity. Attach bypasses it; stop post-kill poll trusts reused ID and falsely reports stopped, reproduced. Identity-probe failure may be treated as absence.

**What remains:** attach must require matching identity and use private socket; compare `getTmux()` identity in stop polling; distinguish identity probe failure from confirmed server shutdown.

## 3. ARCH-3 — link crossing session switch

**Claim:** returned generation/instance must equal selected registry row.

**What code does:** `apps/server/src/server.ts:101-126` lists host by conversation native ID, mints against selected instance, compares both fields and throws stale generation on mismatch. `apps/server/src/app.ts:290-300` returns 409 without URL. Tests `tests/server/conversation-link.test.ts:130-186` separately check generation and instance mismatch.

**What I tried:** actual adapter with `/tmp/caw-omp-stub` returned URL only, omitting `instanceId`/`generation`. Command: `pnpm exec esbuild /tmp/caw-audit-link-default.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-link-default.mjs && node /tmp/caw-audit-link-default.mjs`. Output (credential redacted): `{"returned":{"instanceId":"old-instance","generation":1,"url":"[redacted]"},"observed":{"instanceId":"old-instance","generation":1},"wouldPassCreateMintLinkGuard":true}`. `packages/omp-adapter/src/collab-registry.ts:172-179` fabricates requested ID and generation 1 when response omits fields; a successor room could pass at observed generation 1. Probe exercised defaults and guard condition, not mounted HTTP route.

**Result: PARTIALLY FIXED.** Mismatched present values are refused; missing identity evidence becomes matching-looking values in adapter.

**What remains:** missing/malformed identity and generation must fail closed. Supported OMP guarantee to always return both is **UNVERIFIED**; adapter accepts omission.

## 4. ARCH-4 — unknown busy signal rendered idle

**Claim:** only false means idle; null/absent means unknown.

**What code does:** runtime `hostState()` accepts exactly true/false (`packages/runtime/src/state.ts:27-30`); managed evaluation returns unknown for nonboolean busy (`:106-111`). Tests cover null/absent at `tests/runtime/state.test.ts:54-70`.

**Bypass:** web UI consumes Collab frames separately. `apps/web/src/components/ConversationView.tsx:84-93` maps welcome and state as `busy ? running : idle`; idle banner appears at `:446-449`. Shared protocol permits absent busy (`packages/collab-protocol/src/types.ts:169-175`); absent displays “Connected — no turn in flight.” Ran `node -e 'for (const busy of [undefined, null, false, true]) console.log(JSON.stringify({busy, rendered: busy ? "running" : "idle"}))'`; output confirms undefined/null/false render idle.

**Result: PARTIALLY FIXED.** Runtime fixed; web frame handler still renders unknown as idle.

**What remains:** map true/running, false/idle, absent/null/unknown explicitly; test old-host frame in UI.

## 5. ARCH-5 — failed observations become negative/confident states

**Claim:** unknown lease, registry read failures, and catalog unknown remain unknown, not stopped/error/false.

**What code does:** evaluator keeps lease non-false unknown before stopped/error (`packages/runtime/src/state.ts:63-91,129-164`) and unreadable registry unknown (`:44-50`). `observationsFor()` preserves registry failure (`packages/runtime/src/supervisor.ts:130-155`); reconcile handles unreadable registry unknown if no managed tmux (`:571-599`). `SessionLeaseProbe` retains tri-state unknown (`packages/omp-adapter/src/session-lease.ts:126-159`), catalog forwards it (`packages/omp-adapter/src/session-catalog.ts:169,227`), API preserves it (`apps/server/src/server.ts:306-314`). Start refuses unreadable registry (`supervisor.ts:289-291`).

**Reproductions / gaps:** `observationsFor()` catches `sessionPathExists()` exceptions into false (`supervisor.ts:139-143`), which evaluator writes as error when lease is free and native session exists (`state.ts:76-83,142-149`). Injected EACCES via throwaway adapter. Command: `pnpm exec esbuild /tmp/caw-audit-failed-history.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-failed-history.mjs && node /tmp/caw-audit-failed-history.mjs`. Output: `{"sessionPathObservation":"EACCES","persistedState":"error","detail":"The agent process is gone and its recorded session file could not be found."}`. `listManagedTmux()` failures caught as empty (`supervisor.ts:130-132,255-258`); matching server identity and free lease can make refresh/reconcile infer stopped/error despite process-list failure. Catalog directory read errors in `listForCwd()` return empty (`packages/omp-adapter/src/session-catalog.ts:151-156`), though per-row liveness is tri-state.

**What I tried:** `tests/runtime/state.test.ts:91-104,124-128` covers unknown lease/unreadable registry. Did not test catalog directory scan failure; failed journal-stat probe reproduced above.

**Result: PARTIALLY FIXED.** Explicit unknown lease/registry paths fixed; filesystem and tmux observation failures still collapse into negative observations.

**What remains:** preserve errors separately from false/empty in path, tmux and catalog discovery; persist stopped/error only after confirmed negative.

## 6. SEC-1 — bearer link in URL/history

**Claim:** guest no longer writes bearer link into URL/history and clears initial fragment.

**What code does:** `packages/guest/src/app.tsx:44-69` keeps link in ref and replaces URL with pathname+search after client construction/connect; leave clears fragment at `:71-81`. No `location.hash` write exists. Built bundle test asserts no hash assignment and presence of `replaceState` (`tests/guest/static-assertions.test.ts:86-97`).

**What I tried:** focused guest static test passed. Valid link remains in initial fragment until connect runs, then current history entry is replaced. Did not inspect browser back/forward restoration.

**Result: VERIFIED FIXED** for reported location-hash write/history-entry bug. Browser restoration/back-forward behavior **UNVERIFIED**.

**What remains:** static assertion does not inspect history state or alternative history APIs.

## 7. SEC-2 — unauthenticated relay host role

**Claim:** `authorizeHost`, room cap, and upgrade rate limit close unauthenticated/uncapped `role=host`.

**What code does:** `apps/server/src/server.ts:336-347` immediately authorizes `isLoopbackAddress(req.socket.remoteAddress)`; only non-loopback peers need session cookie. Relay invokes callback (`packages/relay/src/relay.ts:467-483`), caps rooms (`:485-489,315-318`), and limits upgrades (`:420-439`). Product defaults server to `127.0.0.1` (`apps/server/src/config.ts:7-15`). Intended deployment uses Tailscale Serve proxy to `http://127.0.0.1:8791` (`docs/adr/0002-private-relay-and-remote-access.md:22-25`, `docs/operations/iphone-setup.md:22-27`); security model says Serve proxies to loopback (`docs/architecture/security-model.md:34-35`), and security considerations explicitly state backend sees loopback behind Serve (`docs/research/security-considerations.md:75-76`).

**What I tried:** focused relay/server tests passed. `tests/server/relay-auth.test.ts:88-116` verifies direct loopback no-cookie accepted and simulated non-loopback refused; no proxy. Remote client cannot forge its TCP source as loopback, but Serve creates backend loopback connection on behalf of remote requests. **[INFERENCE]** Under documented topology, remote `role=host` WebSocket through Serve is seen as loopback and takes exemption. With the configured exact Serve origin (`docs/operations/ubuntu-setup.md:49-59`), a browser can request a same-origin host WebSocket; a native client can also supply an Origin header or omit it, since Origin is not credentials and absent Origin is allowed (`packages/relay/src/relay.ts:441-448`). Any local process can connect directly. Code does not authenticate OMP client before loopback return. Main web UI itself opens `role=guest` (`apps/web/src/components/ConversationView.tsx:270-274`), not host; risk is a reachable client choosing host role. Room cap/rate limit constrain resources, not authorization.

**Result: NOT FIXED** for documented remote-access topology: loopback exemption trusts reverse-proxied remote host requests. Live Serve reproduction **UNVERIFIED**; code and documented proxy target establish bypass mechanism.

**What remains:** distinguish trusted local OMP host from reverse-proxied remote request; authenticate host independently of loopback address. Do not trust forwarded headers unless bound to trusted proxy.

## 8. SEC-3 — reachable view-only link

**Claim:** `POST /api/conversations/:id/link?access=view` reaches registry with view access.

**What code does:** route validates access and calls `mintLink(conversation, query.data.access)` (`apps/server/src/app.ts:278-289`); helper forwards view (`apps/server/src/server.ts:97,106`); adapter appends `--view` (`packages/omp-adapter/src/collab-registry.ts:142-147`).

**What I tried:** route test passed; `tests/server/conversation-link.test.ts:76-95` verifies callback receives view and response says view. Test stubs callback; adapter/OMP are not invoked.

**Result: VERIFIED FIXED** for route reachability and forwarding; source adapter has expected `--view` branch. Real OMP view-link generation **UNVERIFIED**.

**What remains:** no real OMP run; no code gap found in requested route.

## 9. Live tmux slot accounting

**Claim:** count live tmux sessions so exited processes free slots and concurrent launches cannot exceed cap.

**What code does:** `activeCount()` and `start()`'s `liveOwners` require both `isActive()` stored state and live tmux ID (`packages/runtime/src/supervisor.ts:117-119,254-265,300-308`). Confirmed live process in stored `unknown` is omitted. Known active rows with absent IDs are not counted: `isActive()` excludes `starting` without ID, so trailing starting/no-ID OR branch is ineffective; avoids treating every never-launched default `starting` row as occupied.

**What I tried:** one live managed tmux session belonged to stored `unknown` conversation; target start at maxActive 1. Command: `pnpm exec esbuild /tmp/caw-audit-slots.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-slots.mjs && node /tmp/caw-audit-slots.mjs`. Output: `{"activeBefore":0,"existingKnownNativeSession":true,"existingTmuxAlive":true,"existingState":"unknown","launches":1,"rejected":null}`. One existing plus one new session exceeds cap. Stale running row with absent tmux is freed by `tests/runtime/supervisor.test.ts:286-299`.

I also made second serialized launch's `listManagedTmux()` throw once, then succeed: no existing owners counted, maxActive 1 admitted both concurrent requests. Command: `pnpm exec esbuild /tmp/caw-audit-cap-failure.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-cap-failure.mjs && node /tmp/caw-audit-cap-failure.mjs`. Output: `{"maxActive":1,"tmuxListCalls":2,"launches":2,"liveSessions":2,"rejected":0}`. This confirms caught list failure is treated as zero active agents. Normal concurrent-launch test `tests/runtime/supervisor.test.ts:169-181` covers healthy list observations only.

**Result: PARTIALLY FIXED.** Dead-process wedge fixed; live process in unknown state or failed tmux observation is omitted, cap can be exceeded.

**What remains:** count confirmed-live managed sessions independent of display state; fail closed/unknown when tmux enumeration fails; test unknown-state/list-failure cap cases.

## 10. Reconnect loop — ref-based handler

**Claim:** frame handler ref makes connection effect depend only on conversation ID.

**What code does:** handler uses `[agents]` (`apps/web/src/components/ConversationView.tsx:84-234`); ref updates separately at `:236-240`; socket uses current ref at `:286-288`. `connectToCollab` captures only `conversationId` and has `[conversationId]` dependencies (`:243-299`); effect uses `[connectToCollab]` (`:301-311`). State setters, refs, imported API/helpers do not change callback identity. Retry uses same callback (`:431`).

**What I tried:** dependency graph inspection; focused Vitest omitted Playwright socket-count E2E. Source removes reported state-handler dependency. Pending API/key import has no cancellation guard; late response after unmount/ID switch can create stale socket, distinct from render-driven reconnect loop. React StrictMode can setup/cleanup twice in dev, not repeatedly per render.

**Result: VERIFIED FIXED** for reported render-driven hot loop by dependency graph. Dynamic socket-count confirmation **UNVERIFIED**.

**What remains:** ignore/cancel late async result after unmount/ID switch; no inspected dependency reruns connection effect when frame handler changes.

## Non-falsifiable test coverage (for claims under review)

“Non-falsifiable” means test does not fail for relevant broken implementation; mutation experiments **not run**, each **UNVERIFIED**.

- `tests/runtime/supervisor.test.ts:145-181`: known IDs only; does not falsify mixed null/known alias. Mutation: key always `conversation:${conversationId}`; tested same-known-ID case still rejects via live-owner row, different-session cap still serializes. **UNVERIFIED** mutation.
- Same tests use `publishTimeoutMs:0`; do not prove reservation spans publish wait. Mutation: release after serialized section; persisted live row/count can still block tested attempts. **UNVERIFIED** mutation.
- `tests/server/conversation-link.test.ts:130-186`: fake mintLink bypasses adapter parser. **UNVERIFIED** mutation removing missing-field defaults.
- `tests/runtime/state.test.ts:54-70`: pure runtime evaluator only. Restoring `busy ? running : idle` in web handler leaves tests green. **UNVERIFIED** mutation.
- `tests/server/conversation-link.test.ts:76-95`: callback stub. Removing adapter `args.push("--view")` leaves route test green. **UNVERIFIED** mutation.
- `tests/guest/static-assertions.test.ts:86-97`: checks hash assignment absence and replaceState presence, not history. Adding `history.pushState(null, "", "#" + link)` leaves assertions green. **UNVERIFIED** mutation.
- `tests/runtime/supervisor.test.ts:561-572`: asserts only state is not stopped; wrong confident `error` passes. **UNVERIFIED** mutation.
- `tests/server/relay-auth.test.ts:88-116`: direct loopback plus simulated remote override, not Serve proxy. Cannot distinguish remote caller from Serve loopback backend peer. **UNVERIFIED** proxy test.

## UNVERIFIED

- Live Tailscale Serve/tailnet proxy not exercised; SEC-2 inference from documented topology plus unconditional loopback authorization.
- No Playwright socket-count E2E rerun after handler ref fix.
- No real OMP view-only link run; route uses stub.
- No browser back/forward/history-state inspection for SEC-1; static assertion passed.
- No actual API-generated attach command test after tmux restart.
- Stop ID-reuse false-stopped result reproduced with throwaway adapter, not real server restart during stop.
- OMP guarantee that link JSON always carries instance ID/generation not re-fetched/tested; omission accepted by adapter.
- Mutation experiments above not run; tests inspected, not mutated.

## What I ran

Focused command:

```text
pnpm exec vitest run tests/runtime/supervisor.test.ts tests/runtime/state.test.ts tests/server/conversation-link.test.ts tests/server/relay-auth.test.ts tests/relay/relay.test.ts tests/adapter/tmux.test.ts tests/guest/static-assertions.test.ts
```

Observed: `Test Files 7 passed (7); Tests 98 passed (98); Duration 1.43s`. Fastify emitted `FSTDEP023` deprecation warnings.

Throwaway reproduction commands run:

```text
pnpm exec esbuild /tmp/caw-audit-reservation-keys.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-reservation-keys.mjs && node /tmp/caw-audit-reservation-keys.mjs
pnpm exec esbuild /tmp/caw-audit-reservation.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-reservation.mjs && node /tmp/caw-audit-reservation.mjs
pnpm exec esbuild /tmp/caw-audit-reservation-wait.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-reservation-wait.mjs && node /tmp/caw-audit-reservation-wait.mjs
pnpm exec esbuild /tmp/caw-audit-link-default.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-link-default.mjs && node /tmp/caw-audit-link-default.mjs
pnpm exec esbuild /tmp/caw-audit-failed-history.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-failed-history.mjs && node /tmp/caw-audit-failed-history.mjs
pnpm exec esbuild /tmp/caw-audit-slots.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-slots.mjs && node /tmp/caw-audit-slots.mjs
pnpm exec esbuild /tmp/caw-audit-cap-failure.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-cap-failure.mjs && node /tmp/caw-audit-cap-failure.mjs
pnpm exec esbuild /tmp/caw-audit-stop-reuse.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-audit-stop-reuse.mjs && node /tmp/caw-audit-stop-reuse.mjs
node -e 'for (const busy of [undefined, null, false, true]) console.log(JSON.stringify({busy, rendered: busy ? "running" : "idle"}))'
```

Reproduction outputs appear inline under their findings.