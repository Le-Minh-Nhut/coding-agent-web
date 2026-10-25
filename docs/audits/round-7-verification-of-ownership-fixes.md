# Round 7 verification of ownership fixes

**Verdict — both are not fully closed.** A is **PARTIALLY FIXED**: the exact rename/cap bypass is fixed, and real tmux confirmed that renamed, directly-created, and unowned `caw-` sessions are enumerated on the responding configured server. But unlinking that server's socket and launching at the same path starts a replacement server; the old server and pane process survive invisible, and a new managed session was admitted at `maxActive: 1`. B is **VERIFIED FIXED** for the original unlinked-socket false `stopped`: live pane PID leaves the conversation `stopping`, a PID proven absent with `ESRCH` settles `stopped`, and permission denial throws. **Most serious remaining hole:** A's cap/ownership scan trusts whichever tmux server currently answers at the configured socket path. Replacing an unlinked socket lets an untracked pane process on the old server disappear from accounting and permits another managed launch. B still safely refuses stop for recorded rows, but cannot protect a session it never recorded. Whether both panes are real OMP writers is **UNVERIFIED**; this probe proves the session-cap bypass with real processes, not provider-backed writer behavior.

## A. Ownership is the configured socket, not a name — PARTIALLY FIXED

**Claim.** Enumerate every session on the app's explicitly configured private tmux server. Do not let a mutable name, including dropping or having a `caw-` prefix, change ownership accounting or cap enforcement.

**What code does.** Production creates the adapter with `join(config.stateDir, "tmux.sock")` at `apps/server/src/server.ts:301-302`. `DefaultTmuxService` translates `socketPath` to tmux `-S` at `packages/omp-adapter/src/tmux.ts:63-75`. `listManaged()` rejects an unconfigured/default server, then calls `#listAllSessions()` at `:122-167`; the list command includes all server sessions and records `session_id`, name, pane pid/dead flag, and server identity at `:127-155`. There is no session-name filter. The supervisor counts all live returned sessions in `activeCount()` at `packages/runtime/src/supervisor.ts:330-355`, checks untracked live sessions at `:401-412`, and includes all live enumerated sessions in launch cap calculation at `:442-460`.

**What I tried.**

- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-fix-a.mts` — real tmux 3.6 and `DefaultTmuxService` on an isolated `-S` socket. This script reproduced the round-6 launch sequence, direct socket sessions, `caw-` orphan, no-socket configuration, and a normal start/stop/start sequence. Output:

  ```json
  {
    "test1_noSocketArgs": {"threwWithoutSocket":true,"withoutSocketError":"Cannot enumerate owned sessions without an explicitly configured private tmux socket."},
    "test2_renamedSessionCap":{"managedSessionIds":[{"id":"$1","name":"caw-s2"},{"id":"$0","name":"renamed-out-of-prefix"}],"renamedSessionIncluded":true,"launchResult":"conflict_limit","activeCount":{"count":2,"known":true,"reason":null},"liveSessionsCount":2,"exceededCap":false},
    "test3_untrackedSession":{"untrackedInManaged":true,"launchResult":"conflict_owner","activeCount":{"count":1,"known":true,"reason":null}},
    "test3b_cawOrphan":{"launchResult":"conflict_owner"},
    "test4_happyPath":{"h1State":"idle","h1Ownership":"managed","countAfter1":1,"h2State":"idle","countAfter2":2,"stopped1State":"stopped","countAfterStop":1,"h3State":"idle","countAfter3":2}
  }
  ```

  Thus two live app sessions, one renamed out of `caw-`, were enumerated; third start at `maxActive: 2` returned `conflict_limit`, with count 2 and no cap overrun. Directly-created untracked session and a `caw-`-prefixed unowned session both blocked launch with `conflict_owner`. Happy path admitted two agents, stopped one, and admitted a third with active count back to 2.

- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-cross.mts` — real private tmux `-S` probe: created an untracked `sleep` session, unlinked its socket pathname with the server and pane alive, then launched via the service. Observed `{"socketPathUnlinked":true,"directlyCreatedSessionId":"$0","admittedLaunchId":"$0","maxActive":1,"currentlyEnumeratedSessionIds":["$0"],"oldServerAlive":true,"oldPaneAlive":true}`. The old socket server became unreachable; next launch started a new server at the same path and reused `$0`. Enumeration saw only the new server and admitted another managed launch while the old pane and server remained alive. This shows the fix's precise boundary: it removes name filtering and protects sessions visible on the configured socket, but it cannot enumerate an earlier tmux server stranded by socket unlink/replacement. B prevents falsely stopping a *recorded* such writer; it does not recover an unrecorded session.

- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'counts renamed sessions against maxActive|refuses stop when the recorded server is live but its socket pathname was unlinked|does not stop a live tmux server when its socket pathname disappears during polling|stops after the recorded private tmux server process exits|settles stop when the real pane PID exits and the tmux server vanishes|keeps stop pending when the socket is unreachable but pane process lives|keeps legacy rows without a pane PID pending when the socket is unreachable|settles stopped when recorded pane PID has exited and socket is unreachable'` — **8 passed, 47 skipped**. Tests corroborate these branches but do not on their own prove all-sessions enumeration; the live tmux probes do.

**Explicit answers.** Renaming to a non-`caw-` name does not hide the session while the configured server is reachable. A `caw-`-prefixed session no row owns is enumerated and launch fails `conflict_owner`; name is never sufficient to declare ownership. Any session created directly on the configured socket is enumerated and counts; untracked live direct session blocks launch. No-socket service refuses enumeration instead of silently using default tmux. Happy path works, including stop and newly available capacity. **Caveat:** inaccessible/replaced socket server is not enumerable; the cross-server real-socket probe found a remaining cap bypass described above.


## B. Unreachable socket is not a dead process — VERIFIED FIXED

**Claim.** If `serverIdentity()` is null, settle `stopped` only when the recorded conversation pane PID is demonstrably gone (`ESRCH`). Alive, uncheckable, absent, or invalid PID must not be treated as proof of exit. Permission-denied probes remain errors.

**What code does.** `processAlive()` maps null, unsafe/non-integer, and nonpositive PIDs to `"unknown"`; `process.kill(pid, 0)` success means alive and only `ESRCH` means gone. Other OS errors remain unknown, at `packages/runtime/src/supervisor.ts:89-98`. Before kill, a null server identity only records stopped if `processAlive(...) === false` (`:654-662`). During polling, null identity repeats that guard and otherwise continues to timeout (`:687-698`); timeout leaves state `stopping` and records `agent.stop_timeout` (`:714-720`). On a responding server, stop also brackets session lookup with server identity reads and refuses failed/mismatched probes (`:679-710`). Adapter classifies no-server diagnostics as null but excludes permission diagnostics, which throw, at `packages/omp-adapter/src/tmux.ts:8-35,96-115`.

**What I tried.**

- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-fix-b.mts` — real tmux 3.6, unique private sockets, real `sleep` panes. This deliberately unlinked a live server's socket pathname while the server and pane remained alive, separately killed a pane while leaving the socket unreachable, probed PID edge semantics, and made the socket directory mode `000`. Results:

  ```json
  {
    "test1_unlinkedLive":{"probeIdentity":null,"stopReturnedState":"stopping","stopStatusDetail":"The process has not exited yet.","stoppedEventFired":false,"stopTimeoutEventFired":true,"panePidStillAlive":true,"serverPidStillAlive":true,"retryLaunchResult":"agent_not_running","activeCount":{"count":0,"known":false,"reason":"A previously recorded tmux server is still alive but unreachable, so the running-agent count is unknown."}},
    "test2_unlinkedGenuinelyDead":{"paneConfirmedDeadESRCH":true,"stopReturnedState":"stopped","stopStatusDetail":"Stopped.","stoppedEventFired":true},
    "test3_pidSemantics":{"legacy_null":{"returnedState":"stopping","stoppedEvent":false},"zero":{"returnedState":"stopping","stoppedEvent":false},"negative":{"returnedState":"stopping","stoppedEvent":false},"eperm_pid_1":{"returnedState":"stopping","stoppedEvent":false},"live_pid":{"returnedState":"stopping","stoppedEvent":false},"dead_pid_esrch":{"returnedState":"stopped","stoppedEvent":true}},
    "test4_permissionDenied":{"identityReturnedNull":false,"identityThrew":true,"listThrew":true,"stopThrew":true,"stopErrorMessage":"The tmux server identity could not be verified, so this process cannot be safely stopped.","stopSettledToStopped":false}
  }
  ```

  The live unlinked-socket reproduction returned `stopping`, emitted no stopped event, and confirmed both server and pane PIDs alive. `activeCount` reported `known:false`. The script's attempted launch for `c2` returned `agent_not_running`, but its temporary store had no `c2` row, so that result does not prove launch/retry refusal. The separate same-conversation retry probe below returned `conflict_owner`. With the pane explicitly killed and subsequent `kill(pid, 0)` yielding `ESRCH`, stop returned `stopped`. Null, zero, negative, `EPERM` PID 1, and current live process PID stayed `stopping`; a dead PID returned `stopped`.

