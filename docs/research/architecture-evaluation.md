# Architecture evaluation: three candidate designs

The brief named three architectures and asked for an evaluation before committing.
This is that evaluation, written after the research and the proof of concept, with
the evidence each verdict rests on. The decision itself is ADR 0001.

## The three candidates

- **A. tmux + native OMP Collab + a workspace manager.** The app launches agents
  into tmux, discovers them through OMP's own local host registry, and hands the
  phone a room link.
- **B. OMP RPC / `rpc-ui` + a process supervisor + an explicit terminal handoff.**
  The app drives the agent over OMP's structured RPC transport and hands the
  terminal over by stopping and resuming.
- **C. tmux + a browser terminal + a structured monitoring adapter.** The phone
  gets an xterm.js terminal into the tmux session, plus a side channel that
  scrapes or wraps output into structured events.

## Evaluation

| Dimension | A | B | C |
| --- | --- | --- | --- |
| Live CLI continuity | **Best.** The agent is a normal OMP process; `tmux attach` reaches the same turn | **Fails.** No supported way to attach a TUI to a *running* RPC turn; continuity degrades to stop-then-resume | Good for typing, but the phone is driving a terminal, not an agent UI |
| Native session compatibility | **Best.** The journal is authoritative; the browser and the CLI share one history | Sessions persist, but the running turn is not shared | Same as A for persistence |
| Mobile user experience | **Good.** A chat UI over the native protocol, with tool cards and subagent panels | Requires building the whole surface; RPC is not a UI | **Worst.** A phone-sized terminal is the wrong default, and it is the one option the brief explicitly argued against |
| Implementation complexity | Moderate: launch, discover, link, supervise | High: a supervisor plus an RPC client plus an approval bridge | High: a terminal emulator, a resize/scroll model, and an event extractor |
| Upstream maintainability | Uses documented CLI and registry surfaces; failure mode is visible (a version check) | Uses a documented transport, but nothing adjacent is designed for external drivers | Depends on the shape of terminal output, which upstream never promised |
| Security | Rooms are E2E-encrypted and the relay is content-blind; the link is a scoped bearer credential | The whole agent surface is exposed to our own client, so every protection is ours to build | A remote terminal is exactly the unauthenticated-remote-execution shape the brief forbids |
| Reliability | One process, one owner; a browser or backend restart never ends a turn | Extra lifecycle boundary between the app and the turn in flight | Terminal fidelity bugs are notoriously hard to reason about |
| Approval handling | Native: the host asks, the guest answers | Must be reimplemented over RPC | Whatever the terminal does, which is nothing structured |
| Multi-session support | One tmux session per conversation, discovered and reconciled | Supervisor-managed processes; equivalent work | One tmux session per conversation, equivalent |
| Testability | Fakes for the registry and tmux layer; a real-agent suite with disposable tmux servers | A JSONL protocol is testable, but timing is not | Output scraping is the least testable option |

## What the proof of concept settled

Architecture A was not accepted on the strength of a table. These were observed on
this machine against OMP 18.12.2 before the decision was locked, and they are
recorded in `docs/research/proof-of-concept.md`:

1. A tmux-hosted OMP hosts itself over Collab (`relayConnected: true` in
   `omp collab list --json`).
2. A private relay replaces the hosted one; both `omp join` and a real browser
   guest drove the host agent through it.
3. A terminal attached to the *same* process the browser was driving.
4. **Closing the browser did not stop the agent**, and a fresh browser session
   adopted the same room without resubmitting anything.
5. Resuming an existing native session worked under a managed launch.
6. Two conversations ran simultaneously.
7. OMP does not reject a second writer on a live session: it **forks** the journal,
   which is why the app needs a lease probe rather than trusting the runtime to
   complain.

Point 4 is the one that decided it: the product's central promise is that the phone
is a controller and the agent outlives it, and only architecture A demonstrated
that end to end.

## Why B was rejected

Not on taste — on a missing capability. `docs/research/omp-rpc-sdk.md` established
that no supported path attaches a TUI to a running RPC turn, so "come home and pick
up the same turn in a terminal" is impossible under B. That is requirement one of
the brief, not a nice-to-have. B also asks us to rebuild the UI that Collab already
provides natively, which is work with no users.

B remains a sensible future adapter if a non-Collab transport is ever needed, and
the runtime is built so a second adapter could be added: the supervisor talks to
interfaces, not to tmux directly.

## Why C was rejected

Two independent reasons. It fails the brief's own instruction not to scrape ANSI
output when a structured transport exists, and a terminal emulator on a phone is
the wrong default for the primary interaction. C's honest use is as an *escape
hatch*, and we kept that: the attach card hands the owner a real `tmux attach`
command, which needs no emulator at all.

## Costs accepted with A

- **Upstream surface risk.** The registry JSON and the frame grammar are the parts
  we depend on. Mitigated by `scripts/compat-check.mjs`, a recorded baseline in
  `docs/research/omp-compatibility.md`, and an upgrade procedure that says to stop
  if the probe fails.
- **The published relay is not self-hostable**, so we run our own. See ADR 0002,
  including the two-listener split and the honest residual about local processes.
- **A bearer credential in a URL.** Mitigated by fragment-only handling, an
  in-memory-only handoff, `no-referrer`, and never logging a link.
