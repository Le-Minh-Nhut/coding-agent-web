# Round 6 verification of P0 fixes

**Verdict — both are not genuinely closed.** A is **PARTIALLY FIXED**: the exact failed-write/failed-kill orphan is blocked after a new supervisor starts, but a real app-launched session renamed out of the `caw-` prefix disappears from enumeration; with `maxActive: 2`, a third live session was then launched. B is **PARTIALLY FIXED**: the identity bracket rejects a dead stranger at reused `$0`, and a genuinely vanished server settles to `stopped`; however, `null` can also mean the configured socket path became unreachable while its tmux server and agent remain alive. A real private-socket reproduction returned `stopped` in that case. **Most serious remaining hole:** false `stopped` can enable a retry while the original writer still runs, directly risking a second writer.

## A. Orphan ownership across restart — PARTIALLY FIXED

**Claim.** Every launch refuses with `conflict_owner` while a live managed tmux session lacks an owner, including after backend restart; the refusal prevents cap overrun and users can recover safely.

**What code does.** `start()` enters `withLaunchLock()` at `packages/runtime/src/supervisor.ts:347-355`. Within it, after reading hosts and tmux sessions, it loads all rows and calls `untrackedLiveSessions()` at `:376-402`; that check is not keyed to the requested conversation or retry. `untrackedLiveSessions()` regards an alive session as accounted for only when a `managed` row matches both session ID and server identity (`:89-93`). The ordinary cap separately counts every alive enumerated session, without filtering row state (`:332-344,419-423`). Enumeration is specifically the `caw-` namespace: `packages/omp-adapter/src/tmux.ts:158-161`.

**What I tried.**

- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-launch.mts` — real tmux 3.6 on a unique private socket and real `DefaultTmuxService`; injected store-write and guarded-kill failures; created a new supervisor and store wrapper over the same store data; tried failed-conversation retry plus two other conversations with `maxActive: 2`. Output:

  ```json
  {"restartSequence":{"storeWriteFailed":true,"guardedKillFailed":true,"newSupervisor":true,"orphanId":"$0","orphanAlive":true,"maxActive":2,"retryAndTwoNewLaunches":["conflict_owner","conflict_owner","conflict_owner"],"totalTmuxSessions":1,"launchCalls":1},"recovery":{"exactOrphanKilledByRecordedIdAndIdentity":true,"nextLaunch":"launched","liveSessionsAfterRecovery":1},"ownerScanCases":[{"description":"stopped row with exact live session identity","code":"conflict_limit","launchCalls":0},{"description":"row records same id but old tmux identity","code":"conflict_owner","launchCalls":0},{"description":"row has id but never recorded tmux identity","code":"conflict_owner","launchCalls":0}]}
  ```

  This reproduces the audit’s failure sequence: after restart, the surviving `$0` was visible and all three attempts were refused; only one launch/live process remained. Recovery in this probe killed the orphan by its exact ID and recorded identity, after which another launch succeeded. **Limit:** store was an in-memory port implementation, and guarded-kill failure was injected; this does not establish SQLite failure behavior or run production OMP.

- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-owner-cases.mts` — real sessions on two different private sockets. `$0` was reused, with different server identities. With the current socket’s live `$0`, a row recording the other socket identity was refused `conflict_owner`; a row with no recorded identity was also refused `conflict_owner`. A stopped row recording the exact live `$0` identity was not deemed “untracked”, but launch returned `conflict_limit`, `launchCalls: 0` at cap 1. This is safe for the cap: stale `stopped`/`unknown` state does not hide an alive session from the live-session count.

- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'counts a live process even when its stored state is unknown'` — passed, `1 passed`; this exercises an exact-identity live row whose state is `unknown` and confirms it counts against the cap.

- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-renamed-cap.mts` — real private tmux; launched two `caw-` sessions, recorded both, renamed `$0` to `renamed-away-from-managed-prefix`, then attempted a third launch with `maxActive: 2`. Output:

  ```json
  {"maxActive":2,"beforeManagedIds":["$1"],"twoSessionsInitiallyLive":true,"hiddenLiveId":"$0","hiddenRenamed":"renamed-away-from-managed-prefix","launchResult":"launched","sessionsAfterLaunch":["$2 caw-third 0","$1 caw-visible-owner 0","$0 renamed-away-from-managed-prefix 0"],"liveSessionsAfterLaunch":3,"exceededMaxActive":true}
  ```

  **This is the remaining A hole.** The row still recorded the live managed `$0` with its original identity, but `listManaged()` filtered it out after rename. `untrackedLiveSessions()` cannot guard a session it never receives, and the cap also counts only this enumeration. A new writer was admitted at cap and three live sessions resulted.

**Explicit owner-scan answers.** A live session matching a `stopped` or `unknown` row with the same ID and identity is classified as accounted for, not untracked; the cap still counts it from tmux’s alive list, so the reproduced attempt at a full cap refused with `conflict_limit`. A live session reusing the same `$N` on a different server identity, or a row that never recorded identity, does **not** match the ownership predicate and is refused `conflict_owner` when that session is in the enumerated managed list. An unrelated socket is not enumerated by this supervisor: production binds one app-owned socket (`apps/server/src/server.ts:301-303`). That socket boundary does not protect a renamed session on the app’s own server.

