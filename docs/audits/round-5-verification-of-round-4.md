# Round 5 verification of Round 4 fixes

**Verdict.** Four of seven fixes genuinely closed; three partially fixed; none gets a false clean bill. §4/§5's permission-denied enumeration now refuses launch; sequential same-journal retry is blocked; omitted host generation refuses mint; and SEC-2's listener topology works in production wiring with residual documented honestly. §1's guarded kill and same-process retry safeguards work, but backend restart erases the retained reservation: after failed store write and failed kill, real live tmux sessions reached three with `maxActive: 2`. §2 still reports `stopped` for dead stranger reissued at `$0` if tmux restarts between its identity and session probes. §7 still accepts an outer query on a deep link. **Most serious remaining hole: the restart-time cap overrun leaves an untracked live writer and permits a duplicate launch.**

All repro scripts were throwaways under `/tmp` and wrote no repository source, tests, or config. Real tmux scripts used temporary sockets under `$HOME/.cache`, terminated only servers they created, and removed their temporary dirs. The only repository write is this report.

## 1. §4/§5 classifier — permission denial is not server absence

**Claim.** Tmux enumeration permission errors are failed probes, so launch refuses and cannot treat an inaccessible server as idle.

**What code does.** `packages/omp-adapter/src/tmux.ts:8-10,32-35` classifies only explicit no-server/no-socket diagnostics as absence and excludes permission patterns. `:127-139` returns empty only for confirmed no-server and otherwise throws. `packages/runtime/src/supervisor.ts:311-329,399-417` propagates unknown enumeration and refuses launch.

**What I tried.**
- `npx vitest run tests/runtime/supervisor.test.ts tests/adapter/tmux-probe.test.ts tests/adapter/collab-registry.test.ts tests/server/link-rewrite.test.ts tests/server/relay-auth.test.ts tests/server/config.test.ts` — six files, 87 tests passed. Permission binary fixture emits `error connecting ... (Permission denied)` and asserts probe failures at `tests/adapter/tmux-probe.test.ts:58-72`; launch refusal is asserted at `tests/runtime/supervisor.test.ts:449-463`.
- `pnpm exec tsx /tmp/caw-r5-permission-enumeration.mts` — wired `DefaultTmuxService` behind supervisor `listManagedTmux`, injected CLI executable emits permission denied. Output: `{"refusal":"conflict_limit","launchCalls":0}`.

**Result: VERIFIED FIXED.** Real adapter classifier plus runtime refuses before `launch()` on injected permission denial. Error injection used the fake CLI executable, not a kernel ACL failure.

**What remains.** Did not repeat a real private-socket permission failure or cover every tmux version's diagnostic strings.

## 2. §1 guarded kill — failed persistence, surviving process, and cap

**Claim.** Guarded kill rejects until removal is proved; failed persistence does not record `stopped` or permit a retry to fork a surviving process; `maxActive: 2` remains intact after the audit's store-write-failure → retry sequence.

**What code does.** `packages/omp-adapter/src/tmux.ts:252-304` validates `$N` and expected server identity, throws on failed kill/probe or a surviving live session, and resolves only after the old server disappears or the matching session is absent/dead. `packages/runtime/src/supervisor.ts:431-468` handles failed cleanup without setting `stopped`, retains launch ownership, and `:481-487` releases keys only if ownership was not retained. Retention is process-local (`:85-95`). Slot count at `:311-329,376-417` recognizes recorded live IDs and reservations, not an untracked tmux process after restart.

