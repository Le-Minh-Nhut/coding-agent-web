# Reconciliation verification against real OMP processes

**Result:** reconciliation behavior passed all six opt-in scenarios on this machine. One qualification matters: **UNVERIFIED — scenario 2 did not preserve an OMP-written journal.** OMP published a live session ID at startup, but with no prompt it had not written a journal. Test seeded a one-line OMP-shaped session header so supervisor could exercise its readable-history branch. This proves that branch and subsequent start guard with a surviving file; it does not prove a native journal survives agent death. No model prompt was sent.

Suite uses private tmux server `-L caw-reconcile-<pid>-<random>`, a fresh local relay for real Collab hosts, and exact recorded tmux IDs for cleanup. Registry failure is injected by wrapping `listHosts`; foreign lease is a test-process Linux abstract socket using the real session's lease name. For external-room, one real host is launched by fixture supervisor, then observed by a different fresh supervisor and a store with no tmux launch record. This setup intentionally models “not managed by this supervisor”; it is not a hand-started OMP TUI.

## Scenarios

### 1. Adopt live managed agent — PASS

**What:** Start OMP through supervisor with no prompt; clear stored host identity; construct fresh supervisor on same store; reconcile against real tmux, registry, and lease probe.

**Observed:**

```text
[reconcile-verification] adopt {"report":{"adopted":1,"external":0,"stopped":0,"unknown":0,"registered":1},"state":"idle","hostInstanceId":"50ae73c9349c7f78","hostGeneration":1}
```

Fresh supervisor restored registry identity; process stayed live; report did not count a stop.

### 2. Dead process, surviving history, restart allowed — PARTIAL PASS; native journal UNVERIFIED

**What:** Start agent with no prompt, write minimal OMP-shaped session header under fixture session bucket (OMP itself did not persist a startup-only journal), kill recorded tmux ID, wait for tmux exit, lease release, and registry removal; reconcile with fresh supervisor; call `start()` again.

**Observed:**

```text
[reconcile-verification] dead-history {"report":{"adopted":0,"external":0,"stopped":1,"unknown":0,"registered":0},"state":"stopped","statusDetail":"The agent process is no longer running; its conversation history is intact.","journalExists":true,"retryStartAllowed":true,"retryTmuxSessionId":"$0","journalSeededByTest":true}
```

Supervisor reported `stopped`, preserved readable-file classification, and allowed another start. **UNVERIFIED:** file was seeded by test, not emitted by OMP. With no prompts, no real persisted OMP journal survived to test; do not count native-journal persistence as proven.

### 3. Never kill an unrecorded tmux session — PASS

**What:** While a real agent runs in private server, start a separate `sleep 300` session by direct `tmux new-session` using a `caw-` label. Reconcile store containing only managed agent. Observe unrecorded session by its captured `$N`; track every supervisor adapter kill call.

**Observed:**

```text
[reconcile-verification] unrecorded {"report":{"adopted":1,"external":0,"stopped":0,"unknown":0,"registered":1},"unrecordedSessionId":"$1","unrecordedAlive":true,"killCallsDuringReconcile":[]}
```

Unrecorded session remained alive; no kill was issued during reconcile.

### 4. Foreign live writer is unknown — PASS (lease holder arranged by test)

**What:** Start real OMP host and confirm lease probe detects its writer. Kill only its recorded tmux session; wait for real host lease and registry entry to disappear; bind same Linux abstract socket in test process. Store real native session ID; reconcile with actual empty registry. No start call is made.

**Observed:**

```text
[reconcile-verification] foreign-writer {"report":{"adopted":0,"external":0,"stopped":0,"unknown":1,"registered":0},"state":"unknown","statusDetail":"Another process is writing this session, but it is not managed here.","leaseLive":true,"launchCallsBeforeAndAfterReconcile":[1,1],"leaseHolder":"test process abstract socket","registryRowAbsent":true,"journalSeededByTest":true}
```

The real OMP process was not the final lease holder: test bound exact derived socket after killing OMP. No launch attempt occurred during reconcile. Journal header also came from test; unknown lease branch does not depend on it.

### 5. Unreadable registry does not become stopped — PASS (failure injected)

**What:** Keep real managed agent alive; replace only `listHosts` with function throwing `injected unreadable registry`; reconcile with fresh supervisor.

**Observed:**

```text
[reconcile-verification] registry-failure {"report":{"adopted":0,"external":0,"stopped":0,"unknown":1,"registered":0},"state":"unknown","statusDetail":"The OMP Collab registry could not be read, so the live state is unknown.","killCallsDuringReconcile":[],"tmuxAlive":true}
```

No stop counted and no kill occurred. Registry read failure was injected, not a filesystem-permission failure.

### 6. Room absent from supervisor's launch record is external — PASS (fresh supervisor arrangement)

**What:** Start real agent through fixture supervisor; construct another supervisor with store containing same live native session ID but no tmux session ID; reconcile, then call `stop()` on that external conversation.

**Observed:**

```text
[reconcile-verification] external-room {"report":{"adopted":0,"external":1,"stopped":0,"unknown":0,"registered":0},"ownership":"external","state":"idle","statusDetail":"Started outside this app; it can be watched, and its lifecycle is not managed here.","stopRefused":true,"killCalls":[],"journalSeededByTest":true}
```

Room came from real OMP registry and was not launched by the supervisor under test. Stop refused; no kill occurred. Test seeded OMP-shaped history only to provide a native path; external classification depends on live registry row, not that file.

## Commands and observed tails

Opt-in suite (final run):

```sh
CAW_COMPAT=1 npx vitest run tests/compat
```

```text
✓ tests/compat/omp-lifecycle.test.ts (2 tests) 21279ms
✓ tests/compat/reconciliation.test.ts (6 tests) 28759ms
Test Files  2 passed (2)
     Tests  8 passed (8)
Start at  02:08:19
Duration  29.18s (transform 166ms, setup 0ms, collect 300ms, tests 50.04s, environment 0ms, prepare 159ms)
```

Compatibility tests skipped without opt-in:

```sh
npx vitest run tests/compat
```

```text
↓ tests/compat/omp-lifecycle.test.ts (2 tests | 2 skipped)
↓ tests/compat/reconciliation.test.ts (6 tests | 6 skipped)
Test Files  2 skipped (2)
     Tests  8 skipped (8)
Start at  02:10:16
Duration  425ms (transform 166ms, setup 0ms, collect 301ms, tests 0ms, environment 0ms, prepare 185ms)
```

Full default suite (final run):

```sh
npx vitest run
```

```text
Test Files  30 passed | 2 skipped (32)
     Tests  192 passed | 8 skipped (200)
Start at  02:08:58
Duration  2.15s (transform 2.06s, setup 0ms, collect 6.56s, tests 6.46s, environment 1.51s, prepare 3.28s)
```
The first full-suite attempt during parallel repository work failed in unrelated server route registration with `FastifyError: Method 'HEAD' already declared for route '/guest'` at `apps/server/src/static-web.ts:278`. A later full run of the same command passed as shown above; this audit does not claim the earlier failure did not occur.

Private tmux socket check after final opt-in run:

```sh
find /tmp/tmux-*/ -maxdepth 1 -type s -name 'caw-reconcile-*' -print
printf 'socket_count='
find /tmp/tmux-*/ -maxdepth 1 -type s -name 'caw-reconcile-*' -print | wc -l
```

```text
socket_count=0
```

No suite-named tmux socket remained. Cleanup addresses only this run's unique server and its recorded `$N` values.
