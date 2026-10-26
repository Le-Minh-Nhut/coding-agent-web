# Conversation ownership and reconciliation

The invariant this document protects:

> **One native OMP session has at most one writer, and the app never creates a
> second one by accident.**

## Identity model

A conversation carries three identities, and they are not interchangeable:

| Identity | Lifetime | Source of truth |
| --- | --- | --- |
| `conversation.id` | forever (app) | our metadata store |
| `nativeSessionId` | the session's life (UUIDv7) | the journal header at `~/.omp/agent/sessions/<bucket>/<timestamp>_<id>.jsonl` |
| `tmuxSessionId` (`$N`) | the process's life | app's private tmux server (`<stateDir>/tmux.sock`); `tmux new-session -P -F '#{session_id}'` |

`tmuxSessionName` is a **display label only**. Every action addresses the tmux
session by `$N` bound to `tmuxServerIdentity` (`#{socket_path}:#{start_time}:#{pid}`)
on the app's private tmux socket (`<stateDir>/tmux.sock`). Names can be reused and
`$N` IDs restart at `$0` across tmux server lifetimes; the server PID supports
process-exit corroboration when the socket is unreachable.

`hostInstanceId` and `hostGeneration` describe the *current room*. They change
whenever the process starts a new room (for example on a session switch), which
is why a link is always minted against a generation observed immediately before,
and a `stale_generation` answer means "list again" rather than "retry blindly".

## State machine

```
                launch requested
                       │
                       ▼
                  ┌─────────┐   registry host visible, turn in flight
                  │ starting├──────────────────────────────►┌────────┐
                  └────┬────┘                               │running │
   registry visible,    │                                   └───┬────┘
   no turn in flight    │                                       │ turn ends (busy=false)
                       ▼                                       ▼
                  ┌─────────┐   host raises a question    ┌─────────┐
                  │  idle   ├────────────────────────────►│awaiting │
                  └────┬────┘◄────────────────────────────┤ _input  │
                       │        question answered         └─────────┘
     stop requested    │
                       ▼
                  ┌─────────┐  process gone, journal still readable
                  │stopping ├──────────────────────────────►┌────────┐
                  └─────────┘                               │stopped │
                                                            └───┬────┘
                                      journal unreadable OR      │
                                      launch failed              │
                                                                ▼
                                                           ┌────────┐
                                                           │ error  │
                                                           └────────┘

   registry unreadable at any point ──────────────────────►┌─────────┐
                                                           │ unknown │
                                                           └─────────┘
```

Rules:

- `unknown` is a real answer, not a bug. If the registry directory cannot be
  read (missing is "no hosts"; unreadable is an error), we report `unknown`
  rather than guessing `stopped`.
- `busy === false` means **no turn is in flight**. It does not mean the session
  has settled: OMP reads `false` during scheduling pauses (queued follow-ups,
  async-job waits, compaction). The UI therefore never turns `busy === false`
  into a "completed" claim.
- `busy === null` (host older than the field) is rendered as unknown, never idle.
- A backend restart never transitions anything to `stopped`. Reconciliation runs
  first and only reports what it observes.

## Launch decision procedure

Before launching anything for conversation *C*:

1. Read *C*'s `nativeSessionId` (if any) and probe its writer lease
   (`SessionLeaseProbe.isLive`).
2. If the lease is held **and** a Collab host exists for that session, do not
   launch. Attach the user to the existing host.
3. If the lease is held but no registry entry is visible, refuse with
   `conflict_owner`: some other process (possibly a hand-started TUI) owns the
   session, and forking it silently is exactly the failure this guard prevents.
4. If the lease is free and the conversation has no managed tmux session, launch.
5. If a managed tmux session already exists for *C*, never launch a second one;
   reuse it.

The lease probe returns `unknown` for a session id whose lease name cannot be
derived safely (OMP hashes non-token ids), and `unknown` blocks the launch with
`conflict_owner` rather than proceeding.

## Reconciliation after a backend restart

The backend's memory is a cache; the machine is the truth. On boot, and after any
error that invalidates our view:

1. **List our tmux sessions** (`TmuxService.listManaged()`), querying the app's
   private socket (`<stateDir>/tmux.sock`) and matching `tmuxServerIdentity`.
2. **List Collab hosts** (`omp collab list --json`). If this throws, mark every
   affected conversation `unknown` and continue — a registry failure must not
   cascade into destructive assumptions.
3. **Intersect.**
   - Conversation has a managed tmux session and its host row exists → adopt the
     host row (`hostInstanceId`, `hostGeneration`, `state` from `busy`/`inputRequired`).
   - Conversation has a live managed tmux process but no positively matched host
     row → report `unknown` until OMP publishes the room. Do not mint a link;
     there is no verified room, and do not imply the agent is idle.
   - Conversation has a host row but no managed tmux session → mark `external`.
     This is a session someone started by hand; we may attach a viewer, but we
     must never claim to own its lifecycle.
4. **Probe leases** for every known native session id, so the UI can distinguish
   "saved transcript" from "actually running".
5. **Prune.** A stored `tmuxSessionId` that no longer exists becomes `stopped`
   (journal readable) or `error` (journal missing).

### Process ownership and stop corroboration

Two inferences are forbidden:

- **A display name is not identity.** tmux sessions are enumerated on the app's
  private socket, so every session is ours regardless of its name. Prefix filtering
  made renamed live sessions invisible to ownership accounting and the cap.
- **An unreachable socket is not a dead process.** `serverIdentity()` returning
  `null` means the configured path cannot reach the server. A live server whose
  socket pathname was unlinked still reports `null`. The runtime corroborates with
  the recorded pane PID: `ESRCH` confirms that agent process exited; live,
  permission-denied, invalid, or legacy-null PID stays unknown and cannot settle
  stop. PID reuse can delay a valid stop, but only in the safe direction.

## Explicitly refused behaviours

- Relaunching a prompt that was interrupted by a machine reboot. We cannot know
  whether its tool calls had side effects, so recovery is a user action, not an
  automatic one.
- "Resuming" a transcript and presenting it as reconnecting to the old process.
  A resumed transcript is a new writer on an old history, and the UI says so.
- Reaping processes by name pattern. We only ever kill `$N` values we recorded.