**What I tried.**
- `npx vitest run tests/runtime/supervisor.test.ts tests/adapter/tmux-probe.test.ts tests/adapter/collab-registry.test.ts tests/server/link-rewrite.test.ts tests/server/relay-auth.test.ts tests/server/config.test.ts` — in same-process fixture, adapter rejects kill failure while `$0` survives (`tests/adapter/tmux-probe.test.ts:89-105`); supervisor test injects write + kill failures, then retry and third launch (`tests/runtime/supervisor.test.ts:228-250`).
- `pnpm exec tsx /tmp/caw-r5-real-tmux-cap.mts` — real tmux on a unique private socket; metadata write failed; wrapper failed guarded `if-shell` kill while preserving a live tmux process; same-process retry, then simulated backend restart with new store/supervisor, retry and another conversation. Latest output: `{"survivorsAfterFailedCompensation":1,"c1StateAfterFailure":"starting","sameProcessRetry":"conflict_owner","liveAfterRestartRetryAndC2":3,"thirdAfterRestart":"conflict_limit","maxActive":2}`. Separate same-process run using this script earlier output `{"survivorsAfterFailedCompensation":1,"c1StateAfterFailure":"starting","sameProcessRetry":"conflict_owner","sameProcessThird":"conflict_limit","liveAfterSameProcessChain":2,"maxActive":2,"c1RetryAfterRestart":"allowed","liveAfterRestartRetry":3}`. Cleanup killed only captured session IDs and its private tmux server.

**Result: PARTIALLY FIXED.** Failed kill does throw; the failed write's row did not become `stopped` (fallback store write also failed, leaving `starting`); same-process retry gets `conflict_owner`, and same-process third launch gets `conflict_limit`. But a new supervisor/store loses reservation and cannot count the first still-live `$0`: retry plus one new conversation produced three real live sessions at cap 2. This reproduces the round-4 cap overrun after restart, now due to volatile ownership rather than kill falsely resolving.

**What remains.** Persist/recover identity of launches whose metadata update failed, or refuse new launches until orphan ownership/count can be re-established. New retry records `$1`; first `$0` remains live and untracked. Existing tests do not cover new-supervisor recovery with a surviving real process.

## 3. §2 stop poll — reused ID and confirmed absence

**Claim.** Stop must not report completion from a stranger's dead session at reused `$N` after server restart; confirmed absence on the original server still settles `stopped`.

**What code does.** `packages/runtime/src/supervisor.ts:621-657` checks identity, gets `$N`, compares returned row identity before reading `alive`, then rechecks server identity. `:639` explicitly documents remaining window: separate commands leave an inter-read race. Mismatch after probe at `:643-650` treats original server disappearance as stop proof.

**What I tried.**
- `pnpm exec tsx /tmp/caw-r5-real-stop-restarted-dead.mts` — real tmux/private socket. Wrapper counted identity reads, restarted tmux during guarded kill, and created a dead `remain-on-exit` stranger at reissued `$0`. Output: `{"restartDuringGuardedKill":true,"originalId":"$0","replacementId":"$0","strangerAtSameId":true,"strangerAlive":false,"strangerIdentityDiffers":true,"serverIdentityChanged":true,"resultState":"stopped","stoppedEvent":true}`. Stop took the changed-server branch and reported stopped despite stranger occupying the reused ID. This violates the requested outcome; it is not evidence that the poll interpreted the stranger row as the original process.
- `pnpm exec tsx /tmp/caw-r5-real-stop-absent.mts` — real tmux, keeper keeps same server alive; `$0` absent before stop, guarded kill verifies absence. Output: `{"originalConfirmedAbsentOnSameServer":true,"identityUnchanged":true,"state":"stopped","stoppedEvent":true}`.

**Result: PARTIALLY FIXED.** Already-observed different-identity stranger is refused (`tests/runtime/supervisor.test.ts:645-670`); same-server absence remains stopped (`:672-681`). But the task's restarted-server sequence still reports `stopped`: after guarded kill, a changed `tmuxServerIdentity` immediately triggers `agent.stopped` with `proof: "tmux_server_gone"` (`packages/runtime/src/supervisor.ts:621-635`), while real tmux had reissued `$0` to a dead stranger. This path does not interpret stranger row, but it violates explicit requirement not to report stopped for the restarted-server case.

**What remains.** The identity-before-session guard fixes stale returned rows only when poll reaches `getTmux`; the earlier changed-server branch still calls server disappearance proof sufficient for `stopped`. Under the requested acceptance rule, treat restarted server/ID reuse as unverified and do not report stopped. Existing dead-stranger unit test does not catch this branch.