**Safety and recovery.** The guard is fail-closed and useful for the tested orphan: it blocks all launch requests, rather than only the retry, and therefore prevents this exact orphan from consuming an invisible slot. It is not a complete guarantee because the name-filter bypass above defeats it. There is no dedicated orphan-adoption/resolve operation in the supervisor interface; `stop()` requires a recorded session ID (`packages/runtime/src/supervisor.ts:612-627`), and reconciliation only visits existing rows (`:704-764`). Honest accounting would require recording the live session's exact ID and server identity as a managed row; the owner-scan probe shows a matching stopped row is no longer untracked, but the session still counts toward `maxActive` (`conflict_limit` at cap 1). No user-facing path for that repair was found. The tested manual recovery instead killed the orphan by its exact ID and expected identity, then launched successfully; this does not clear the block while the process runs. It is safe only when the operator first verifies that ID and identity belong to the orphan, and does not use a name/glob. Without manual exact-session cleanup or a successful metadata repair, an untracked orphan can leave launches blocked indefinitely.

**What remains.** Enumerate/cap-count all live sessions on the app-owned server, independent of mutable display name, and provide a safe recovery path for a rowless orphan. The current tested restart fix closes only the `caw-`-visible orphan case.

## B. Stop attribution and confirmed-gone handling — PARTIALLY FIXED

**Claim.** Stop cannot mistake a dead stranger at a reused ID for our process; it confirms both a genuinely gone server and normal process exit, without treating permissions or probe failure as absence.

**What code does.** The pre-kill guard reads identity at `packages/runtime/src/supervisor.ts:628-644`; `null` immediately writes `agent.stopped` and state `stopped` at `:629-640`. The poll reads identity before the by-ID probe, rejects unknown/mismatch, checks the returned row identity, and reads identity again at `:659-680`. Poll `null` also writes `stopped` at `:662-670`. `DefaultTmuxService.serverIdentity()` returns `null` for diagnostics classified as no-server, but throws for permission and other errors (`packages/omp-adapter/src/tmux.ts:8-35,96-115`). Its no-server patterns include `error connecting ... no such file or directory` (`:8-10,32-35`).

**What I tried.**

- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'blocks cap overrun after backend restart with a surviving private-tmux process|does not confirm stop after real private-tmux restart between identity and session probes'` — both passed; the restart/cap test uses real private tmux and injected store/kill failures, and the stop race test uses real private tmux with an interleaving that replaces `$0` by a dead stranger.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-probe.mts` — real private tmux 3.6. Both stop directions reproduced:

  ```json
  {"genuineStop":{"state":"stopped","stopEvent":true,"serverIdentityAfterStop":null},"restartedDeadStranger":{"restarted":true,"oldId":"$0","reusedId":"$0","strangerDead":true,"identityChanged":true,"resultState":"stopping","stopEvent":false}}
  ```

  The genuine stop used real `tmux.kill`; removal of the last session made the server identity `null`, and the stop confirmed. The restarted-stranger interleaving killed/recreated the private tmux server and created a dead `remain-on-exit` stranger at the reused `$0`; the supervisor stayed `stopping` and emitted no `agent.stopped`. The interleaving substituted a no-op guarded kill so the poll exercised the race rather than killing the replacement.

- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-prekill-gone.mts` — killed the private server before calling `stop()`. Output: `{"exitedServerIdentity":null,"state":"stopped","stoppedEvent":true,"priorSessionId":"$0"}`. This confirms the pre-kill gone-server branch. The previous command confirms the poll-side gone-server branch after a real successful stop.

- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-stop-permission.mts` — real tmux session, then denied access to its private socket directory. Output: `{"deniedProbeProducedError":true,"probeError":"AdapterError: Could not read the tmux server identity: error connecting to ... (Permission denied)","stopError":"RuntimeError: The tmux server identity could not be verified, so this process cannot be safely stopped.","returnedState":"running","stoppedEvent":false,"originalSessionStillAlive":true}`. A denied probe did not become `null` and did not confirm stop. The probe restored directory permissions and cleaned up the private server it created.

- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-probe.mts` also tested a row recorded against socket A while the supervisor adapter was bound to a distinct, absent private socket B. Output for this case: `{"recordedSocketDiffersFromConfigured":true,"currentSocketIdentity":null,"stopState":"stopped","oldSocketSessionStillAlive":true,"killCalls":0}`. **Yes, stop can be confirmed against the wrong socket’s absence.** The identity value includes the socket path when a server answers, but the early `null` branch does not compare or otherwise bind absence to the row’s recorded socket.

- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-unlinked.mts` — strongest false-absence reproduction. Launched a real private tmux session, unlinked only its socket pathname while leaving the server running, and called `stop()`. Output: `{"socketUnlinkedWhileServerRunning":true,"probe":{"identity":null},"returnedState":"stopped","stoppedEvent":true,"panePidStillAlive":true,"serverPidStillAlive":true,...}`. Thus an ENOENT-style no-server diagnostic can mean “socket path disappeared”, not “our process exited”. This falsifies the unconditional inference at both null branches.

- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'keeps waiting when server identity probe fails|does not confirm stop when the session probe could not run|treats a tmux server that disappeared entirely as a confirmed stop|does not report stopped when tmux restarts between identity and session reads|refuses stop when recorded tmux server identity differs'` — `5 passed`. These support the expected branches, but the “server disappeared” unit fixture supplies `null` directly and cannot distinguish true server exit from a missing socket pathname.

**Explicit failure/identity answers.** Permission denial is an error, not absence: reproduced against a real private socket; stop remained `running`. A thrown identity probe maps to `"unknown"` and loops/refuses rather than confirming (`supervisor.ts:628,659-660`); a failed session lookup is skipped (`:675-676`), with unit evidence above. But `null` is not reliable proof that the app’s old process stopped: an unlinked socket produced `null` while its pane/server were alive, and a different absent socket produced false `stopped` against a still-live session on socket A. The dead-stranger-at-reused-ID case is fixed for a **responding** replacement server: matching before/after identity plus row identity prevents confirmation.

**What remains.** `null` currently conflates “server exited” and “the configured socket pathname cannot reach a still-running server”; the adapter intentionally maps missing socket/ENOENT diagnostics to `null`. Stop must not claim process exit from that unqualified result. The non-null identity bracket still cannot make separate tmux commands atomic, as its comment notes at `supervisor.ts:651-655`.

## Non-falsifiable tests

- `tests/runtime/supervisor.test.ts:284-340` now exercises restart recovery with a real private tmux process, but its store is the in-memory test world and kill failure is injected. Its sessions keep the `caw-` prefix, so it cannot falsify the renamed-session scan/cap bypass.
- `tests/runtime/supervisor.test.ts:811-832` feeds `null` as the entire gone-server fact; it cannot falsify a live server whose socket path was unlinked. The real unlink probe above did falsify that inference.
- `tests/runtime/supervisor.test.ts:783-809` checks the dead replacement row and changed identity; it does not test absence on a second socket. The real two-socket probe above returned `stopped` while the recorded socket’s process remained alive.
- `tests/runtime/supervisor.test.ts:846-880` fakes probe failures; it cannot establish kernel permission-denial classification. The local permission probe above did exercise a real denied private-socket path.
- The existing in-memory cap cases for `unknown`/`stopped` row state prove that exact-ID live sessions count, not that the real name-filtered adapter enumerates every process it previously launched.

## UNVERIFIED

- Real OMP launch, journal lease, and provider-backed duplicate-writer behavior were not run; no provider-credit compatibility suite was invoked. The tmux probes used `sleep` panes and runtime adapter/store seams.
- Production SQLite failure and recovery across an actual server process restart were not exercised; A’s injected failed-write sequence used a Map-backed store, plus a fresh supervisor/store wrapper over shared data.
- No real application server was started with a stale metadata row from a prior `stateDir` and a different configured socket. The two-socket attack exercised the same supervisor behavior with real tmux services; the socket-unlink attack demonstrated false confirmation without changing adapters or identities across different servers.
- Tmux diagnostic variants beyond the observed local `Permission denied` and missing/unlinked-path behavior were not tested across other tmux versions/platforms.

## Commands run and observed results

- `tmux -V && node --version` → `tmux 3.6`, `v20.19.5`.
- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'blocks cap overrun after backend restart with a surviving private-tmux process|does not confirm stop after real private-tmux restart between identity and session probes'` → 2 passed.
- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'counts a live process even when its stored state is unknown'` → 1 passed.
- `pnpm exec vitest run tests/runtime/supervisor.test.ts -t 'keeps waiting when server identity probe fails|does not confirm stop when the session probe could not run|treats a tmux server that disappeared entirely as a confirmed stop|does not report stopped when tmux restarts between identity and session reads|refuses stop when recorded tmux server identity differs'` → 5 passed.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-launch.mts` → failed write + failed guarded kill left live `$0`; new supervisor refused retry and two unrelated launches with `conflict_owner`; after exact-ID/identity cleanup, a new launch succeeded.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-owner-cases.mts` → same `$0` across two sockets had different identities; stale/missing identity refused `conflict_owner`; stopped row with matching identity counted and refused at full cap.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-renamed-cap.mts` → renamed live session omitted from managed list; launch succeeded at cap 2; 3 live sessions remained.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-probe.mts` → real genuine stop became `stopped`; dead stranger at reused `$0` stayed `stopping`; absent wrong socket returned `stopped` while socket A session lived.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-prekill-gone.mts` → pre-kill confirmed-gone server yielded `stopped`.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-stop-permission.mts` → permission-denied identity probe threw; no stopped event; session remained alive.
- `pnpm exec tsx /home/heheboiz/.cache/caw-round6-unlinked.mts` → identity returned `null`; stop returned `stopped`; pane and tmux server PIDs remained alive.
