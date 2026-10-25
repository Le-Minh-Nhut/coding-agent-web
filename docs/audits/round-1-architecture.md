# Round 1 — architecture, lifecycle correctness and concurrency

**Verdict.** The core invariant does **not** hold. **Most serious: the launch guard is check-then-act, so concurrent requests resuming one native session both launch and can fork its journal; this race was reproduced against the supervisor.** Separately, persisted tmux `$N` can be reused after a tmux server restart, letting reconciliation adopt and stop an unrelated `caw-` session.

## Findings

### ARCH-1 · P0 · Runtime launch concurrency

**Evidence:** `packages/runtime/src/supervisor.ts:201-247` reads conversation, registry, managed tmux list, lease, and active count, then calls `launch` without reservation or serialization. `packages/runtime/src/state.ts:172-195` decides only from that snapshot. `apps/server/src/app.ts:212-223` accepts create requests with `resumeSessionId`; `packages/contracts/src/index.ts:247-252` permits the same ID in multiple requests. OMP forks a second writer rather than rejecting it (`docs/adr/0001-runtime-architecture.md:49-58`). Same check-then-act race can exceed `maxActive` for different sessions (`supervisor.ts:196-198,220-225`).

**Reproduction:** Called `supervisor.start()` concurrently for two conversations sharing one native session ID, with `isSessionLive()` returning `false` to both and an adapter assigning distinct tmux IDs. Observed two launch calls and both calls returned `idle`. Controlled in-memory adapter, not real OMP. Existing tests cover lease refusal serially, not this interleaving (`tests/runtime/supervisor.test.ts:195-216,242-325`).

**Root cause:** Lease probe is observation, not atomic lock. Separate conversation IDs and distinct names let both requests pass before either OMP process takes lease.

**Fix:** Reserve launch by native session ID (and by conversation ID for fresh sessions) across check-and-launch. Reserve active-agent slot in same critical section. Losing request returns `conflict_owner` or `conflict_limit` without launching.

**Verify:** Add supervisor test with two conversations sharing one native ID and a barrier holding both lease probes until both return `false`; assert exactly one launch and one `conflict_owner`. Add distinct-session test at `maxActive: 1`; assert one launch. **UNVERIFIED:** real concurrent OMP reproduction.

**Other launch paths:** Publish timeout occurs after `tmuxSessionId` is stored; it reports an unshared process, and retry against same live managed ID is refused (`supervisor.ts:247-261,336-344`; `state.ts:158-164`). If recorded tmux ID is gone, runtime deliberately does not fall back to name when ID exists (`supervisor.ts:132-139`); held or unknown native lease blocks launch (`state.ts:172-186`), free lease permits it. Unknown lease is mishandled later by refresh/reconcile (ARCH-5).

### ARCH-2 · P0 · tmux ID reuse breaks ownership

**Evidence:** `packages/omp-adapter/src/tmux.ts:30-40` uses default tmux server unless socket supplied; `:58-102` lists sessions by `caw-` prefix; `:114-180` records returned `$N`; `:222-231` kills by `$N`. Runtime treats recorded ID as authoritative and has ID-less name fallback (`packages/runtime/src/supervisor.ts:132-138`); reconciliation adopts a matching session (`:176-180`) and stop kills stored ID (`:364-365`).

**Reproduction:** On tmux 3.6, `tmux -L caw-audit-final new-session -d -P -F '#{session_id}' -s caw-owned 'sleep 600'` printed `$0`. `tmux -L caw-audit-final kill-server` returned no output. Creating `caw-stranger` on restarted server printed `$0` again. `tmux kill-session -t '$0'` killed that new session; subsequent `tmux -L caw-audit-final list-sessions -F '#{session_id} #{session_name}'` reported `no server running`. `$N` is stable only within one tmux server lifetime.

**Root cause:** Reconciliation equates process-local session numbers across server lifetimes. Name fallback has same ownership flaw when ID is absent; prefix is namespace, not proof app created session.

**Fix:** Bind sessions to identity qualifying tmux server lifetime (for example, dedicated app-owned tmux socket plus persisted server identity); require it on adopt and stop. Do not adopt legacy ID-less records by display name alone; preserve unknown until ownership is established.

