# Troubleshooting

Symptom-first. Every command here is read-only unless marked.

## The app will not start

**`omp not found on PATH`** — the server reports `capability_missing` and refuses
to launch agents. Install OMP or set `CAW_OMP_PATH` to the binary. Confirm with
`omp --version`.

**`tmux not found`** — same shape. Without tmux there is no process that outlives
the browser connection, so the product will not pretend it can keep one alive.
`sudo apt install tmux`.

**Port already in use** — change `port` in `caw.config.json`, or find the
squatter: `ss -ltnp | grep 8791`.

**Refuses to browse anything** — `allowedRoots` is empty or invalid. This is the
secure default: paste absolute paths that exist and are readable by your user.

## Nothing streams in a conversation

1. Runtime screen: does it say the relay is reachable and the host is connected?
2. `omp collab list` on the laptop — is there a row for this session?
3. `ss -ltnp | grep 8792` — is the relay listening?
4. `tailscale serve status` — is the TLS front up?

If the registry has no row, the agent is not hosting. That is not a UI bug: the
conversation genuinely has no live room to attach to, and the app shows the
attach instructions instead.

## "No live agent to attach to"

Correct behaviour, not an error. The conversation's journal exists but no process
is writing it. Start it (New chat / Resume) or attach to a terminal if you started
one by hand.

## The conversation says `unknown`

We could not read the Collab registry — usually a permissions problem or a
corrupted registry directory. Check:

```bash
ls -la ~/.omp/run/collab-hosts/
omp collab list --json
```

A *missing* directory means "no hosts" (a normal empty result). An *unreadable*
one is an error, and the app refuses to translate it into "stopped".

## A double prompt / the agent got the same message twice

Prompts carry a UUID idempotency key inside the sealed Collab frame. If you
saw a duplicate, capture: the conversation id, roughly when, and whether the
network dropped mid-send. Then look for two command rows with different keys —
different keys mean two genuine submissions (for example a double-tap before the
composer disabled), which is a UI defect worth reporting.

## The agent is running but the app shows `stopped`

Reconciliation keys off the tmux session id we recorded. If a session was
adopted by another process, or started by hand outside the app, it will show as
`external` rather than `managed`. Check what is actually there:

```bash
tmux -S ~/.local/state/coding-agent-web/tmux.sock list-sessions -F '#{session_id} #{session_name} #{pane_dead} #{session_created}'
```

`pane_dead=1` means tmux kept the session but its process exited — the state
machine maps that to `stopped`, which is accurate, and the attach command will
open an empty shell.

## `stale_generation` when opening a conversation

The room rotated between listing and linking (a session switch in that process).
The app retries once automatically. If it repeats, the process is switching
sessions quickly — inspect `omp collab list` and consider restarting that
conversation's agent (Stop, then Resume).

## Tool approvals never appear

Guest clients only receive `ui-request` frames for questions the host decides to
broadcast, and some terminal-only prompts degrade to a simple select. If a tool
call is sitting there with no card, the request may be waiting on the host's own
TUI instead — attach and answer it there:

```bash
tmux -S ~/.local/state/coding-agent-web/tmux.sock attach -t <tmuxSessionId>     # then answer, then detach with Ctrl+B D
```

The app never auto-approves, and never approves when it is disconnected.

## Sessions disappeared from the picker

The picker lists journals for that project's directory bucket. A session created
in a *different* directory will not appear. Confirm the bucket:

```bash
omp --resume         # OMP's own picker, all projects
```

If OMP's picker also lacks it, the journal is gone or unreadable — check
`~/.omp/agent/sessions/` permissions.

## Everything is slow / the laptop is thrashing

Check how many agents are actually running and lower the cap:

```bash
omp collab list                     # one row per hosting process
tmux -S ~/.local/state/coding-agent-web/tmux.sock list-sessions | grep -c '^[^:]*: caw-'
```

Set `maxActiveAgents` to what the machine can genuinely carry — each agent may
run build tools and language servers of its own.

## The phone cannot reach the app at all

```bash
tailscale status                    # both devices online, same tailnet?
tailscale serve status              # front configured?
curl -I http://127.0.0.1:8791/api/capabilities   # server itself alive?
```

If the laptop checks out, the problem is the tailnet (ACLs, device key expiry,
or the phone being on a network that blocks the tailnet). The app's own logs will
show no request at all in that case — which is itself the diagnosis.
