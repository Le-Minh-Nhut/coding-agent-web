# Round 4 final verification

**Verdict.** Zero of seven areas are fully closed. ARCH-2 attach behavior is fixed, but stop polling still has a server-restart race; ARCH-1, ARCH-3, SEC-2, and link rewrite are partially fixed; ARCH-5 and slot accounting are not fixed. **Most serious remaining hole: `maxActive` can be exceeded after failed launch cleanup leaves an untracked process.** Real tmux reproduction with `maxActive: 2` ended with three live sessions (`node /tmp/caw-round4-cap-overrun.mjs`). All reproductions used throwaway `/tmp` scripts; no repository source, tests, or config changed.

## 1. ARCH-1 — alias double launch and post-launch store failure

**Claim:** Reservations cover conversation ID, native ID and resume path; lease check is inside critical section; failed metadata persistence cleans up launched process or retains ownership.

**What code does:** `packages/runtime/src/supervisor.ts:84-99,107-113,302-326` serializes launch work and reserves `conversation:<id>`, native session ID, and supplied journal path. Registry/tmux/lease probes are inside lock (`:327-345`). Existing live rows are checked for aliases (`:352-367`). After process launch, failed store update calls identity-guarded kill; supervisor treats any resolved kill call as success (`:411-436`) and retains reservation only if the call throws. But `DefaultTmuxService.kill()` at `packages/omp-adapter/src/tmux.ts:253-288` logs guarded-kill failure and returns normally, so the live process can survive while supervisor sets state `stopped` and releases reservation.

**What I tried:** `pnpm exec esbuild /tmp/caw-round4-sequential-alias.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-round4-sequential-alias.mjs && node /tmp/caw-round4-sequential-alias.mjs` ran two sequential starts through a fake adapter for different conversations, both with `nativeSessionId:null`, both resuming `/tmp/journal.jsonl`, and neither publishing a host. Output: `{"firstNativeSessionId":null,"firstNativeSessionPath":null,"secondNativeSessionId":null,"secondNativeSessionPath":null,"launches":2,"bothResumedSamePath":true,"liveSessions":2}` (adapter-reported live sessions). A reservation blocks concurrent launches only; after first publish-timeout return, second start can reuse the journal. Separately, `node /tmp/caw-round4-cap-overrun.mjs` injected a post-launch store failure plus a wrapper whose guarded kill fails. Output showed first process alive, no recorded ID, state `stopped`, diagnostic `tmux.kill_blocked:kill_failed...`; supervisor accepted the adapter's resolved return as successful cleanup.

**Result: PARTIALLY FIXED.** In-flight path aliases collide, but reservation is released after normal publish timeout, and no native path/ID is stored when the new process never publishes. Sequential same-journal launches still occur. More seriously, actual adapter does not throw when guarded kill fails: supervisor believes cleanup succeeded, records stopped, and releases reservation although tmux process remains alive. No durable ownership exists; backend restart also loses all process-local reservation state.

**What remains:** make guarded kill report verified outcome so supervisor retains ownership unless process exit is proven; persist or recover ownership across backend restart; prevent same journal from being launched again after first live process times out without publishing. Add sequential same-path/no-host and failed-cleanup tests.

## 2. ARCH-2 — stop-poll and attach bypass

**Claim:** Stop polling compares identity and distinguishes failed probe from confirmed stop; attach requires matching identity and uses private socket.

**What code does:** `packages/runtime/src/supervisor.ts:550-609` refuses stop without recorded/matching pre-kill server identity; poll continues on failed identity or tmux probe (`:586-601`). But it marks stop if the returned session is absent/dead at `:602-607` *before* comparing that session's identity at `:608`; a dead stranger at reused `$N` is therefore treated as our stopped process. `apps/server/src/app.ts:312-330` returns unavailable for missing/mismatched identity and, when matched, prints `tmux -S '<private socket>' attach -t '<$N>'`. Composition root configures `<stateDir>/tmux.sock` at `apps/server/src/server.ts:224-225` and passes it to app at `:374-385`.

**What I tried:** `node /tmp/caw-round4-stop-race.mjs` used real isolated tmux, restarted server between identity read and `$0` lookup, and reissued `$0` to a dead stranger. Output: `{"originalId":"$0","oldIdentityReturnedForPoll":true,"replacementIdentityDiffers":true,"replacementDead":true,"stateReported":"stopped","stoppedEventRecorded":true,"replacementExists":true}`. This demonstrates both that a dead stranger is accepted as stop proof and that separate observations can straddle restart. Attach route tests at `tests/server/app.test.ts:109-132` cover matching/mismatch/no identity; route source confirms exact outcomes and command. I did not issue three independent HTTP requests.