**Verify:** Save managed reference, restart its tmux server, create different `caw-` session with same `$N`, then reconcile and stop old conversation. Assert stranger remains alive and is not adopted. **UNVERIFIED:** full supervisor-level reproduction; tmux target reuse and kill were directly reproduced.

### ARCH-3 · P1 · Link can cross a session switch

**Evidence:** `apps/server/src/server.ts:188-205` lists hosts and selects by conversation `nativeSessionId`, then calls `registry.link(host.instanceId)` and returns URL without comparing selected generation/session to link result. `packages/omp-adapter/src/collab-registry.ts:142-187` runs `omp collab link <instanceId> --json`. Upstream link resolver performs fresh list and links generation from that new listing (`/tmp/caw-poc/oh-my-pi/packages/coding-agent/src/collab/registry.ts:680-708`); OMP changes generation when rotating a room (`.../collab/controller.ts:6-11,241-260`).

**Root cause:** Server's list and CLI's list are separate observations. If OMP switches sessions between them, CLI can issue valid successor-room URL for old conversation.

**Fix:** Pin observed generation through link creation or compare returned instance/generation with selected row before returning any URL; mismatch becomes `stale_generation` and requires fresh conversation state.

**Verify:** Fake server list as old session/generation and CLI link as successor session/generation. Assert no successor URL returned and API responds `stale_generation`. **UNVERIFIED:** live-host race timing.

### ARCH-4 · P1 · Unknown turn signal becomes `idle`

**Evidence:** `packages/runtime/src/state.ts:88-93` maps `busy === null` to `idle`; `:39-45` maps external host with null busy to idle too. Startup/reconciliation repeat truthy/else mapping (`packages/runtime/src/supervisor.ts:316-330,413-421`); startup clears `statusDetail`. Browser maps absent/false busy to idle (`apps/web/src/components/ConversationView.tsx:76-83`). Contract says null busy renders unknown (`docs/architecture/session-lifecycle.md:66-70`), and wire `busy` is optional (`packages/collab-protocol/src/types.ts:169-175`). Existing state test expects idle on null (`tests/runtime/state.test.ts:52-56`).

**Root cause:** Boolean fallthrough merges “not busy” with “busy not reported.” Managed branch adds caveat but still labels idle; external/startup branches drop caveat.

**Fix:** Preserve null/absent as `unknown` (or introduce explicit unconfirmed state end-to-end); only `busy === false` may produce idle. Keep same mapping across managed, external, startup, reconciliation, and guest.

**Verify:** Assert null/undefined busy is unknown across those paths; false remains idle and never means completed. Update current null-busy assertion.

### ARCH-5 · P1 · Unknown liveness and registry failure become stopped/idle

**Evidence:** Lease probe returns `unknown` when ID unsafe or `/proc/net/unix` unreadable (`packages/omp-adapter/src/session-lease.ts:126-137`). `packages/runtime/src/state.ts:105-130` special-cases only `true`; unknown falls through `everLaunched` and reports stopped/error. Reconcile likewise special-cases only true (`supervisor.ts:449-463`). Reproduced `evaluateState` with unknown lease, prior launch, readable history, no tmux/host; output: `{"state":"stopped","ownership":"managed","detail":"The agent process is no longer running; its conversation history is intact."}`. Startup polling swallows registry exceptions as `[]` (`supervisor.ts:289-292`) and after timeout reports idle (`:336-344`). Catalog maps lease `unknown` to `live: false` (`packages/omp-adapter/src/session-catalog.ts:169,227`).

**Root cause:** Failed observation is treated as negative observation outside launch guard. Launch correctly refuses unknown lease (`state.ts:180-186`). `liveSet()` is not used by catalog and, on procfs read failure, maps every requested ID to false (`session-lease.ts:153-157`).

**Fix:** Require confirmed free lease before reporting stopped; return unknown otherwise. Preserve registry-read success/failure during publish polling. Do not turn unknown catalog lease into `live: false`.