## 4. §1 sequential same-journal resume

**Claim.** After a first launch times out before publishing, another conversation resuming the same journal gets `conflict_owner` instead of launching a second writer.

**What code does.** `reserveKeys()` reserves `journal:<resumeSessionPath>` (`packages/runtime/src/supervisor.ts:110-121`). After publish timeout, `waitForPublish()` stores `nativeSessionPath` (`:574-583`). Subsequent start compares resume path against live owners (`:385-396`) and records refusal rather than launching.

**What I tried.**
- `pnpm exec tsx /tmp/caw-r5-sequential-journal.mts` — conversation one launched and timed out with no host; conversation two named same journal. Output: `{"firstState":"idle","hostRows":0,"firstPathRecorded":true,"secondLaunchResult":"conflict_owner","launchCalls":1,"liveSessions":1}`.
- `npx vitest run tests/runtime/supervisor.test.ts tests/adapter/tmux-probe.test.ts tests/adapter/collab-registry.test.ts tests/server/link-rewrite.test.ts tests/server/relay-auth.test.ts tests/server/config.test.ts` — regression fixtures at `tests/runtime/supervisor.test.ts:252-277` assert stored resume path and sequential refusal.

**Result: VERIFIED FIXED.** First launch has no host row; path is recorded at timeout, and second launch is refused before `launch()` (`launchCalls:1`).

**What remains.** Repro uses adapter/store fakes, not real OMP journal publication; it does exercise supervisor state and exact audit sequence.

## 5. §3 host-list generation evidence

**Claim.** CLI row omitting `generation` remains unknown; mint refuses without issuing `omp collab link`.

**What code does.** `packages/omp-adapter/src/collab-registry.ts:25-26,37-74` maps absent/nonfinite generation to `null`. `apps/server/src/server.ts:231-245` throws `StaleGenerationError` before link invocation when host generation is null, and rejects mismatched link identity/generation. Actual adapter also filters null generations at `:317-332`.

**What I tried.**
- `npx vitest run tests/runtime/supervisor.test.ts tests/adapter/tmux-probe.test.ts tests/adapter/collab-registry.test.ts tests/server/link-rewrite.test.ts tests/server/relay-auth.test.ts tests/server/config.test.ts` — six files, 87 tests passed; CLI service omission fixture at `tests/adapter/collab-registry.test.ts:219-253`; missing/mismatched link evidence fixture at `tests/server/conversation-link.test.ts:128-200` is not in this focused command, source inspected.
- `pnpm exec tsx /tmp/caw-r5-generation-mint.mts` — `DefaultCollabRegistryService` read output from `omp` stub omitting generation; real service list passed to `createMintLink`. Output: `{"cliOmittedGeneration":true,"parsedGeneration":null,"mintResult":"stale_generation","linkCommandCalls":0}`.

**Result: VERIFIED FIXED.** Omitted generation did not become `1`; guard refused mint before link command.

**What remains.** No live OMP generation rollover while minting; omission-through-service and mint guard were exercised with CLI stub.

## 6. §6 SEC-2 relay topology and residual

**Claim.** App-origin host refused, app-origin guest accepted, loopback relay-port host accepted; residual stated honestly.