**Result: PARTIALLY FIXED.** Attach's matching identity returns available command targeting configured private socket; mismatch and absent identity return unavailable/null command. Stop poll handles failed probes, but a returned dead session is treated as stopped before its server identity is checked. The real-tmux reproduction falsely marked stopped while replacement session existed.

**What remains:** compare identity before interpreting any returned session, including dead sessions; obtain server identity and session observation atomically or bind the probe to the same server lifetime.

## 3. ARCH-3 — link identity evidence

**Claim:** CLI adapter no longer fabricates `instanceId`/`generation`; missing identity evidence returns `stale_generation`.

**What code does:** `packages/omp-adapter/src/collab-registry.ts:172-189` preserves missing link-response identity fields as null. `apps/server/src/server.ts:163-184` rejects null host or link identity/generation and any mismatch; `apps/server/src/app.ts:299-303` maps stale generation to HTTP `stale_generation`. But list parsing still fabricates generation 1 at `collab-registry.ts:21-47`.

**What I tried:** `pnpm exec tsx /tmp/caw-round4-link-list-generation.mts` used a CLI stub whose list omitted generation but whose link response returned generation 1. Output: `{"listResponseOmittedGeneration":true,"parsedListGeneration":1,"linkReturnedGeneration":1,"mintAccepted":true}`. It shows omitted list evidence passes mint guard. Then `pnpm exec tsx /tmp/caw-round4-link-fields.mts` tested bare URL and omitted `instanceId` or `generation` independently; outputs: `bare-url: instanceIdNull=true,generationNull=true`; `omit-instance: true,false`; `omit-generation: false,true`; `omit-both: true,true`.

**Result: PARTIALLY FIXED.** Link-response missing fields are not fabricated, but omitted generation in host listing becomes 1 and allows a mint. List parser requires string instance ID (`:25-30`), so omitted list instance ID is rejected rather than fabricated. Independent CLI stubs confirm response fields are null when omitted.

**What remains:** make host-list generation nullable and reject at mint; add regression coverage for each omission.

## 4. ARCH-5 — collapsing observations

**Claim:** Tmux enumeration throws on real failure; `getTmux` is tri-state; journal existence is tri-state; catalog only returns empty/null for ENOENT.

**What code does:** `packages/omp-adapter/src/tmux.ts:8-15,32-40,134-172` treats any output matching `error connecting to` as confirmed no server; other failures throw. `getById` returns null after successful list with no matching session, and throws on failed enumeration (`:170-173`); runtime wrapper maps this to `{ok,session}` at `apps/server/src/server.ts:281-287`. Runtime journal probe maps throws to `unknown` (`packages/runtime/src/supervisor.ts:132-175`), and state verdict preserves unknown (`packages/runtime/src/state.ts:38-71`). Catalog traversal suppresses ENOENT only (`packages/omp-adapter/src/session-catalog.ts:58-61,186-199,217-240,258-276`); invalid journal bytes return null (`:121-138`), actual open/read errors propagate (`:91-96`).

**What I tried:** fake tmux binary in `/tmp/caw-round4-tmux-error.mts` emitted `error connecting to /tmp/private.sock: Permission denied`. `pnpm exec tsx /tmp/caw-round4-tmux-error.mts` returned `{"listManaged":[],"getById":null,"serverIdentity":null}`. A real `tmux -S /root/caw-round4-private.sock list-sessions` also returned `Permission denied`; `stat` as app UID returned `EACCES`.

**Result: NOT FIXED for tmux probe certainty; catalog traversal itself is mostly tri-state.** Broad `error connecting to` match collapses permission denial into confirmed server absence, yielding empty sessions / null identity. Runtime can then report no process or count zero. Registry `#checkRegistryReadable()` (`collab-registry.ts:104-115`) treats only EACCES/EPERM as errors and silently accepts other failures, although code comment documents ENOENT alone as acceptable. `resolveCanonical()` (`session-catalog.ts:17-23`) catches all `realpathSync` failures and falls back to unresolved path; `#summaryFor()` (`:166-173`) swallows `stat` errors into null update metadata. Those latter operations alter canonical path/freshness metadata, not the existence result used by runtime's tri-state journal probe; no claim that they directly report a missing session.