**Verify:** Test unknown lease with no tmux/host, live tmux whose every registry poll throws, and session catalog with unreadable proc table; expect unknown, never stopped/idle/false. State case reproduced; other paths inspected. **UNVERIFIED:** `/proc/net/unix` unavailable on production host.

### ARCH-6 · P1 · tmux command failure is indistinguishable from no sessions

**Evidence:** `DefaultTmuxService.#listAllSessions()` catches every command failure and returns `[]` (`packages/omp-adapter/src/tmux.ts:58-96`); supervisor similarly converts `listManagedTmux()` rejection to `[]` (`packages/runtime/src/supervisor.ts:90-92,395-402`). Reconcile then treats host/no-tmux as external (`:413-424`) or refreshes no-host/no-tmux as stopped when lease appears free (`:449-463`; `state.ts:105-130`).

**Root cause:** tmux server unavailable, permission denied, or malformed output is indistinguishable from a successful empty listing. Missing tmux observation can overwrite managed ownership/state with external or stopped.

**Fix:** Preserve listing result as available/unavailable; mark affected conversations unknown when tmux observation fails. Only a successful list with no matching session proves absence. Keep a dead pane distinct from unavailable server.

**Verify:** Make `tmux list-sessions` fail for a conversation with recorded `$N`, both with/without host row; assert reconciliation reports unknown, preserves managed ownership, and never reports stopped/external. **UNVERIFIED:** injected live adapter reproduction.

### ARCH-7 · P1 · Link failure claims process is absent

**Evidence:** `apps/server/src/server.ts:192-196` returns same `link_unavailable` when registry row absent or `relayConnected` false. `apps/web/src/components/ConversationView.tsx:207-212` maps code to `linkUnavailable`; card then says “There is currently no active host agent process” (`:393-397`).

**Root cause:** Link availability is not process liveness. Live tmux/OMP agent with relay disconnected is presented as no active agent.

**Fix:** Return distinct unavailable causes, or neutral copy saying only live viewing is unavailable. Do not claim process absence from a link failure.

**Verify:** Stub existing host with `relayConnected: false` and no-host case; assert neither renders false stopped/absent-process claim. **UNVERIFIED:** browser UI reproduction.

### ARCH-8 · P1 · Stop masks missing native history

**Evidence:** `packages/runtime/src/state.ts:48-59` returns stopped immediately when `stopRequested`, before checking history. `packages/runtime/src/supervisor.ts:367-375` records stopped as soon as tmux disappears without checking journal. Server implements `sessionPathExists` as `stat(...).isFile()` (`apps/server/src/server.ts:133-138`), which establishes neither readability nor valid header. Contract defines stopped as session still existing and error as missing (`packages/contracts/src/index.ts:76-79`).

**Root cause:** Process exit is sufficient for explicit-stop success; elsewhere a regular but unreadable/malformed file counts as intact history.

**Fix:** After confirming process exit, distinguish missing/unreadable history (`error`) from clean stop. Validate recorded journal header/readability rather than relying on `stat` alone.

**Verify:** Stop with recorded native ID after file disappears and after malformed/unreadable regular file is substituted; expect `error`, not `stopped`. **UNVERIFIED:** OMP journal loss during real shutdown.

### ARCH-9 · P1 · Overlay write failure silently launches unconfigured OMP

**Evidence:** Launch adapter swallows `writeOverlay()` failure and passes undefined `configPath` to `tmux.launch()` (`apps/server/src/server.ts:112-125`). Overlay enables Collab auto-hosting (`:112-116`); runtime then waits for registry row and reports unshared process after timeout (`packages/runtime/src/supervisor.ts:336-344`).

**Root cause:** Required launch configuration write is treated as optional.

**Fix:** Propagate overlay write failure and refuse to launch OMP. If no-relay launches are intended, represent explicitly and report capability/status honestly.

**Verify:** Inject overlay write failure; assert adapter launch is not called and API reports failure. **UNVERIFIED:** failure-path execution.

### ARCH-10 · P1 · Retired room reconnect loop never refreshes link