**What code does.** `apps/server/src/server.ts:453-480` attaches same relay/table to app and separate `127.0.0.1` listener. App listener uses `allowHost:false`; host listener enables host and checks local port/loopback (`:459-475`). Relay policy is applied per attachment at `packages/relay/src/relay.ts:417-420,461-490`. Residual states any process able to reach loopback relay port can claim host and Tailscale Serve must proxy app port only (`apps/server/src/server.ts:453-468`; `docs/operations/ubuntu-setup.md:79-91`; `docs/operations/iphone-setup.md:33-46`). Pinned OMP v18.12.2 [`packages/coding-agent/src/collab/relay-client.ts`](https://github.com/can1357/oh-my-pi/blob/v18.12.2/packages/coding-agent/src/collab/relay-client.ts) lines 498-505 builds role URL and socket options with proxy only; its `CollabSocketOptions` has `wsUrl`, `role`, `key` (lines 115-122), supporting no per-launch custom-header credential.

**What I tried.**
- `npx vitest run tests/runtime/supervisor.test.ts tests/adapter/tmux-probe.test.ts tests/adapter/collab-registry.test.ts tests/server/link-rewrite.test.ts tests/server/relay-auth.test.ts tests/server/config.test.ts` — six files, 87 tests passed; fixture uses two real WebSocket listeners, refuses app host and accepts relay host/app guest (`tests/server/relay-auth.test.ts:22-53,69-95`).
- `pnpm exec tsx /tmp/caw-r5-production-relay.mts` — launched actual `apps/server/src/server.ts` with CLI stubs and dynamic ports; exercised three requested probes against production composition. Output: `{"productionServer":true,"appHostRefused401":true,"appGuestAcceptedAndJoined":true,"loopbackRelayHostAccepted":true}`.

**Result: VERIFIED FIXED (topology).** All three probes passed against running production server; guest joined the same room. Local-process residual and app-only proxy rule are plainly stated and consistent with documented single-owner trust boundary (`docs/architecture/security-model.md:7`). **UNVERIFIED:** actual Tailscale Serve forwarding not exercised; server tests establish listener policy, not Serve plumbing.

**What remains.** Actual Serve proxy/routing and host-port exposure are operational, not established by socket probes. If ops proxies relay port contrary to docs, second listener is exposed.

## 7. §7 link rewrite, schemes, queries, and CSP

**Claim.** Minted link is `<publicOrigin>/#<relayLink>`, secret byte-identical; all query strings and disallowed schemes refused; public origin validated; CSP not blanket-widened.

**What code does.** `apps/server/src/server.ts:96-134` requires room path/key shape and `ws:`/`wss:` relay scheme. `:146-184` validates inner link and rejects its query; direct links also reject query. `:186-199` rewrites direct link into fragment. `apps/server/src/config.ts:83-106` restricts origin to HTTP(S), loopback-only HTTP and rejects path/query/fragment. API CSP is explicit-origin at `apps/server/src/app.ts:88-103`; guest CSP remains `connect-src 'self' ws: wss:` at `apps/server/src/static-web.ts:184-187` and `packages/guest/index.html:9-11`: no wildcard `*`, but WebSocket hosts are not allowlisted there.

**What I tried.**
- `npx vitest run tests/runtime/supervisor.test.ts tests/adapter/tmux-probe.test.ts tests/adapter/collab-registry.test.ts tests/server/link-rewrite.test.ts tests/server/relay-auth.test.ts tests/server/config.test.ts` — six files, 87 tests passed. Rewrite tests cover valid deep link/secret, bad key lengths, direct `ftp:`/`file:`, direct query, and dot segments (`tests/server/link-rewrite.test.ts:23-100`); mint HTTP path direct/deep links is at `tests/server/conversation-link.test.ts:281-352`, not in this focused run.
- `pnpm exec tsx /tmp/caw-r5-link-boundaries.mts` — nested schemes, direct query, outer deep-link query, inner query, parsed dot-segment forms. Output: `{"schemeResults":[{"innerScheme":"ftp:","rejected":true},{"innerScheme":"file:","rejected":true},{"innerScheme":"javascript:","rejected":true},{"innerScheme":"data:","rejected":true},{"innerScheme":"http:","rejected":true},{"innerScheme":"https:","rejected":true},{"innerScheme":"mailto:","rejected":true},{"innerScheme":"ws:","rejected":false},{"innerScheme":"wss:","rejected":false}],"queryResults":["rejected","accepted","rejected"],"normalizedResults":["accepted","accepted"]}`. `ws`/`wss` are allowed; all tested disallowed nested schemes rejected. Deep outer query `https://app.example/?x=1#ws://relay.example/r/<valid>` was accepted: code checks `innerUrl.search`, not outer `url.search` in deep-link branch. `/r/./<valid>` and encoded `/%2e/` normalize and were accepted.
- `pnpm exec tsx /tmp/caw-r5-mint-outer-query.mts` — passed outer-query deep link through `createMintLink`. Output: `{"minted":true,"outputContainsOuterQuery":false,"outputDeepLink":true}`. Input query was silently dropped rather than refused.
- `pnpm exec tsx /tmp/caw-r5-mint-outer-schemes.mts` — inputs with `ftp:`, `file:`, `javascript:`, `data:`, `http:`, `https:`, and `mailto:` outer deep-link schemes were all minted and rewritten to `https://public.example`; no rejected scheme.
- `pnpm exec tsx /tmp/caw-r5-production-csp.mts` — actual server root and `/guest` responses, `publicOrigin=https://public.example`. Output: `{"appCsp":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://public.example; object-src 'none'; base-uri 'self'; frame-ancestors 'none'","guestCsp":"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; font-src 'self' data:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self';","appReferrerPolicy":"no-referrer"}`. `/guest` was fallback 404 (guest build absent); static handler set header before existence check.
- `pnpm exec tsx -e 'import { validatePublicOrigin } from "./apps/server/src/config.ts"; for (const origin of ["https://example.test?q=1","https://example.test#frag","https://example.test/path","ws://example.test","ftp://example.test","file:///tmp","javascript:alert(1)"]) { let rejected=false; try { validatePublicOrigin(origin); } catch { rejected=true; } if(!rejected) throw new Error(`accepted publicOrigin ${origin}`); } console.log("publicOrigin rejected query, fragment, path, ws, ftp, file, javascript schemes");'` — output: `publicOrigin rejected query, fragment, path, ws, ftp, file, javascript schemes`.

**Result: PARTIALLY FIXED.** Normal direct deep link, byte-identical key, direct query refusal, direct/nested-relay unsupported-scheme refusal, origin validation, and non-wildcard API CSP verified. Outer deep-link query is accepted and silently dropped, so blanket query refusal is false. Non-HTTP(S) outer deep-link schemes (including `javascript:`) are also accepted as inputs before rewrite; they do not survive as output origin, but fail explicit every-disallowed-scheme rejection requirement. Dot-path normalization is accepted despite source comment promising normalized inputs are refused. Guest CSP does not use `*`, but its scheme-wide `ws:`/`wss:` source is broader than an origin allowlist.

**What remains.** Reject deep outer `url.search` and disallowed outer schemes; compare raw path before URL normalization; run direct/deep matrix through `createMintLink`/API. Qualify CSP claim: app CSP is origin-specific; guest CSP allows WebSockets to any host.

## Non-falsifiable tests

- `tests/runtime/supervisor.test.ts:645-670` proves a row already carrying a new identity is rejected; it does not falsify restart between `identityAfterProbe` and `getTmux`. Real private-tmux interleaving reported `stopped` while dead stranger `$0` existed.
- `tests/runtime/supervisor.test.ts:228-250` covers failed write/kill within one supervisor; cannot falsify volatile reservation loss across restart. Real tmux test exceeded cap after new supervisor/store.
- `tests/adapter/collab-registry.test.ts:81-96` parser comparison alone does not prove mint refuses; service fixture `:219-253` plus `/tmp/caw-r5-generation-mint.mts` did.
- `tests/server/link-rewrite.test.ts:86-94` conditionally asserts only when URL parser path differs from expected. Parser-normalized dot path is accepted and can pass without exercising rejection.
- `tests/server/relay-auth.test.ts:22-53` uses real two-listener WebSockets but not production composition root or live Serve. Production probe covers actual app wiring, still not Serve.
- `tests/server/link-rewrite.test.ts:71-80` tests direct `ftp:`/`file:`/query only; misses deep outer schemes and outer query on app deep link. Nested relay-scheme probes tested valid WS/WSS and rejected invalid protocols, but are helper probes, not an HTTP route test.

## UNVERIFIED

- Live Tailscale Serve proxy/listener routing and operational firewalling; docs say proxy app port only, no Serve traffic exercised.
- Live OMP generation rollover during API link mint; omission through service+CLI stub and refusal before link were exercised.
- Full URL-normalization corpus and query/scheme behavior through a full HTTP request with actual OMP link remain unverified. Helper and `createMintLink` repros show outer query accepted/dropped and disallowed outer deep-link schemes accepted; two parsed dot forms accepted.
- Guest CSP with installed guest assets. Actual handler emitted CSP on `/guest` fallback 404; meta CSP is source-cited.
- Real kernel ACL denial on private tmux socket; fake CLI emitted exact permission diagnostic and supervisor refused.

## Commands run and observations

- `npx vitest run tests/runtime/supervisor.test.ts tests/adapter/tmux-probe.test.ts tests/adapter/collab-registry.test.ts tests/server/link-rewrite.test.ts tests/server/relay-auth.test.ts tests/server/config.test.ts` → 6 files passed, 87 tests passed; Fastify `[FSTDEP023]` deprecation warning.
- `pnpm exec tsx /tmp/caw-r5-sequential-journal.mts` → timed-out launch retained journal; second conversation `conflict_owner`; one launch/one live session.
- `pnpm exec tsx /tmp/caw-r5-real-tmux-cap.mts` → real failed cleanup; same-process retry refused; after new supervisor/store a retry + one new conversation left 3 live sessions at cap 2; third after that refused.
- `pnpm exec tsx /tmp/caw-r5-real-stop-restarted-dead.mts` → restart occurred during guarded kill; dead stranger at reused `$0` remained, yet stop returned `stopped` and event recorded.
- `pnpm exec tsx /tmp/caw-r5-real-stop-absent.mts` → same-server confirmed absence returned `stopped`.
- `pnpm exec tsx /tmp/caw-r5-permission-enumeration.mts` → `conflict_limit`, `launchCalls:0`.
- `pnpm exec tsx /tmp/caw-r5-generation-mint.mts` → omitted generation `null`, `stale_generation`, zero link command calls.
- `pnpm exec tsx /tmp/caw-r5-production-relay.mts` → app host refused, app guest joined shared room, loopback relay host accepted.
- `pnpm exec tsx /tmp/caw-r5-link-boundaries.mts` → tested nested schemes; deep outer query and normalized dot paths accepted.
- `pnpm exec tsx /tmp/caw-r5-mint-outer-query.mts` → minted deep link after silently dropping outer query.
- `pnpm exec tsx /tmp/caw-r5-mint-outer-schemes.mts` → all seven disallowed outer schemes were accepted then rewritten to public origin.
- `pnpm exec tsx /tmp/caw-r5-production-csp.mts` → API `connect-src 'self' wss://public.example`; guest `connect-src 'self' ws: wss:`; referrer `no-referrer`.
- `npx vitest run tests/server/conversation-link.test.ts tests/server/link-rewrite.test.ts tests/server/config.test.ts` → 3 files passed, 35 tests passed; Fastify emitted the same `[FSTDEP023]` deprecation warning. These endpoint tests were additionally exercised after the main focused run.
- `pnpm exec tsx -e 'import { validatePublicOrigin } from "./apps/server/src/config.ts"; for (const origin of ["https://example.test?q=1","https://example.test#frag","https://example.test/path","ws://example.test","ftp://example.test","file:///tmp","javascript:alert(1)"]) { let rejected=false; try { validatePublicOrigin(origin); } catch { rejected=true; } if(!rejected) throw new Error(`accepted publicOrigin ${origin}`); } console.log("publicOrigin rejected query, fragment, path, ws, ftp, file, javascript schemes");'` → seven malformed/disallowed origins rejected.
- Initial `pnpm exec tsx -e` import of `rewriteCollabLink` failed because app entry's top-level await was transformed as CJS. `.mts` probes replaced it; no verdict relies on failed attempt.