**What remains:** match only confirmed no-server messages, distinguish permission errors from absence; propagate non-ENOENT registry failures. Decide whether realpath/stat failures are fatal or explicitly non-authoritative metadata.

## 5. Slot accounting

**Claim:** `activeCount()` returns `{count,known,reason}`, counts live processes regardless of stored state, and enumeration failure refuses launch without exceeding cap or wedging.

**What code does:** `packages/runtime/src/supervisor.ts:282-300` counts rows with recorded IDs matching live tmux IDs. `start()` refuses when `readManagedTmux()` reports failure (`:331-345,376-389`) and counts live owners by row/session intersection (`:347-371`). State label does not filter a tracked live row, but unrecorded processes are not countable.

**What I tried:** `node /tmp/caw-round4-cap-enumeration.mjs` created real isolated tmux session, then made `list-sessions` return permission denied through wrapper. Result: `{maxActive:1,before:{count:0,known:true,reason:null},firstSessionStillAlive:true,secondSessionId:"$1",actualManagedLiveSessions:2,...}`. This is the same adapter classifier bug as §4. Then `node /tmp/caw-round4-cap-overrun.mjs` caused store-write and guarded-kill failures; retry plus another conversation yielded `maxActive:2`, `actualLiveSessions:3`, tracked rows only `[$1,$2]`.

**Result: NOT FIXED.** Cap can be exceeded by permission-denied enumeration being treated as empty and by an untracked process after failed compensation. In-memory retained reservation blocks same-process retry for that exact launch, but cap count ignores untracked writer and reservation disappears after restart. Correctly tracked live rows count regardless of state; dead rows do not wedge cap.

**What remains:** fix tmux classification and make launch compensation/ownership durable or verify process exit. Add real-adapter fault tests for both cases.

## 6. SEC-2 — relay host isolation and residual

**Claim:** Shared room table; app origin guests-only, second loopback listener hosts; local-process residual documented honestly; OMP cannot present per-launch credential because it builds socket URL internally.

**What code does:** `apps/server/src/server.ts:390-408` attaches same relay to app server with `allowHost:false` and separate host server with `allowHost:true`; host server binds `127.0.0.1` at `:410-417`. Source comment at `:391-394` states any local process can reach host port and OMP cannot present credential. The host callback checks loopback peer and configured relay local port at `:401-405`. Relay applies per-listener host policy and calls authorization only for host role (`packages/relay/src/relay.ts:417-420,461-490`). Registry adapter runs `omp collab link <instance>` without shell (`packages/omp-adapter/src/collab-registry.ts:142-152`); overlay supplies relay URL and web URL, no credential (`apps/server/src/server.ts:39-45`).
**What I tried:** `pnpm exec vitest run tests/server/relay-auth.test.ts` → 1 file, 2 tests passed. Actual local sockets tested app listener host rejection despite forwarded address/cookie, host listener host acceptance, and guest joining same room on app listener. Tests use real WebSockets and two listeners, but not production server or actual Tailscale Serve.

**Result: PARTIALLY FIXED; topology verified.** Residual is documented honestly in source and acceptable under explicitly single-owner trust model, which excludes same-UID/local-process compromise (`docs/architecture/security-model.md:7`); it is not host authentication against untrusted local processes. Do not expose relay port through Serve. Repository config/adapter path shows no credential being passed to OMP, and `relayUrl` is internally used by overlay. **INFERENCE:** categorical statement that upstream OMP cannot support any per-launch credential is not independently established here; checked this repository's invocation/config only. Test confirms local listener policy, not remote proxy behavior.

**What remains:** verify actual Serve forwards only app port. Treat same-UID/local process as trusted per documented scope; if that changes, loopback binding alone is insufficient.

## 7. Link origin rewrite

**Claim:** public rewrite preserves `/r/<roomId>.<key>` and secret; rejects malformed link; validates `publicOrigin`; CSP remains honest.

**What code does:** direct links require pathname regex at `apps/server/src/server.ts:96,133-145`, rewrite as `publicOrigin + url.pathname + url.search` (`:139`), then compare parsed path (`:141-144`). Deep link fragments are parsed and checked at `:108-131`, and rewritten with configured host/scheme. `validatePublicOrigin()` at `apps/server/src/config.ts:83-106` restricts http(s), permits HTTP only for localhost/IP loopback, and rejects path/query/fragment. Guest CSP remains `connect-src 'self' ws: wss:` at `apps/server/src/static-web.ts:184-187`; this is scheme-wide, not host-specific, but not blanket `*`.