**Evidence:** `packages/collab-protocol/src/socket.ts:184-206` retries guest close 4001 and then 4004 while `#retryMissingRoom` is set; retry scheduling has no cap (`:226-235`). Web only changes status on close (`apps/web/src/components/ConversationView.tsx:253-255`), never requests a new link. OMP session switches retire old room and create new one (`/tmp/caw-poc/oh-my-pi/packages/coding-agent/src/collab/controller.ts:6-11`).

**Root cause:** Retry is suitable if same room returns after relay restart, but session switch permanently retires old room ID. Guest retries stale URL forever and never obtains successor link.

**Fix:** On definitive retirement, fetch fresh authenticated link and rejoin only after confirming current conversation identity; otherwise terminate with actionable stale-room state. Separate transient relay retry from permanent room retirement.

**Verify:** Join room, close with 4001, never recreate old room, publish new generation. Assert fresh link request or terminal stale-room state rather than indefinite retries. **UNVERIFIED:** live browser reproduction.

### ARCH-11 · P2 · Attached relay leaves HTTP upgrade listener installed

**Evidence:** `packages/relay/src/relay.ts:414-495` registers `upgrade` listener on supplied server. `stop()` closes rooms/WebSocketServer but closes HTTP server only if standalone (`:567-610`); it does not remove listener. Composition stops relay before Fastify (`apps/server/src/server.ts:265-269`).

**Root cause:** Relay correctly does not own attached HTTP server but fails to detach its listener. A shutdown-window upgrade or repeated construction on one server can reach stopped `WebSocketServer`/accumulate listeners.

**Fix:** Retain and remove exact upgrade callback on stop; reject upgrades after stop. Let Fastify own HTTP shutdown.

**Verify:** Attach/start/stop while HTTP server remains open; assert listener count returns to baseline and later `/r/` upgrade safely rejects. **UNVERIFIED:** runtime reproduction.


### ARCH-12 · P2 · Unbounded metadata and authentication maps

**Evidence:** `apps/server/src/store.ts:78-86` appends and syncs every row; `:139-169` keeps all conversation revisions, events, and idempotency commands in memory and JSONL. No compaction/retention path. Store does **not** grow on every state poll: `packages/runtime/src/supervisor.ts:152-164` avoids writes when verdict unchanged. Separately, `apps/server/src/auth.ts:36-38,79-93` grows `ipRates` on failures from distinct IPs; only successful login from that IP removes entry. Expired session entries are removed only when token is presented (`:96-109`).

**Root cause:** Append-only history and in-memory indexes are unbounded; rate limiter accepts unbounded distinct IP keys.

**Fix:** Define storage retention/compaction policy before history size becomes operationally significant; bound failed-login rate-state and expire stale entries with bounded cleanup. Expire sessions without per-request full-map scan.

**Verify:** Stress updates/events and verify chosen retention/replay policy; generate failures from many synthetic IPs and assert map remains bounded. **UNVERIFIED:** long-running growth test.

### ARCH-13 · P2 · Native session listing repeats lease scans

**Evidence:** `packages/omp-adapter/src/session-catalog.ts:164-169,221-228` reads header then calls `isLive()` per session. `isLive()` rereads whole `/proc/net/unix` (`session-lease.ts:126-137`). `liveSet()` reads it once for multiple IDs (`:140-169`) but catalog does not use it. Header reader allocates 64 KiB buffer per file (`session-catalog.ts:9,81-84`).

**Root cause:** Listing N sessions causes N procfs reads and sequential allocations although bulk probe exists.

**Fix:** Collect parsed IDs, do one tri-state bulk probe, preserve unknown instead of false. Consider smaller/streamed header reads only if upstream header constraints support them. Existing `liveSet()` itself maps procfs read failure to false (`session-lease.ts:153-157`), so fix that before lifecycle use.

**Verify:** Fixture with N sessions and instrumented proc source; assert one read and identical states. **UNVERIFIED:** performance benchmark.

### ARCH-14 · P2 · Dead and mismatched lifecycle ports

