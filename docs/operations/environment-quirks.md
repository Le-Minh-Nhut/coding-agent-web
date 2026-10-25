# Environment quirks found while running this project

Things that cost real time and are not obvious from the code. Each was observed on
this machine, not inferred.

## `/tmp` can run out of quota, and the symptom is misleading

Observed: `node scripts/e2e-server.mjs` and the app server died with

```
Error: Unknown system error -122: Unknown system error -122, write
    at writeFileSync (node:fs:2368:20)
    at file:///…/scripts/e2e-server.mjs:67:1
```

`errno -122` is `EDQUOT` (quota exceeded), reported by Node as "unknown system
error" because it has no name for it in that path. `/tmp` here is a `tmpfs` that was
80% full (4.9 GB belonging to unrelated work in `/tmp/pytest-of-…`), and writes fail
with `EDQUOT` rather than `ENOSPC`, so the message names neither disk space nor
quota.

What made this expensive to find: the first symptom was Playwright reporting
`Process from config.webServer was not able to start. Exit code: 1`, which looks like
a broken test harness rather than a full filesystem. The app server had died the same
way minutes earlier, in a log line that scrolled past.

**Workaround, and what to do instead of debugging the code:**

```bash
TMPDIR=$HOME/.cache node scripts/e2e-server.mjs
TMPDIR=$HOME/.cache npx playwright test --project=chromium
```

Both `scripts/e2e-server.mjs` and `playwright.config.ts` already resolve their temp
paths through `os.tmpdir()`, so `TMPDIR` is honoured with no code change.

**For real deployments this does not apply**: the app's state directory defaults to
`~/.local/state/coding-agent-web`, not a temp filesystem, and it is the right place
for durable state. Only tests and the PoC scripts used `/tmp`.

## tmux removes a server when its last session ends

```
$ tmux -L probe new-session -d -s x 'sleep 20'
$ tmux -L probe display-message -p '#{socket_path}:#{start_time}:#{pid}'
/tmp/tmux-1000/probe:1792875221:3493269
$ tmux -L probe kill-session -t x
$ tmux -L probe display-message -p '#{socket_path}:#{start_time}:#{pid}'
no server running on /tmp/tmux-1000/probe
```

Consequence for this product: `TmuxService.serverIdentity()` returns `null` when its
configured socket path cannot reach a server. That can mean the server exited, or
that a live server's socket pathname became unreachable. The runtime checks the
recorded pane PID: `ESRCH` confirms our process ended, while a live PID, permission
failure, invalid PID, or legacy-null PID stays unknown. PID reuse can delay a valid
stop, but only in the safe direction.

## tmux session ids restart at `$0`

```
run1: start_time=1792871542  pid=3334710  session_id=$0
run2: start_time=1792871543  pid=3334731  session_id=$0   ← reused
```

So a recorded `$N` is only meaningful together with the identity of the server that
issued it. That is why `Conversation.tmuxServerIdentity` exists and why every action
on a recorded id checks it first. Verified in isolation, not assumed.

## The thinking-effort precedence trap (on this machine's OMP config)

Passing the task tool's coarse `effort` hint **overrides** the `:level` suffix in an
agent definition. `med` maps onto the model's supported list, so for a model whose
range is `minimal,low,medium,high` it resolves to index `(4-1)>>1 = 1` = **`low`**.
Observed in a session journal as `"thinkingLevel":"low"` for a spawn that asked for
medium.

Full detail and the rule: `docs/operations/subagent-effort-policy.md`. Short version:
state the level in the model id and do not pass `effort`.
