# Recovery

Recovery is about finding out what is actually true on the machine before
changing anything. Every step here observes first.

## The model

| Fact | How to check | What it means |
| --- | --- | --- |
| The agent process exists | `tmux -S ~/.local/state/coding-agent-web/tmux.sock list-sessions -F '#{session_id} #{session_name}'` | something is running; our names are prefixed `caw-` |
| It is hosting a room | `omp collab list --json` | the registry row is the only proof a room exists |
| The session is being written | a lease socket in `/proc/net/unix` | some process owns that journal **right now** |
| The history exists | a journal file under `~/.omp/agent/sessions/<bucket>/` | the conversation is recoverable as a transcript |

A saved transcript is **not** a running agent. If the lease is gone and the
registry has no row, nothing is running, no matter how recent the journal is.

## The backend restarted / crashed

The agent is unaffected: it lives in tmux, not in the web process. On boot the
server reconciles from the machine and adopts what it finds
(`docs/architecture/session-lifecycle.md`). Expected outcome:

- conversations whose tmux session is alive come back as `running`/`idle`;
- conversations whose process is gone come back as `stopped` (journal readable)
  or `error` (journal missing);
- if the Collab registry could not be read, they come back as `unknown` — that
  is deliberate; the app refuses to guess.

Check the evidence yourself:

```bash
systemctl --user status coding-agent-web
journalctl --user -u coding-agent-web -n 100
tmux -S ~/.local/state/coding-agent-web/tmux.sock list-sessions -F '#{session_id} #{session_name} #{session_created}'
omp collab list
```

## The laptop rebooted

Processes are gone; journals are not. The app will show those conversations as
`stopped` with an explicit recovery action. **Prompts that were interrupted are
not replayed automatically** — an interrupted turn may have run tools with side
effects, so replaying it is your decision, not the app's.

To inspect what the interrupted turn actually did before deciding:

```bash
# the newest journals for a project directory, newest last
ls -lt ~/.omp/agent/sessions/<bucket>/ | head
# or let OMP show you the session and its unfinished work
omp --restore ~/.omp/agent/sessions/<bucket>/<file>.jsonl
```

`--restore` resumes the session *and* the unfinished turn with its subagents. Use
it from a terminal when you want the agent to carry on; use the app's Resume when
you want the history back without immediately resuming work.

## A conversation shows `error`

The process is gone and we could not read its journal. Either the journal was
moved/deleted, or the path we recorded points somewhere that no longer exists.

```bash
ls -la ~/.omp/agent/sessions/                 # buckets by working directory
omp --resume                                  # picker: does the session still exist?
```

If the session exists, start a fresh conversation and resume it by id — the app
will adopt the existing journal rather than creating a new one.

## `conflict_owner` — the app refuses to start an agent

This is the guard working. Something already writes that session: another app
conversation, or a hand-started `omp` in a terminal.

```bash
omp collab list                      # is a room live for it?
tmux -S ~/.local/state/coding-agent-web/tmux.sock list-sessions | grep caw-       # is it one of ours?
```

Choose: adopt the existing one (open the live conversation in the app), or stop
it deliberately (`tmux -S ~/.local/state/coding-agent-web/tmux.sock attach -t <id>` → Ctrl+C, or `/collab stop`, then quit OMP) and
retry. **Do not** delete a lease or force a second process — a second writer
forks your history silently.

## The relay is unreachable

Symptoms: conversation opens, no streaming; the app reports disconnected; the
runtime screen says the relay is not reachable.

```bash
tailscale serve status               # TLS front present?
ss -ltnp | grep -E '8791|8792'       # server and relay listening on loopback?
journalctl --user -u coding-agent-web | grep -i relay
```

The relay is bound to loopback by design; the phone reaches it through the
Tailscale TLS front. If the front is missing, re-run the `tailscale serve`
command in `docs/operations/iphone-setup.md`. Agent processes are unaffected
while the relay is down — their turns keep running and their journals keep
growing.

## A room link stopped working

Links are bound to a room *generation*. A session switch (resume, new chat in
the same process) retires the old room by design. The app re-fetches a link per
connection; if you are holding a raw link from the terminal and it fails with
`stale_generation`, list again:

```bash
omp collab list --json
omp collab link <instanceId>
```

## I lost my password

```bash
systemctl --user stop coding-agent-web
rm ~/.local/state/coding-agent-web/auth-password.json
systemctl --user start coding-agent-web      # prints a fresh one-time setup token
```

This revokes existing sessions with the credentials file. Conversations and
agents are untouched by this: they live in tmux and `~/.omp`.
