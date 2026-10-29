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
- **A missing pane is not a dead process either.** The same corroboration applies
  wherever a pane is simply not found: the stop preflight and the startup publish
  wait both check the recorded pane PID before concluding "gone". A renamed or
  racing session leaves the verdict `unknown` (stop refuses; startup keeps
  waiting) instead of writing `stopped`/`agent.exited` for a process nobody
  observed exiting.
- **A registry row is not proof of ownership.** When a live managed pane exists,
  it is paired with a host only through the lineage check (`matchPublishedHost`);
  a row that merely carries the recorded `nativeSessionId` while belonging to a
  different process keeps the conversation `unknown` rather than `managed`. The
  exception is a conversation with no managed pane at all, where the row is the
  truth and the ownership is `external`. A registry row with no PID cannot prove
  anything either way, so it takes no part in the match instead of poisoning it
  for every conversation.
- **A failed journal load is not permanent.** Recovery is byte-accurate (offsets
  come from the file's bytes, never from a decoded string, so an invalid byte
  cannot push a "restored" delimiter past the real end), the evidence file is
  checked with `lstat` so a FIFO cannot block the load, and a load that fails
  still fails — but the next call retries, so a human repair takes effect without
  a restart. A refused append rolls the file back to the offset it had before the
  write; only an offset actually read from the file is ever truncated, and if the
  rollback itself fails the store refuses further writes rather than appending
  onto a torn journal.
- **A missing pane PID is backfilled, not guessed.** When a launch's follow-up
  listing failed, the row holds no pane PID and nothing ever filled it in, which
  left the conversation unstoppable and permanently unknown. Refresh takes the
  PID from the enumerated session only after that session has been qualified by
  both its id and its server lifetime.

## Project deletion

`DELETE /api/projects/:id` observes each conversation's runtime (not its stored
state) and refuses with `conflict_owner` while any of them is running, in
progress, or cannot be verified as stopped; a launch that is still in flight
(its process may exist but not be recorded yet) counts as in progress, as does an
external session whose writer is still live. Rows that never had a process
launched for them are not blocking. It never kills an agent and never removes
files. Once every conversation is verified stopped, their rows are removed with
the project, so a folder re-added later can offer its native sessions again
rather than hiding them behind a row that points at a deleted project.

The removal is one journal record — `project-cascade-delete`, carrying the
project id and every conversation id it drops — so the whole cascade is
all-or-nothing on replay: a torn write is a truncated line at EOF, never "some
children gone, project still here". A file written before that record existed
still replays, because the older `conversation-delete` and `project-delete` rows
are still honored. The `conversationIds` in that record are trusted: a
hand-edited journal could name another project's conversation and drop it on
replay. The blast radius is metadata only — the native session file on disk is
never touched, so the conversation can be re-added from its folder — and the
journal is a local, owner-writable file, so this is accepted rather than
defended against. The store re-verifies each row at delete time and drops only
those that still pass the gate, so a conversation restarted between the
observation and the delete is refused rather than deleted out from under its new
process. A row passes when it reads process-free *or* when its lifecycle epoch
still equals the one the observer verified — that is how a cached `idle`/`running`
label stops blocking a delete after the machine was freshly and positively
observed dead. Both halves are evaluated in the queued section, alongside the
launch reservation described below, so the verdict and the mutation cannot
interleave with a launch.

The epoch is the store-owned `lifecycleEpoch` on the row: the store bumps it
whenever a patch changes a lifecycle field (state, ownership, tmux identity,
host identity), so the guarantee does not depend on callers remembering to stamp
it. Observations are committed through `updateConversationIfCurrent`, which
compares the caller's epoch against the stored row *inside the same queued
section* as the write and drops the patch when a newer life took the row.

A row whose launch is reserved but has not yet recorded its process reads exactly
like a never-launched row (`starting`, no identity), so the re-read alone cannot
tell them apart. That reservation is therefore **owned by the store**, not by the
supervisor: `reserveLaunch` (taken by `start()` before it calls any adapter) and
the queued delete are both sections of the store's **single** operation queue, so
exactly one of them commits first and each sees the other:

| Order | What happens |
| --- | --- |
| reserve, then delete | the delete's queued section finds the reservation and refuses with `has_conversations`; nothing is written |
| delete, then reserve | the row is already gone, `reserveLaunch` returns `false`, and `start()` throws `agent_not_running` **before any adapter call** — no process exists, so there is nothing to strand |

Both orderings are deterministic, and there is no third: with one queue there is
no window in which the delete's check has run and the commit has not, so the
earlier shape (a reservation registered under a supervisor-local mutex, re-checked
just before the write syscall) is gone, and with it the one-syscall window it
could not close. The equivalent guarantee on the write side is that the
reservation is released on every exit of `start()` — the early not-found throw, a
refusal, a failed launch, an exception from the journal — with one deliberate
exception, below.

`isLaunchReserved` is a non-queued read, used by observers (the DELETE route's
own pre-check, `supervisor.isLaunching`). A stale answer there is harmless: it can
only make the caller ask a question that the authoritative queued check — inside
`deleteProject` — answers for real.

### A retained launch reservation

If a launch created a process it could not record *and* could not kill (the
guarded kill failed, or the pane process could not be confirmed gone), the
reservation is deliberately **retained**: releasing it would let a retry launch a
second writer onto a session something is already writing. Retention is
conversation-scoped in memory and has no in-process release path — `stop` does
not clear it, a retry is refused by the same key, and the DELETE above refuses
while it is held. So a conversation in this state stays unstartable and
undeletable until the process is accounted for and the backend restarts (the
reservation set is in-memory; `reconcile` then re-reads the machine). Nothing
kills the process automatically, by design: killing a process we could not
attribute is exactly the destructive guess this codebase refuses to make. This is
a known, operator-recoverable state, not a bug: the row records the tmux identity
and server identity it could not record, and the `agent.launch_unrecorded` event
carries them.
A `conversation-delete` or `project-cascade-delete` row also drops the affected
conversations' event and command rows on replay — they have no parent left — so
the log does not accumulate orphans.

## Explicitly refused behaviours

- Relaunching a prompt that was interrupted by a machine reboot. We cannot know
  whether its tool calls had side effects, so recovery is a user action, not an
  automatic one.
- "Resuming" a transcript and presenting it as reconnecting to the old process.
  A resumed transcript is a new writer on an old history, and the UI says so.
- Reaping processes by name pattern. We only ever kill `$N` values we recorded.