- `node -e 'try { process.kill(1,0); console.log("kill(1,0)=success"); } catch (error) { console.log(`kill(1,0)=${error.code}`); }'` — observed `kill(1,0)=EPERM`; corroborates the unsignalable case maps to unknown, never absence.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-retry-pid.mts` — direct invalid PID inputs `NaN`, `Infinity`, `1.5`, and `9007199254740992` each returned `stopping`; it also confirmed same-conversation retry after unlinked stop returns `conflict_owner`.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-retry-pid.mts` — real private socket, recorded live owner, unlink path, call `stop()`, then retry the same conversation. Output: `{"stopState":"stopping","retryResult":"conflict_owner","refusedEvent":true,"paneAlive":true,"serverAlive":true}`. Same-conversation retry stays blocked rather than starting second writer.

- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'counts renamed sessions against maxActive|refuses stop when the recorded server is live but its socket pathname was unlinked|does not stop a live tmux server when its socket pathname disappears during polling|stops after the recorded private tmux server process exits|settles stop when the real pane PID exits and the tmux server vanishes|keeps stop pending when the socket is unreachable but pane process lives|keeps legacy rows without a pane PID pending when the socket is unreachable|settles stopped when recorded pane PID has exited and socket is unreachable'` — **8 passed, 47 skipped**. Includes live real-socket unlink, actual stop, and missing-PID behaviors. Targeted test pass is supporting evidence, not the sole basis for either verdict.
**Explicit answers and fail-closed judgment.** The rebuilt original fault cannot report `stopped` while pane PID remains alive. A truly exited agent yields `stopped` under `ESRCH`, even if socket server remains alive but socket is unlinked. `tmuxPanePid === null` yields `stopping`, no `agent.stopped`. Zero/negative, fractional, `NaN`, infinity, and unsafe integer all yield `stopping` (`processAlive`, `:89-98`; direct probe observed `NaN`, `Infinity`, `1.5`, and `9007199254740992`); PID 1 was unsignalable (`EPERM`) and also stays `stopping`. Other `process.kill(pid,0)` errors likewise become unknown. **Fail-closed costs availability, not writer safety:** on unlink, old owner may no longer be stoppable through tmux; with PID alive/unknown, operation reaches timeout at the caller-supplied/default timeout and leaves state `stopping`. This is correct trade against falsely allowing a retry while old writer may still run. A same-conversation retry after that stop returned `conflict_owner` in the real private-socket probe recorded above. If the agent genuinely exited but its PID has since been reused by an unrelated live process, a valid PID can cause an indefinitely delayed/false-negative stop (the code comment explicitly notes PID reuse at `:691-694`); safe direction, but recovery/retry may require resolving the socket/process. PID reuse causing this delay is **[INFERENCE]** from `process.kill(pid, 0)` semantics and implementation; no PID reuse was forced. Launch also detects a still-live old server for recorded rows at `:112-120,414-424`.

**Permission denied.** Running as uid 1000, the probe chmod'd the owned socket directory to `000`; `serverIdentity()` and list both threw diagnostics containing `(Permission denied)`. `stop()` threw “The tmux server identity could not be verified, so this process cannot be safely stopped.” and did not settle. The adapter explicitly excludes permission patterns before the no-server match at `tmux.ts:31-35`.

**What remains.** Original false-stopped path is fixed under tested conditions. Pane PID check is deliberately conservative but vulnerable to PID reuse as a liveness false positive, which delays stop; an `ESRCH`/reuse race also exists between probe and state write because the OS check is not atomic with the store update. PID reuse cannot create a false stopped claim, only prevent one. It is not a process-start-time identity check.

## Non-falsifiable tests

- `tests/runtime/supervisor.test.ts:284-322` exercises real tmux rename/cap behavior, including name-independent enumeration, but by itself does not test an old server left alive after its socket pathname is unlinked/reused. The direct private-socket probe above demonstrates that failure mode.
- `tests/runtime/supervisor.test.ts:851-935` uses real tmux to test pre-stop and polling unlink faults; good for the B reproduction. It does not test PID reuse (no deterministic safe way to force kernel PID reuse) or prove that every tmux platform reports diagnostics identically.
- `tests/runtime/supervisor.test.ts:1004-1031` tests live, null, and absent PID outcomes with synthetic adapter values. It cannot establish OS-level `kill(pid,0)` errno behavior; direct Node probes above covered live PID, `ESRCH`, and `EPERM` in this environment.
- The round-7 temporary scripts use real tmux sockets and real pane processes, but an in-memory `ConversationRuntimeStore` and adapter wiring rather than SQLite, a running server, or production OMP. They falsify the relevant tmux/supervisor branch, not persistence guarantees or provider-backed OMP writer semantics.
- Unit fixtures that directly return `null` from `tmuxServerIdentity()` do not model the distinction between an exited server and an unlinked pathname. The deliberate real socket-unlink run did.

## UNVERIFIED

- Production app launch and actual OMP provider/session lease behavior were not run; probes used `sleep` pane processes and no provider credits.
- SQLite write errors, metadata recovery, or a true backend-process restart were not exercised in round 7; in-memory stores only.
- The cross-server socket-unlink A attack used real private tmux and runtime code, but no production server with persisted owner rows. It did demonstrate untracked direct session loss across same-path server replacement and launch at cap 1 while old writer stayed alive.
- Kernel PID reuse was not induced; consequence is inferred from `process.kill(pid, 0)` semantics and code's explicit conservative `true` verdict for a live PID. The reused PID could be unrelated, so stop stays pending.
- Non-Linux behavior and tmux diagnostic string variants were not tested; observed host was Linux, Node 20.19.5, tmux 3.6.
- Whether unlinking a socket and spawning replacement server is an in-scope operational threat versus requiring explicit operator file mutation remains a policy question; the failing behavior itself is reproduced and must not be hidden behind that assumption.

## Commands run and observed results

- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-fix-a.mts` — renamed session included; launch refused `conflict_limit` at 2; direct untracked and `caw-` orphan refused `conflict_owner`; normal lifecycle succeeded.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-cross.mts` — direct session on private socket, unlink pathname, relaunch at `maxActive: 1`: new `$0` launched while old `$0` server and pane PIDs remained live.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-fix-b.mts` — unlinked live socket stayed `stopping`; dead pane with `ESRCH` stopped; invalid/live/unsignalable PID stayed pending; permission denial threw.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round7-retry-pid.mts` — same-conversation retry after recorded-session stop returned `conflict_owner`; `NaN`, `Infinity`, `1.5`, and unsafe integer PIDs stayed `stopping`.
- `node -e 'try { process.kill(1,0); console.log("kill(1,0)=success"); } catch (error) { console.log(`kill(1,0)=${error.code}`); }'` — `EPERM`.
- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'counts renamed sessions against maxActive|refuses stop when the recorded server is live but its socket pathname was unlinked|does not stop a live tmux server when its socket pathname disappears during polling|stops after the recorded private tmux server process exits|settles stop when the real pane PID exits and the tmux server vanishes|keeps stop pending when the socket is unreachable but pane process lives|keeps legacy rows without a pane PID pending when the socket is unreachable|settles stopped when recorded pane PID has exited and socket is unreachable'` — 8 passed, 47 skipped.
- `id -u && node -p 'process.version' && tmux -V` — uid 1000, Node `v20.19.5`, tmux `3.6`.