**Evidence:** `RuntimeAdapters.newestSessionFor` is declared/wired (`packages/runtime/src/types.ts:84-102`, `apps/server/src/server.ts:129-132`) but never called. `SessionCatalogOptions.isTracked` is stored/consulted (`packages/omp-adapter/src/session-catalog.ts:11-15,61-70,187`) but no caller supplies it; server independently computes tracked IDs (`apps/server/src/server.ts:214-230`). `adopt()` calls `findBySessionId(conversation.nativeSessionPath)` and assigns its returned path to `nativeSessionId` (`packages/runtime/src/supervisor.ts:171-174`), although API accepts ID and returns path (`packages/runtime/src/types.ts:100-101`; `session-catalog.ts:252-270`). Search found no writer of `nativeSessionPath`; store initializes null (`apps/server/src/store.ts:129-134`). `RelayConfig`/`RelayStatus`/`RelayService` in adapter types (`packages/omp-adapter/src/types.ts:179-200`) duplicate relay package contracts (`packages/relay/src/relay.ts:102-161`).

**Root cause:** Unused wiring and dormant path-recovery branch obscure identity/tracking ownership.

**Fix:** Remove unused ports/options/types; remove unreachable recovery path or correct it with actual migration source; keep relay contracts in relay package.

**Verify:** Typecheck and search remaining callers. **UNVERIFIED:** whether deployed metadata contains non-null legacy `nativeSessionPath`.

## Checked and not found

- Reconciliation calls no kill path (`packages/runtime/src/supervisor.ts:395-466`). Registry unreadable gives unknown in reconciliation (`:399-402,440-447`). A host row without a managed tmux session is recorded external and never killed (`:413-424`); a foreign held lease without host row becomes unknown (`:449-458`, covered by `tests/runtime/supervisor.test.ts:445-455`). Backend restart by itself does not mark sessions stopped; absence of recorded tmux does, after registry/lease checks.
- tmux capture/send/kill service methods use `$N` and reject targets without `$` (`packages/omp-adapter/src/tmux.ts:183-232`). `getByName()` exists (`:109-112`) but grep found no production caller. The deliberate id-less adoption fallback (`supervisor.ts:132-139`) is **not safe**: it can adopt a reused `caw-` display name without proof of ownership.
- A live tmux pane with no host is represented idle with “not sharing” detail (`packages/runtime/src/state.ts:70-80`); host with `relayConnected: false` is idle with explicit live-view caveat (`:95-100`). Busy false is not called completed in runtime UI, but guest's state frame collapses false/absent into idle (`ConversationView.tsx:76-83`).
- Static file handlers close handles on early return and transfer ownership to streams for GET (`packages/relay/src/static.ts:198-243`; `apps/server/src/static-web.ts:97-141`). Relay heartbeat interval is unref'ed and cleared on stop (`packages/relay/src/relay.ts:503-517,567-571`). Socket reconnect timer is cleared on close (`packages/collab-protocol/src/socket.ts:85-104,237-242`). Relay socket liveness entries are removed on close (`relay.ts:270-278`). No per-poll event append: unchanged state returns without writing (`supervisor.ts:152-164`).
- Boundary types are generally narrow: runtime ports isolate store/adapter (`packages/runtime/src/types.ts:1-8`); host model is flattened at composition boundary (`apps/server/src/server.ts:88-103`). `RuntimeAdapters` is wider than supervisor needs (`newestSessionFor` is unused); adapter catalog `isTracked` duplicates server tracking. `RuntimeTmuxSession.panePid` is carried but runtime does not use it (`packages/runtime/src/types.ts:35-41`; adapter wiring `server.ts:104-132`).

## Questions I could not answer

- **UNVERIFIED:** Two real OMP processes concurrently resuming one live native session were not launched; concurrent supervisor race reproduced with controlled adapters, and OMP fork behavior is documented from observed evidence.
- **UNVERIFIED:** Whether deployed records contain legacy `nativeSessionPath`, and whether a tmux server restart leaves OMP descendants alive in production. `$N` reuse and stranger kill were reproduced against tmux 3.6.
- **UNVERIFIED:** Live timing of link/session-switch race and stale-room reconnect loop; source and upstream generation behavior inspected.
- **UNVERIFIED:** Long-duration metadata/auth growth, catalog performance, and relay shutdown-window stress runs.