**What I tried:** `pnpm exec tsx /tmp/caw-round4-link-rewrite.mts` (stubbed rewrite function) accepted FTP and `javascript:` URLs with matching path, accepted one-character key `x`, rejected non-room path, and accepted `/r/x/../abcdefghij.validkey` after WHATWG URL normalized it to `/r/abcdefghij.validkey`. No credentials printed. Config test source checks path/query/fragment/non-http cases (`tests/server/config.test.ts:44-73`); inspected but did not run it.

**Result: PARTIALLY FIXED.** For ordinary regex-valid path, rewrite carries parsed pathname and secret characters into public URL. It does not preserve raw input bytes if URL parser normalizes dot segments, and it validates path shape only: unsupported schemes and malformed key length/encoding are accepted. `publicOrigin` checks requested constraints in source. CSP was not broadened to `*`, but is permissive for all ws/wss hosts, not an origin allowlist. Thus cannot call it host-specific or narrow.

**What remains:** require expected `ws:`/`wss:` URL scheme and valid room key encoding/length, reject path normalization rather than silently accepting it, and test direct/deep links. Restrict CSP to needed relay origins where deployment permits.

## Non-falsifiable tests

- `tests/server/app.test.ts:133-136` injects `activeCount()` returning `{known:false}` and verifies API rendering only; it cannot fail on the real `DefaultTmuxService` permission-error collapse because adapter is bypassed.
- Existing ARCH-1 tests using known IDs do not falsify null-ID same-journal sequential launch, failed store write plus failed kill, or restart after retained reservation.
- `tests/server/conversation-link.test.ts:350-383` tests malformed paths, not unsupported source schemes, weak keys, or raw path normalization.
- `tests/server/relay-auth.test.ts` uses real local WebSockets but simulated Serve forwarding headers; it cannot prove actual Tailscale Serve proxy behavior.
- `tests/server/config.test.ts:44-73` checks representative origin cases, not all URL parser forms or unusual loopback encodings.

## UNVERIFIED

- Actual whole-server sockets and live Tailscale Serve forwarding; local fixture tests equivalent listener role combinations only.
- OMP upstream guarantee that it cannot accept a per-launch credential; repository overlay/config inspected, upstream source not fetched. Marked INFERENCE above.
- Catalog permission/EIO injection and every non-ENOENT filesystem failure; source inspected, no fault-injected catalog run.
- Attach route HTTP requests for each identity case; route and existing test assertions inspected, not run. Private socket target verified from route/config source.
- Exact raw-byte preservation for all URL encodings; path normalization reproduction shows current equality is only after URL parsing.

## Commands run and observations

- `pnpm exec esbuild /tmp/caw-round4-sequential-alias.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/caw-round4-sequential-alias.mjs && node /tmp/caw-round4-sequential-alias.mjs` → `{"firstNativeSessionId":null,"firstNativeSessionPath":null,"secondNativeSessionId":null,"launches":2,"bothResumedSamePath":true,"liveSessions":2}`.
- `node /tmp/caw-round4-cap-overrun.mjs` → failed metadata write, guarded kill failure, first process alive/unrecorded; cap 2 ended at 3 live sessions.
- `node /tmp/caw-round4-stop-race.mjs` → replacement `$0` existed; stop reported stopped.
- `pnpm exec tsx /tmp/caw-round4-link-list-generation.mts` → omitted list generation parsed as 1; mint accepted.
- `pnpm exec tsx /tmp/caw-round4-tmux-error.mts` → permission-denied fake tmux became empty/null.
- `node /tmp/caw-round4-cap-enumeration.mjs` → permission-denied enumeration counted as known zero; second launch exceeded cap 1.
- `pnpm exec vitest run tests/server/relay-auth.test.ts` → 2 passed.
- `pnpm exec tsx /tmp/caw-round4-link-rewrite.mts` → FTP, javascript, weak key, and normalized path accepted; non-room path rejected.
- `tmux -S /root/caw-round4-private.sock list-sessions` → `Permission denied`; Node stat probe → `EACCES`.
- An earlier attempt to run `/tmp/caw-round4-sequential-alias.ts` via `tsx` failed transform before script was repaired; successful esbuild/node run above supersedes that attempt.