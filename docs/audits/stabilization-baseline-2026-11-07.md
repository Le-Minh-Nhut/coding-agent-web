# Stabilization baseline — 2026-11-07

Captured on the owner's live machine at **2026-11-07 12:56:58 +07**, with the
service running and three OMP agents alive on the app's private tmux socket.

Scope: read-only. No source file was edited, no build was run, no
`pnpm install`, no Playwright, no service restart, no signal to any OMP process
or tmux session, and nothing under `~/.omp/` or the app's
`~/.local/state/coding-agent-web/tmux.sock` was modified. The only write is this
file.

Convention: every value below is paired with the command that produced it.
`BLOCKED` means the check could not be performed and states why. `[INFERENCE]`
marks a conclusion drawn from the quoted facts rather than read directly off a
command.

---

## 1. Repository state

```console
$ git rev-parse HEAD
879d51fee8c931b2fee6bd661b786304f7623c6a

$ git rev-parse origin/main
879d51fee8c931b2fee6bd661b786304f7623c6a

$ git rev-list --left-right --count origin/main...HEAD
0	0

$ git rev-parse --abbrev-ref HEAD
main

$ git rev-parse --abbrev-ref '@{upstream}'
origin/main

$ git status --porcelain
(output: empty — clean tree)
```

Ahead/behind: **0 ahead, 0 behind** (`0	0` from `--left-right --count
origin/main...HEAD` = left `origin/main` unique 0, right `HEAD` unique 0).

### Recent history

```console
$ git log --oneline -25
879d51f docs: name every commit that went into the deployed bundle, not just the first three
a3d5da7 docs: put the release status, including the known defect, on the first screen
b36a027 docs: record attempt 6 (clamp fact) — fixed the two target specs, regressed round50 reach-end
3c1d901 docs: record attempt 5 (decrease rule) and the clamp sequence that rejected it
1ef1a62 docs: record attempt 4 (authorship token) and the measured reason it cannot work as specified
eec2b04 docs: record the three rejected discriminators for the Latest flake; unpacked design needed
a11be28 docs: record the Latest-visibility flake as a limitation; the distance fix failed PERF-SCROLL-09
3dc56e9 docs: re-run the release gates on the deployed tree
744a954 docs: record the CI verdict for the deployed build
99fae06 docs: reconcile the deployed bundle and record the approval-overlay fix
d29ffe6 fix(web): never float the jump-to-latest control over an approval
b6ace88 chore(web): drop the composer ref the deleted adoption path left behind
9e36a35 docs: correct shipped-code citations and record the CI probe
f788ab8 docs: record the CI verdict for the released revision
d0e1bd5 docs: record the round-58 gate results, deploy and CI status
a1cd120 ci: pick the browser the environment actually has, and stop the trace race
8d3d2cc docs: round-58 research, adversarial review, premium spec and final report
ab2a7bb feat(web): group tool activity by evidence, and a premium chrome layer
b1ef86c perf(web): window the transcript so a long conversation scrolls without going blank
b0114e3 docs: state the last CI runs and separate the code-bearing revision
6b7eef1 docs: mark the amber-chip finding not reproduced, and why
091e8f4 docs: fix two report defects and settle the comparator/cache claim by measurement
46e26dc docs: finalise the deployment section — CI run 109 passed, served assets verified
018e607 fix(web): make the running header read as one control, and record what the pixels showed
18091ed fix(web): notice identity and retirement, found by auditing the previous commit
```

### The two named commits

| Commit | Exists | Position |
|---|---|---|
| `879d51f` | yes — it **is** HEAD (`879d51fee8c931b2fee6bd661b786304f7623c6a`) | `git rev-list --count 879d51f..HEAD` → `0` |
| `d29ffe6a` | yes — `d29ffe6aabd84b6fbca6b716bde0fa05a30b0b0a` | `git rev-list --count d29ffe6a..HEAD` → `10`; `git merge-base --is-ancestor d29ffe6a HEAD` succeeded (ancestor of HEAD) |

```console
$ git log -1 --format='%H %ad %s' --date=iso d29ffe6a
d29ffe6aabd84b6fbca6b716bde0fa05a30b0b0a 2026-11-07 09:43:55 +0700 fix(web): never float the jump-to-latest control over an approval

$ git log -1 --format='%H %ad %s' --date=iso 879d51f
879d51fee8c931b2fee6bd661b786304f7623c6a 2026-11-07 12:30:07 +0700 docs: name every commit that went into the deployed bundle, not just the first three
```

`d29ffe6a` is 10 commits back from HEAD, all ten of which are documentation-only
commits (`git log --oneline --ancestry-path d29ffe6a..HEAD`, all subjects
`docs: …`). The last code-bearing commit in the deployed bundle is therefore
`d29ffe6 fix(web): never float the jump-to-latest control over an approval`.

---

## 2. Deployed baseline (hash, never mtime)

`apps/web/dist` is a **real directory**, not a symlink:

```console
$ realpath apps/web/dist
/home/heheboiz/data/coding-agent-web/apps/web/dist

$ stat -c '%F %i %s %n' apps/web/dist apps/web/dist/assets apps/web/dist/index.html
directory 11141128 4096 apps/web/dist
directory 11177632 4096 apps/web/dist/assets
regular file 11177633 973 apps/web/dist/index.html
```

### Hashes and sizes on disk

```console
$ sha256sum apps/web/dist/assets/* apps/web/dist/index.html
ca7c06d554a6731ae852924c2aa8aba9060fb6fdd909839509eab27d131fccc5  apps/web/dist/assets/index-e2muy0ow.css
02660079191e8615ea455b8e67b096023507c888b4539569f5b06fd5778a035b  apps/web/dist/assets/index-hVfEUPqx.js
79abb38cb2344d68be299c3d923cbd1d205cb7b1b14b079fb1dddc3083a4806c  apps/web/dist/index.html

$ stat -c '%s %n' apps/web/dist/assets/* apps/web/dist/index.html
58345 apps/web/dist/assets/index-e2muy0ow.css
486141 apps/web/dist/assets/index-hVfEUPqx.js
973 apps/web/dist/index.html
```

`apps/web/dist` also holds `icons/` (the icons referenced by the head, hashes in
§2.4), `manifest.webmanifest` (`426` bytes, sha256
`0e53ed43927f0befe5cccc06acddfb2a77d9457ab14ffd401aeffa89eba6772c` from
`sha256sum apps/web/dist/manifest.webmanifest`) and only the two files above
under `assets/` (`ls -la apps/web/dist/assets`).

### 2.1 Asset filenames the served HTML references

```console
$ grep -o 'assets/[^"]*' apps/web/dist/index.html
assets/index-hVfEUPqx.js
assets/index-e2muy0ow.css
```

Both referenced files exist on disk with the hashes above. `index.html` also
references `/manifest.webmanifest`, `/icons/apple-touch-icon.png` and
`/icons/app-icon-192.png`.

### 2.2 Loopback surface

Port found from the unit + config, then confirmed by `ss`:

```console
$ ss -ltnp | grep -E ':(8791|8792) '
LISTEN 0  511  127.0.0.1:8791  0.0.0.0:*  users:(("node",pid=92072,fd=22))
LISTEN 0  511  127.0.0.1:8792  0.0.0.0:*  users:(("node",pid=92072,fd=21))
```

`caw.config.json` names `"port": 8791` and `"relayPort": 8792`. Port 8791 is the
app; 8792 is the loopback-only collab relay.

```console
$ curl -sS -D - -o /tmp/bl-loop.html http://127.0.0.1:8791/
HTTP/1.1 200 OK
referrer-policy: no-referrer
x-content-type-options: nosniff
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://heheboiz-legion-5-15arh7.tail8d8eff.ts.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
cache-control: no-cache
content-type: text/html; charset=utf-8
content-length: 973
etag: "3cd-1a1b3e40d54.a94"
Date: Sat, 07 Nov 2026 05:55:19 GMT
Connection: keep-alive
Keep-Alive: timeout=72

$ sha256sum /tmp/bl-loop.html
79abb38cb2344d68be299c3d923cbd1d205cb7b1b14b079fb1dddc3083a4806c  /tmp/bl-loop.html
```

- Status line: `HTTP/1.1 200 OK`
- `referrer-policy`: `no-referrer`
- `content-type`: `text/html; charset=utf-8`
- `cache-control`: `no-cache`
- Body sha256: `79abb38cb2344d68be299c3d923cbd1d205cb7b1b14b079fb1dddc3083a4806c`
  — **identical to `apps/web/dist/index.html`**.

Hashed assets over loopback:

```console
$ for f in assets/index-hVfEUPqx.js assets/index-e2muy0ow.css manifest.webmanifest; do
    curl -sS -D - -o "/tmp/bl-$(basename $f)" "http://127.0.0.1:8791/$f" | grep -iE '^(HTTP/|cache-control|content-type|etag|content-length|last-modified)'
    sha256sum "/tmp/bl-$(basename $f)"
  done
--- assets/index-hVfEUPqx.js
HTTP/1.1 200 OK
cache-control: public, max-age=31536000, immutable
content-type: text/javascript; charset=utf-8
content-length: 486141
etag: "76afd-1a1b3e40d54.a94"
02660079191e8615ea455b8e67b096023507c888b4539569f5b06fd5778a035b  /tmp/bl-index-hVfEUPqx.js
--- assets/index-e2muy0ow.css
HTTP/1.1 200 OK
cache-control: public, max-age=31536000, immutable
content-type: text/css; charset=utf-8
content-length: 58345
etag: "e3e9-1a1b3e40d54.a94"
ca7c06d554a6731ae852924c2aa8aba9060fb6fdd909839509eab27d131fccc5  /tmp/bl-index-e2muy0ow.css
--- manifest.webmanifest
HTTP/1.1 200 OK
cache-control: no-cache
content-type: application/manifest+json; charset=utf-8
content-length: 426
etag: "1aa-1a1b3e40c97.a2e"
0e53ed43927f0befe5cccc06acddfb2a77d9457ab14ffd401aeffa89eba6772c  /tmp/bl-manifest.webmanifest
```

Route-shape probes on the same origin:

```console
$ curl -sS -o /dev/null -w '<path>: %{http_code}\n' http://127.0.0.1:8791/<path>
/some/unknown/path: 200   (text/html; charset=utf-8 — SPA fallback)
/assets/nope.js:    404   (text/plain; charset=utf-8)
/guest:             308
/healthz:           404
/api/projects:      401
```

### 2.3 Public surface

The origin is recorded in two places that agree: `caw.config.json`
(`"publicOrigin": "https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net"`) and the
Tailscale Serve config.

```console
$ tailscale serve status
https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8791

$ tailscale funnel status
https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8791
```

The surface is **tailnet-only** (`tailnet only`), proxying 8791 only — the relay
on 8792 is not proxied, consistent with `apps/server/src/server.ts:637`.

```console
$ curl -sS --max-time 20 -D - -o /tmp/bl-public.html https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net/
HTTP/2 200
cache-control: no-cache
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://heheboiz-legion-5-15arh7.tail8d8eff.ts.net; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
content-type: text/html; charset=utf-8
date: Sat, 07 Nov 2026 05:55:21 GMT
etag: "3cd-1a1b3e40d54.a94"
referrer-policy: no-referrer
x-content-type-options: nosniff
content-length: 973

$ sha256sum /tmp/bl-public.html
79abb38cb2344d68be299c3d923cbd1d205cb7b1b14b079fb1dddc3083a4806c  /tmp/bl-public.html
```

Not blocked: the root document is served without a session cookie (auth is a
client-side probe at `/api/auth/me`, which answers 401). Public hashed assets:

```console
$ curl -sS -D /tmp/bl-pub-hdr.txt -o /tmp/bl-pub-<name> https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net/<asset>
assets/index-hVfEUPqx.js: HTTP/2 200, cache-control: public, max-age=31536000, immutable, content-type: text/javascript; charset=utf-8
02660079191e8615ea455b8e67b096023507c888b4539569f5b06fd5778a035b
assets/index-e2muy0ow.css: HTTP/2 200, cache-control: public, max-age=31536000, immutable, content-type: text/css; charset=utf-8
ca7c06d554a6731ae852924c2aa8aba9060fb6fdd909839509eab27d131fccc5
```

### 2.4 Loopback vs `apps/web/dist` vs public

| File | On disk | Loopback | Public | Verdict |
|---|---|---|---|---|
| `index.html` | `79abb38c…a4806c` | `79abb38c…a4806c` | `79abb38c…a4806c` | identical |
| `assets/index-hVfEUPqx.js` | `02660079…78a035b` | `02660079…78a035b` | `02660079…78a035b` | identical |
| `assets/index-e2muy0ow.css` | `ca7c06d5…31fccc5` | `ca7c06d5…31fccc5` | `ca7c06d5…31fccc5` | identical |
| `manifest.webmanifest` | `0e53ed43…77b2c` | `0e53ed43…77b2c` | BLOCKED — not fetched | identical on the two measured surfaces |

The served bundle is byte-identical to the working tree's `apps/web/dist` on
both surfaces.

---

## 3. Running services and OMP sessions — record before

### 3.1 systemd (user unit)

```console
$ systemctl --user list-units --type=service --all | grep -i coding-agent
  coding-agent-web.service  loaded  active  running  Coding Agent Web
```

The unit is a **user** unit, not a system one
(`systemctl list-units --type=service --all` on the system bus has no match).

```console
$ systemctl --user status coding-agent-web.service --no-pager -l
● coding-agent-web.service - Coding Agent Web
     Loaded: loaded (/home/heheboiz/.config/systemd/user/coding-agent-web.service; enabled; preset: enabled)
     Active: active (running) since Fri 2026-11-06 15:39:16 +07; 21h ago
 Invocation: 798f34dd75c74468ab9aa3b001d58884
   Main PID: 92072 (node)
      Tasks: 13 (limit: 17473)
     Memory: 90.6M (peak: 415.5M, swap: 72M, swap peak: 102.2M)
        CPU: 1min 45.970s
     CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/coding-agent-web.service
             ├─  92072 node --import tsx /home/heheboiz/data/coding-agent-web/apps/server/src/server.ts
             └─1204277 tmux -S /home/heheboiz/.local/state/coding-agent-web/tmux.sock new-session -d -P -F "#{session_id}\t#{socket_path}:#{start_time}:#{pid}" -s caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb -c /home/heheboiz/data/cir omp --config=/home/heheboiz/.local/state/coding-agent-web/overlays/c3dc09cb-da7f-4d0b-88a3-103651dca7f2.yml --resume /home/heheboiz/.omp/agent/sessions/-data-cir/2026-11-02T11-44-14-790Z_01a19c13-05c6-75dc-9a9a-e634313b598f.jsonl
```

```console
$ systemctl --user show coding-agent-web.service -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp -p ExecStart -p WorkingDirectory -p FragmentPath -p NRestarts
ActiveState=active
SubState=running
FragmentPath=/home/heheboiz/.config/systemd/user/coding-agent-web.service
MainPID=92072
NRestarts=0
ExecMainStartTimestamp=Fri 2026-11-06 15:39:16 +07
ExecStart={ path=node ; argv[]=node --import tsx /home/heheboiz/data/coding-agent-web/apps/server/src/server.ts ; ignore_errors=no ; start_time=[Fri 2026-11-06 15:39:16 +07] ; stop_time=[n/a] ; pid=92072 ; code=(null) ; status=0/0 }
WorkingDirectory=/home/heheboiz/data/coding-agent-web
```

| Field | Value |
|---|---|
| ActiveState | `active` |
| SubState | `running` |
| MainPID | **92072** |
| ExecMainStartTimestamp | `Fri 2026-11-06 15:39:16 +07` |
| ExecStart | `node --import tsx /home/heheboiz/data/coding-agent-web/apps/server/src/server.ts` |
| WorkingDirectory | `/home/heheboiz/data/coding-agent-web` |
| NRestarts | `0` |

### 3.2 Unit file verbatim

```console
$ systemctl --user cat coding-agent-web.service
```

```ini
# /home/heheboiz/.config/systemd/user/coding-agent-web.service
[Unit]
Description=Coding Agent Web
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=/home/heheboiz/data/coding-agent-web
Environment=CAW_CONFIG=/home/heheboiz/data/coding-agent-web/caw.config.json
Environment=CAW_STATE_DIR=/home/heheboiz/.local/state/coding-agent-web
# UnsetEnvironment runs after Environment; never list CAW_CONFIG or CAW_STATE_DIR here.
UnsetEnvironment=CAW_HOST CAW_PORT CAW_LOG_LEVEL CAW_WEB_DIST_DIR CAW_GUEST_DIST_DIR CAW_PUBLIC_ORIGIN CAW_OMP_BINARY_PATH CAW_RELAY_PORT CAW_MAX_ACTIVE_AGENTS CAW_AUTH_TOKEN_TTL_HOURS CAW_ALLOWED_ROOTS CAW_RELAY_ALLOWED_ORIGINS CAW_TRUST_TAILSCALE_ORIGIN CAW_INSECURE_COOKIES
Environment=PATH=/home/heheboiz/.nvm/versions/node/v20.19.5/bin:/home/heheboiz/.local/share/pnpm:/home/heheboiz/.local/bin:/usr/bin:/home/heheboiz/.bun/bin:/home/heheboiz/.nvm/versions/node/v20.19.5/bin:/opt/jdk-25/bin:/usr/bin:/bin
ExecStart=node --import tsx /home/heheboiz/data/coding-agent-web/apps/server/src/server.ts
# Not `pnpm start`: the app must BE the main process. systemd signals only MAINPID
# under KillMode=process, and `pnpm start` is a shell shim that forks the real pnpm
# (which forks `sh -c tsx …`) without forwarding the signal, so stop would kill the
# shim and leave the HTTP server holding its port while the unit reports "stopped".
# Running the server entrypoint directly makes the app's own SIGTERM handler the
# thing systemd stops, which is the half of the contract KillMode=process needs.
KillMode=process
Restart=on-failure
RestartSec=3
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
MemoryAccounting=yes

[Install]
WantedBy=default.target
```

Two facts in this file matter for Phase 1:

1. `UnsetEnvironment` **actively strips `CAW_WEB_DIST_DIR` and
   `CAW_GUEST_DIST_DIR`** from the service environment. Whatever the shell has,
   the service cannot see it; the dist path today comes from the config file /
   built-in defaults only.
2. The repo copy `deploy/systemd/coding-agent-web.service` is the same file with
   `@REPO_ROOT@`, `@CONFIG_PATH@`, `@STATE_DIR@` and `@PATH_VALUE@`
   placeholders (`diff -u deploy/systemd/coding-agent-web.service
   ~/.config/systemd/user/coding-agent-web.service` differs only in those four
   substitutions plus the resulting line shifts).

### 3.3 Listening sockets owned by the app

```console
$ ss -ltnp | grep -E ':(8791|8792) '
LISTEN 0  511  127.0.0.1:8791  0.0.0.0:*  users:(("node",pid=92072,fd=22))
LISTEN 0  511  127.0.0.1:8792  0.0.0.0:*  users:(("node",pid=92072,fd=21))
```

Both loopback-only, both owned by MainPID 92072. 8791 = app (HTTP + SSE), 8792 =
collab relay (`apps/server/src/server.ts:665` binds it to `127.0.0.1`
explicitly).

### 3.4 tmux — the app's private socket only

```console
$ tmux -S ~/.local/state/coding-agent-web/tmux.sock list-sessions -F '#{session_id} #{session_name} #{session_created}'
$1 caw-CTX--Debug-1M-context-limit-400-01321407 1793854106
$0 caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb 1793822846
$2 caw-New-chat-b2dc0c99 1793854275

$ tmux -S ~/.local/state/coding-agent-web/tmux.sock list-panes -a -F '#{session_id} #{pane_id} #{pane_pid} #{pane_dead} #{session_created}'
$1 %1 2080435 0 1793854106
$0 %0 1204278 0 1793822846
$2 %2 2082046 0 1793854275

$ tmux -S ~/.local/state/coding-agent-web/tmux.sock display-message -p '#{pid}'
1204277
```

- tmux **server PID: 1204277** (also the `tmux … new-session` child in the unit's
  cgroup).
- 3 sessions, 3 panes, **none dead** (`pane_dead` = `0` for all three).
- Sessions `$1`/`$0`/`$2`, one pane each (`%1`/`%0`/`%2`).

Pane PIDs and start times:

```console
$ ps -o pid,lstart,cmd -p 2080435,1204278,2082046
    PID STARTED                  COMMAND
1204278 Thu Nov  5 03:07:26 2026 omp --config=/home/heheboiz/.local/state/coding-agent-web/overlays/c3dc09cb-da7f-4d0b-88a3-103651dca7f2.yml --resume /home/heheboiz/.omp/agent/sessions/-data-cir/2026-11-02T11-44-14-790Z_01a19c13-05c6-75dc-9a9a-e634313b598f.jsonl
2080435 Thu Nov  5 11:48:26 2026 omp --config=/home/heheboiz/.local/state/coding-agent-web/overlays/01321407-6b88-45fe-8e80-fd1801069fb6.yml --resume /home/heheboiz/.omp/agent/sessions/-data-coding-agent-web/2026-10-27T00-36-52-191Z_01a17ac9-dd5f-7339-8d52-2b3e1a5a4853.jsonl
2082046 Thu Nov  5 11:51:15 2026 omp --config=/home/heheboiz/.local/state/coding-agent-web/overlays/b2dc0c99-5857-4ad4-9b60-59b84d770f7c.yml
```

| session | pane | pane pid | started | conversation |
|---|---|---|---|---|
| `$0` | `%0` | 1204278 | Thu Nov 5 03:07:26 2026 | `c3dc09cb…` (DOCKER / Qu-t-Docker, resumed) |
| `$1` | `%1` | 2080435 | Thu Nov 5 11:48:26 2026 | `01321407…` (CTX / Debug 1M context limit, resumed) |
| `$2` | `%2` | 2082046 | Thu Nov 5 11:51:15 2026 | `b2dc0c99…` (New chat, fresh) |

Snapshot hash for a mechanical later comparison:

```console
$ tmux -S ~/.local/state/coding-agent-web/tmux.sock list-panes -a \
    -F '#{session_id} #{pane_id} #{pane_pid} #{pane_dead} #{session_created} #{session_name}' | sha256sum
4d95021fcfa9aa829b9d789863ada55265c77f0ae23f1c819c37e671c90cde48  -
```

That hash was taken over this exact five-field-plus-name line set:

```
$1 %1 2080435 0 1793854106 caw-CTX--Debug-1M-context-limit-400-01321407
$0 %0 1204278 0 1793822846 caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb
$2 %2 2082046 0 1793854275 caw-New-chat-b2dc0c99
```

`list-panes` does not sort by session id, so a later comparison must hash the
same `-F` string and sort it (`| sort | sha256sum`) if order changes — the
recorded hash above is **unsorted**, in tmux's own order.

---

## 4. Static-serving resolution — the fact Phase 1 turns on

There is **no `@fastify/static`**. `apps/server/package.json` dependencies are
`@caw/contracts`, `@caw/omp-adapter`, `@caw/runtime`, `fastify`, `zod`,
`@caw/relay`, `tsx` — no static plugin — and a repo-wide grep for
`@fastify/static` returns nothing. Static serving is a **custom handler** in
`apps/server/src/static-web.ts` registered from `apps/server/src/app.ts`.

### 4.1 Is the static root resolved at registration time or per request?

**Both, and the split is the problem.** The *directory path* is computed once at
registration; only `existsSync` is re-evaluated per request.

- `apps/server/src/app.ts:283` — `const repoRoot = findRepoRoot();` inside
  `buildApp` (`app.ts:216`), i.e. once per process.
- `apps/server/src/app.ts:284-286` — `webDistDir` chosen once:
  `resolveDistDir(config.webDistDir, repoRoot, "webDistDir")` when configured,
  else `resolve(repoRoot, "apps/web/dist")`.
- `apps/server/src/app.ts:290` — `registerStaticWeb(app, { webDistDir, guestDistDir });`
  passes that string into the plugin **once**.
- `apps/server/src/static-web.ts:173-178` — inside `registerStaticWeb`, the
  string is **resolved and symlink-expanded once**:

  ```
  173:   let webRootReal = path.resolve(options.webDistDir);
  174:   try {
  175:     webRootReal = realpathSync(webRootReal);
  176:   } catch {
  177:     // Keep resolved path if not yet present on disk
  178:   }
  ```

  `webRootReal` is a `const`-like closure variable captured by `handleWeb`
  (`static-web.ts:238`). Every request joins against this **captured realpath**:
  `static-web.ts:257-260` (`path.join(webRootReal, …)`).

- The only per-request filesystem-aware gate is
  `apps/server/src/static-web.ts:250`:
  `if (!existsSync(options.webDistDir)) { … 404 … }` — and it uses the
  **original, un-realpath'd** `options.webDistDir` string, not `webRootReal`.

Consequence, stated as fact for Phase 1: **the realpath of the dist directory is
frozen at registration.** Swapping `.deploy/current` (a symlink) after the
server started cannot change what is served without a restart — `existsSync`
would follow the new symlink and pass, while every `path.join(webRootReal, …)`
would still resolve into the *old* target. `[INFERENCE]` (the two lines above
are the evidence; the conclusion follows from them, not from an executed test).

### 4.2 Which plugin/version serves it; symlinks / manifest cache / per-request stat?

- Custom Fastify route handlers, not a plugin: `static-web.ts:297-301`
  (`app.get("/guest", …)`, `app.get("/guest/*", …)`, `app.get("/", handleWeb)`)
  plus `app.setNotFoundHandler` at `static-web.ts:303`. Fastify version from
  `apps/server/package.json`: `"fastify": "^5.2.1"`.
- **No manifest cache, no directory read.** Each request *opens* a file:
  `static-web.ts:106` `await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)`.
  So: **stat per request** (`static-web.ts:107` `await handle.stat()`), streamed
  from the handle (`static-web.ts:135-136`).
- **Symlinks are refused, not followed**: `O_NOFOLLOW` at `static-web.ts:106`
  makes a symlinked *file* fail with `ELOOP`, which `static-web.ts:146` maps to
  "not this file" (`return false` → 404 / SPA fallback). The root itself is
  expanded once by `realpathSync` (`static-web.ts:175`).
- Containment is re-verified per request against the captured root:
  `static-web.ts:83` `fs.readlink('/proc/self/fd/' + handle.fd)` and
  `static-web.ts:91` `real === rootReal || real.startsWith(rootReal + path.sep)`.
- Path hygiene per request: `safeSegments` (`static-web.ts:51-71`) rejects
  traversal/NUL/backslash/absolute segments; failure ⇒ `400`
  (`static-web.ts:245-248`).

### 4.3 SPA fallback

Yes. Implemented in `handleWeb`, reached through the not-found handler:

- `static-web.ts:267-274` — try the exact file; if served, done.
- `static-web.ts:276-279` — **if the first segment is `assets`, return 404**
  (`text/plain`) instead of falling back, so a missing hashed asset never
  returns HTML.
- `static-web.ts:280-288` — otherwise serve
  `path.join(webRootReal, "index.html")` with `cache-control: no-cache`.
- `static-web.ts:303-327` — `setNotFoundHandler` routes: `/api*` → JSON 404
  (`306-312`); `/r`, `/r/*`, `/healthz` → plain 404 (`314-320`); `/guest*` →
  guest handler (`322-324`); everything else → `handleWeb` (`326`).

Measured: `/some/unknown/path` → `200 text/html`, `/assets/nope.js` → `404
text/plain` (see §2.2).

### 4.4 `cache-control` / `immutable` per file class

Set from the first path segment, not from the file name:

- `static-web.ts:262-265`:
  `const isHashedAsset = segments[0] === "assets";`
  → `"public, max-age=31536000, immutable"` for anything under `/assets/`,
  else `"no-cache"`.
- Applied by `tryServeFile` at `static-web.ts:118`
  (`reply.header("Cache-Control", cacheControl)`).
- SPA fallback always passes `"no-cache"` (`static-web.ts:286`), so `index.html`
  is `no-cache` on both the direct route (`segments.length === 0`) and the
  fallback.
- Guest handler has its own copy of the same rule: `static-web.ts:220-223`.
- `ETag` is synthesized from size+mtime per request
  (`static-web.ts:115`): `` `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"` ``.
  **The ETag therefore changes when mtime changes even if bytes did not** — it is
  not a content hash. Measured header today: `etag: "76afd-1a1b3e40d54.a94"` for
  the JS, `"e3e9-1a1b3e40d54.a94"` for the CSS, `"3cd-1a1b3e40d54.a94"` for
  `index.html`.
- Base security headers on every served file: `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff` (`static-web.ts:36-39`, applied at `117`).

### 4.5 Where the dist path is computed, and what a versioned release dir would require

Three places compute it, in order:

1. `apps/server/src/config.ts:162` —
   `config.webDistDir = resolveDistDir(config.webDistDir ?? "apps/web/dist", repoRoot, "webDistDir")`.
   Called from `loadConfig` (`config.ts:128`), invoked at
   `apps/server/src/server.ts:400`. Input comes from the config file or
   `CAW_WEB_DIST_DIR` (`config.ts:84-87` maps `webDistDir` → `CAW_WEB_DIST_DIR`).
2. `apps/server/src/app.ts:284-289` — re-resolves it (or falls back to
   `resolve(repoRoot, "apps/web/dist")`) inside `buildApp`.
3. `apps/server/src/static-web.ts:173-178` — `path.resolve` + `realpathSync`,
   captured for the process lifetime.

`resolveDistDir` (`config.ts:63-76`) accepts an absolute path unchanged, and a
repo-relative path only if it stays inside the repo root — an absolute path
outside the repo (e.g. `/home/heheboiz/.local/state/coding-agent-web/releases/…`)
passes as `isAbsolute` and returns early, so **a versioned release directory
outside the repo is already legal config**; no code change is needed to *point*
at it.

What would have to change to serve a versioned release directory such as
`.deploy/current` **without a restart** (facts, not a proposal):

- `static-web.ts:173-178` must stop pinning `webRootReal` for the process
  lifetime, because that line is the single binding that freezes the target.
- `static-web.ts:250` uses `existsSync(options.webDistDir)` while
  `static-web.ts:257-260` joins against `webRootReal` — the two must agree on
  which path a request means, or a swapped symlink gives "exists, but serves the
  old bytes".
- `static-web.ts:106` `O_NOFOLLOW` means a *file*-level symlink is never
  followed; a directory-level indirection must therefore live in the root
  path, not in per-file links inside dist.
- The unit's `UnsetEnvironment` line removes `CAW_WEB_DIST_DIR` from the service
  environment, so a path supplied that way cannot reach the process as
  configured today.

---

## 5. Build wiring

### 5.1 `apps/web/package.json` scripts (verbatim)

```console
$ node -e 'const p=require("./apps/web/package.json");console.log(JSON.stringify(p.scripts,null,2))'
{
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "typecheck": "tsc -p tsconfig.json --noEmit"
}
```

`build` is a bare `vite build` with no `--outDir`, so Vite's default
`outDir: "dist"` applies → writes into `apps/web/dist` — the directory production
serves (§2, §4.5). That is why this capture ran no build of any kind.

### 5.2 Root `package.json` scripts

```console
$ node -e 'const p=require("./package.json");console.log(JSON.stringify(p.scripts,null,2))'
{
  "build": "pnpm -r build",
  "typecheck": "pnpm -r typecheck",
  "test": "vitest run",
  "test:watch": "vitest",
  "test:e2e": "playwright test --project=chromium",
  "test:e2e:all": "playwright test",
  "dev": "pnpm --filter @caw/server dev",
  "start": "pnpm --filter @caw/server start",
  "compat": "node scripts/compat-check.mjs",
  "typecheck:compat": "tsc -p tsconfig.compat.json --noEmit",
  "guest:build": "node scripts/build-guest.mjs",
  "format": "prettier --write .",
  "format:check": "prettier --check ."
}
```

There is **no deploy script** at the root: no `deploy`, no `release`, no
`publish`. `build` = `pnpm -r build`, which reaches `apps/web`'s bare
`vite build`.

### 5.3 `apps/web/vite.config.ts`

Only file: `apps/web/vite.config.ts` (no `.mjs`/`.js` variant).

- `build.outDir` — **absent**. Vite default `dist`.
- `base` — **absent**. Vite default `/`, which is why `index.html` references
  `/assets/…` with a leading slash.
- `build.assetsDir` — **absent**. Vite default `assets`, which is what
  `static-web.ts:262` keys cache-control on.
- `build` sets only `target: "es2022"` (`vite.config.ts:37-39`).
- `server.port` 3000 with `/api` proxied to `http://127.0.0.1:8791`
  (`vite.config.ts:28-36`) — the dev server talks to the live app port.
- Aliases into `packages/guest/src` (`vite.config.ts:19-27`).

### 5.4 Everything that references `apps/web/dist` (or `dist/`) in code/config

```console
$ grep -rn "apps/web/dist\|web/dist\|dist/" --include='*.ts' --include='*.mjs' --include='*.js' \
    --include='*.json' --include='*.yml' --include='*.service' . \
  | grep -v node_modules | grep -v '/dist/'
```

Live references (the `./~/.cache/r50-review/repro/*.mjs` hits are an ignored
scratch directory — `.gitignore:44` matches `~/.cache/` — and were excluded as
non-repo content):

| File:line | Reference |
|---|---|
| `.github/workflows/ci.yml:56` | `test -d apps/web/dist && test -d packages/guest/dist \|\| { echo "::error::Required dist directory missing."; exit 1; }` |
| `.github/workflows/ci.yml:57` | `grep -rIl "um\.can\.ac\|my\.omp\.sh" apps/web/dist packages/guest/dist` |
| `apps/server/src/app.ts:286` | `: resolve(repoRoot, "apps/web/dist");` |
| `apps/server/src/config.ts:162` | `config.webDistDir = resolveDistDir(config.webDistDir ?? "apps/web/dist", repoRoot, "webDistDir");` |
| `scripts/e2e-server.mjs:29` | comment: a hardcoded `apps/web/dist` would refuse a run whose assets are configured elsewhere |
| `scripts/e2e-server.mjs:33` | `: join(repoRoot, "apps", "web", "dist");` (precondition path) |
| `tests/e2e/fixture.ts:232` | skip message text — `…built SPA from apps/web/dist` (message only) |
| `tests/server/round26-e2e-harness-cleanup.test.ts:98` | comment — stub `apps/web/dist` via `CAW_WEB_DIST_DIR` |
| `apps/server/package.json:11` | `//start` note about `node dist/server.js` (server's own dist, not the web dist) |
| `scripts/verify-agent-limit.mjs:37` | comment about `node dist/server.js` (same, not the web dist) |
| `deploy/systemd/coding-agent-web.service:12` | `UnsetEnvironment=… CAW_WEB_DIST_DIR CAW_GUEST_DIST_DIR …` (strips the override) |

`CAW_WEB_DIST_DIR` itself is referenced in: `scripts/e2e-server.mjs:27,31`,
`tests/scripts/e2e-harness.test.ts:61,89`,
`tests/server/round26-e2e-harness-cleanup.test.ts:99,108`,
`deploy/systemd/coding-agent-web.service:12`, and docs (§7 files
`FINAL_SCROLL_PERFORMANCE_AND_MODEL_MIGRATION.md`,
`SCROLL_PERFORMANCE_RESEARCH.md`, `round-27-verification.md`). No application
source other than `config.ts:84` reads the variable name — it is generated there
from the key `webDistDir`.

### 5.5 Playwright config

One config: `playwright.config.ts` at the repo root (there is no
`tests/e2e/playwright.config.ts`).

- **`CAW_WEB_DIST_DIR` is not named in `playwright.config.ts` at all.** It
  reaches the harness by *inheritance*: Playwright's `webServer.command`
  (`playwright.config.ts:129` `node scripts/e2e-server.mjs`) runs with the
  config process's environment plus the `env` map (`playwright.config.ts:140-163`,
  which sets only `CAW_E2E_FIXTURE`, optionally `CAW_E2E_PORT`, optionally
  `CAW_INSECURE_COOKIES`). The launcher then resolves it at
  `scripts/e2e-server.mjs:31-33` (`resolve(repoRoot, process.env.CAW_WEB_DIST_DIR)`
  or `join(repoRoot, "apps", "web", "dist")`), requires `index.html` to exist
  there (`scripts/e2e-server.mjs:34,55-60`), and forwards it to the server child
  via `...cleanParentEnv` (`scripts/e2e-server.mjs:236,245`) — where
  `apps/server/src/config.ts:84` reads it back as `webDistDir`. `[INFERENCE]` on
  the *inheritance* step only (Playwright's documented `webServer` env
  behaviour); the three code steps are quoted above.
- **Port**: `BASE_URL = process.env.CAW_E2E_BASE_URL ?? (REUSE_PORT ?
  http://127.0.0.1:${REUSE_PORT} : "http://127.0.0.1:4399")`
  (`playwright.config.ts:26-27`), where `REUSE_PORT = process.env.CAW_E2E_PORT`.
  Launcher side: `CAW_PORT: process.env.CAW_E2E_PORT ?? "4399"` and
  `CAW_RELAY_PORT: process.env.CAW_E2E_RELAY_PORT ?? "4398"`
  (`scripts/e2e-server.mjs:248-249`).
- **`webServer`**: yes (`playwright.config.ts:128-164`), `command: "node
  scripts/e2e-server.mjs"`, readiness `url: ${BASE_URL}/api/capabilities`
  (line 133), `timeout: 60_000`, `gracefulShutdown: { signal: "SIGTERM",
  timeout: 10_000 }`.
- **`reuseExistingServer`**: `!process.env.CI` (line 134) — local runs reuse an
  already-answering server, CI never does.
- **Artifacts**: no `outputDir` key is set anywhere in `playwright.config.ts`
  (grep for `outputDir` returns nothing), so Playwright's default `test-results/`
  applies `[INFERENCE]`; `use.trace: "retain-on-failure"` (line 108),
  `screenshot: "only-on-failure"` (line 109), reporter `[["list"]]` locally and
  `[["list"], ["github"]]` in CI (line 102). `.gitignore:246-247` ignores
  `test-results/` and `playwright-report/`.
- Serial by construction: `fullyParallel: false`, `workers: 1`
  (`playwright.config.ts:98-99`), `retries: CI ? 1 : 0`, `timeout: 30_000`,
  `expect.timeout: 7_000`.

---

## 6. Known-defect inventory (read, not fixed)

### 6.1 `captureAnchorRef` in `apps/web/src/components/MessageRow.tsx`

```console
$ grep -n "captureAnchorRef" apps/web/src/components/MessageRow.tsx
586:      captureAnchorRef.current?.();
685:  const captureAnchorRef = useRef(captureAnchor);
686:  captureAnchorRef.current = captureAnchor;
712:    if (anchor === null) { captureAnchorRef.current?.(false); return; }
759:          captureAnchorRef.current?.(false);
764:      captureAnchorRef.current?.(false);
812:    captureAnchorRef.current?.(false);
817:    captureAnchorRef.current?.(false);
```

Call sites: **8 lines touching the ref; one definition pair (685-686) and six
invocations** at 586, 712, 759, 764, 812, 817.

**Yes — two consecutive calls exist.** Lines **812 and 817** are both
`captureAnchorRef.current?.(false);` inside the same `useLayoutEffect`, separated
only by a comment block (813-816) and a dependency-array comment (818-…). The
comment at 813-816 explicitly says "No `setViewport` here on purpose", so 817 is
a duplicate of 812 left behind, not two intentional calls with work between
them.

Line 586 is a different invocation: the scroll-event `read()` callback calls it
**with no argument** (default behaviour), whereas the layout-effect sites all
pass `false`.

#### Surrounding context — the scroll `read()` that calls it (575-600)

```tsx
575:   useEffect(() => {
576:     const element = scrollElement?.current ?? null;
577:     if (element === null) return;
578:     let frame = 0;
579:     const read = (): void => {
580:       frame = 0;
581:       setViewport((previous) => (
582:         Math.abs(previous.top - element.scrollTop) < 0.5 && Math.abs(previous.height - element.clientHeight) < 0.5
583:           ? previous
584:           : { top: element.scrollTop, height: element.clientHeight }
585:       ));
586:       captureAnchorRef.current?.();
587:     };
588:     const schedule = (): void => {
589:       if (frame !== 0) return;
590:       frame = requestAnimationFrame(read);
591:     };
592:     element.addEventListener("scroll", schedule, { passive: true });
593:     read();
594:     const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
595:     observer?.observe(element);
596:     return () => {
597:       element.removeEventListener("scroll", schedule);
598:       observer?.disconnect();
599:       if (frame !== 0) cancelAnimationFrame(frame);
600:     };
```

#### The anchor-correction `useLayoutEffect` (685-690, then 697-830)

```tsx
685:   const captureAnchorRef = useRef(captureAnchor);
686:   captureAnchorRef.current = captureAnchor;
687:
688:   /**
689:    * Hold the reading position across a commit that changes the document's geometry.
690:    *
691:    * Runs after the DOM is updated and before paint, so the correction is never
692:    * visible: an entry that was measured taller, or a run of history prepended above
693:    * the reader, moves `scrollTop` by exactly the distance the anchored entry moved.
694:    * Skipped while following the tail — there the bottom is the anchor and the view's
695:    * own tail logic owns it.
696:    */
697:   useLayoutEffect(() => {
698:     const element = scrollElement?.current ?? null;
699:     if (element === null || !windowed) return;
700:     if (stickToBottomRef?.current === true) {
701:       // Following the tail means the *bottom* is the anchor. When an estimate becomes
702:       // a measurement the document grows or shrinks under the reader, and without
703:       // re-pinning the newest message drifts out of view — measured at 7,529 px after
704:       // the 4,075-entry snapshot settled, which is what made the newest row
705:       // unreachable by a "scroll to bottom". The view re-pins on `messages`, which do
706:       // not change here; this is the same rule applied to the height model.
707:       element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
708:       anchorRef.current = null;
709:       return;
710:     }
711:     const anchor = anchorRef.current;
712:     if (anchor === null) { captureAnchorRef.current?.(false); return; }
713:     const node = elementsRef.current.get(anchor.key);
714:     if (node === undefined) {
715:       /**
716:        * The anchored entry left the window — and it can leave because content ABOVE it
717:        * grew, not only because somebody moved the view.
718:        *
719:        * Giving up here (the first behaviour) loses the reading position exactly in the
720:        * case this effect exists for. Measured: a `Show more` at the reader's own row
721:        * expanded a single entry to 4,460px; every row below it was pushed out of the
722:        * window, the anchor row among them, so the correction bailed out while
723:        * `scrollTop` stayed put — and the reader was left staring at the empty bottom of
724:        * the expanded block with 13 entries mounted somewhere above and no way to tell.
725:        *
726:        * The model already knows where that entry is now, so the correction is arithmetic
727:        * rather than a guess: move by exactly the distance the entry's model offset
728:        * changed, which is the growth above it.
729:        */
730:       const anchorIndex = indexOfKey.get(anchor.key);
731:       if (anchorIndex !== undefined) {
732:         const modelOffset = offsets[anchorIndex];
733:         if (modelOffset !== undefined) {
734:           /**
735:            * The scroll movement since capture MUST be part of the target.
736:            *
737:            * At capture the anchor row sat at document offset `D0`, viewport offset `O0`
738:            * with `scrollTop = S0`, so `D0 - S0 = O0`. Holding that viewport offset now
739:            * needs `target = D1 - O0 = (D1 - D0) + S0`. If the reader (or a programmatic
740:            * jump) has since scrolled `ΔS = scrollTop - S0`, the row must sit `ΔS` higher
741:            * in the viewport, so `target = modelOffset - anchor.offset + ΔS`.
742:            *
743:            * Leaving that term out made this branch undo any movement that unmounted the
744:            * anchor. Measured on WebKit, 4,075 heavy rows, "return to bottom": the write
745:            * landed correctly (`scrollTop 458,385`, `atMax: true`), then the very next
746:            * frame reverted it to 44,578 and the frame after to 44,558 — the capture-time
747:            * position — because the anchor row (~entry 460) was unmounted by the jump and
748:            * the arithmetic put the view back where the anchor was last seen. Chromium hit
749:            * the same branch less often, which is why this surfaced on the owner's engine.
750:            *
751:            * The `Show more` case this branch was written for has `ΔS = 0` (the reader did
752:            * not scroll; the document grew), so that behaviour is unchanged.
753:            */
754:           const scrolledSinceCapture = element.scrollTop - anchor.scrollTop;
755:           const target = modelOffset - anchor.offset + scrolledSinceCapture;
756:           const moved = target - element.scrollTop;
757:           if (Math.abs(moved) >= 0.5) element.scrollTop = Math.max(0, target);
758:           // Re-capture from the DOM so the next commit has a mounted anchor again.
759:           captureAnchorRef.current?.(false);
760:           return;
761:         }
762:       }
763:       // Truly unknown (the entry is gone from the model): re-capture rather than guess.
764:       captureAnchorRef.current?.(false);
765:       return;
766:     }
767:     /**
768:      * Both causes of movement, in one correction.
769:      *
770:      * `anchor.offset` is where the anchor row sat relative to the scroller's top when it
771:      * was recorded, and `anchor.scrollTop` is the offset in force then. Since that
772:      * capture the row may have moved for two independent reasons: the user scrolled
773:      * (`scrollTop` changed), and the document's geometry changed because a height above
774:      * the viewport was measured (`offset` changed). The reader's content position must
775:      * follow the first and ignore the second, so:
776:      *
777:      *     wanted = anchor.offset - (scrollTop - anchor.scrollTop)
778:      *     delta  = actual - wanted
779:      *
780:      * Skipping the whole correction whenever `scrollTop` had moved — which is what this
781:      * did first — meant it never ran under a flick, which is exactly when estimates
782:      * above the viewport are being replaced by measurements. Measured on WebKit: the
783:      * mounted rows drifted entirely *above* the visible band (-715px against a band top
784:      * of 102) and painted a blank screen for up to 199ms.
785:      */
786:     const scrolledSinceCapture = element.scrollTop - anchor.scrollTop;
787:     const actual = node.getBoundingClientRect().top - element.getBoundingClientRect().top;
788:     const delta = actual - (anchor.offset - scrolledSinceCapture);
789:     if (Math.abs(delta) >= 0.5) {
790:       // Apply, then re-base from the movement the browser ACTUALLY made. A fractional
791:       // `scrollTop` is snapped to a layout unit, so `actual - delta` is not where the
792:       // row ends up; measuring the applied movement is.
793:       const beforeWrite = element.scrollTop;
794:       element.scrollTop = beforeWrite + delta;
795:       const applied = element.scrollTop - beforeWrite;
796:       // The correction is a movement this component made, so the anchor must carry the
797:       // post-correction geometry. Leaving the pre-correction values there makes the
798:       // *next* commit read its own previous correction as "somebody else moved the
799:       // viewport" and re-apply the same delta — how the newest row ended up 8,000px away
800:       // from a view that believed it was following the tail.
801:       anchorRef.current = { key: anchor.key, offset: actual - applied, scrollTop: element.scrollTop };
802:     }
803:     /**
804:      * Re-capture unconditionally, sub-pixel deltas included (W4).
805:      *
806:      * `captureAnchor` re-reads the anchor from the live DOM, so after this call the
807:      * baseline always describes the geometry that is actually on screen. That is what
808:      * stops two consecutive commits that each measure a row 0.4px taller from
809:      * accumulating: the first one is applied (or absorbed) and the second starts from
810:      * the measured truth rather than from the height it saw last time.
811:      */
812:     captureAnchorRef.current?.(false);
813:     // No `setViewport` here on purpose: the window is carried by the force-mounted
814:     // anchor (`pinned`), and the new offset reaches the window through the scroller's
815:     // own scroll event. Publishing state from this effect instead makes the correction
816:     // its own trigger — React #185 — and the scroll event was already going to fire.
817:     captureAnchorRef.current?.(false);
818:     // Depends on the entry array's identity rather than on a spacer sum: any change to
819:     // what is mounted, in any segment, is a candidate for a geometry correction.
820:     // `offsets` is a dependency because the missing-anchor branch corrects from the
821:     // model, not from a measured rect: without it that branch would run against the
822:     // offsets from before the expansion that unmounted the anchor.
823:     /**
824:      * Why the window's bounds are dependencies even though this effect writes
825:      * `scrollTop`.
826:      *
827:      * They have to be: an expansion pushes the anchored row out of the mounted range, and
828:      * without a run on the new range the row stays unmounted and the reading position is
829:      * lost — measured as "the anchored row must stay mounted through an expansion"
830:      * failing in `PERF-SCROLL-04`.
```

### 6.2 `skipIfOverBudget` — two definitions, 13 call sites

```console
$ grep -rn "skipIfOverBudget" tests/e2e/ | head -40
13 matches in 2F:

[file] tests/e2e/mobile-performance.spec.ts (9):
   101: function skipIfOverBudget(measured: number, what: string): void {
   626: skipIfOverBudget(loadMs, "snapshot load");
   669: skipIfOverBudget(p95, "menu open p95");
   797: skipIfOverBudget(tapToSettledMs, "Stop tap to settled UI");
   874: skipIfOverBudget(p95, "scroll frame p95");
   970: skipIfOverBudget(Math.max(openMs, detailMs, backToConversationMs), "agent navigation p95");
  1020: skipIfOverBudget(Math.max(listMs, diffMs), "files/diff open p95");
  1070: skipIfOverBudget(loadMs, "12 MB snapshot load");
  1285: skipIfOverBudget(p95, "keystroke p95");

[file] tests/e2e/perf-scroll-gates.spec.ts (4):
    63: function skipIfOverBudget(measured: number, what: string): void {
   642: skipIfOverBudget(backMs, "diff → transcript round trip");
   720: skipIfOverBudget(longMs, "longest task during a Markdown stream into 4075 entries");
   846: skipIfOverBudget(firstContentMs, "12 MB snapshot first content");
```

The helper is **not shared**: it is copied in two spec files, with different
comment text and different skip messages.

`tests/e2e/mobile-performance.spec.ts:97-103`:

```ts
/**
 * Skip with the measured value named, once the correctness assertions have already
 * run. The number stays in the JSON above, so the parent still gets the measurement.
 */
function skipIfOverBudget(measured: number, what: string): void {
  if (measured > BUDGET_MS) test.skip(true, `${what} ${measured}ms exceeds the brief's ${BUDGET_MS}ms budget on the current build; measured value recorded in PERF_JSON`);
}
```

`tests/e2e/perf-scroll-gates.spec.ts:62-67`:

```ts
/** Print the number, then skip with it named — the policy's "over budget" branch. */
function skipIfOverBudget(measured: number, what: string): void {
  if (measured > BUDGET_MS) {
    test.skip(true, `${what} ${measured}ms exceeds the ${BUDGET_MS}ms budget on this build; measured value is in PERF_JSON, no assertion was weakened`);
  }
}
```

Both compare against a module-level `BUDGET_MS` and both turn an over-budget
measurement into a **skip**, not a failure. Both are called *after* the
correctness assertions in their tests (per the first file's comment).

### 6.3 Port 4399 references

```console
$ grep -rn "port.*4399\|4399" tests/ scripts/ --include='*.ts' --include='*.mjs' | head -20
4 matches in 2F:

[file] scripts/e2e-server.mjs (1):
   248: CAW_PORT: process.env.CAW_E2E_PORT ?? "4399",

[file] tests/server/round26-e2e-harness-cleanup.test.ts (3):
    50: * A port nothing is listening on right now. The launcher defaults to 4399, and
    51: * vitest runs several test files at once — a batch that also binds 4399 would
   110: // the ports must not be, or this run races the default 4399 in a parallel batch.
```

Plus the Playwright config's default base URL
(`playwright.config.ts:27`: `"http://127.0.0.1:4399"`), which the grep above
does not cover because it is scoped to `tests/` and `scripts/`. 4399 is the E2E
app port; 4398 is the E2E relay port (`scripts/e2e-server.mjs:249`). Neither is
the deployed app's port (8791/8792 — §3.3).

---

## 7. Documentation inventory

`docs/` contained **64** Markdown files before this file was written
(`find docs -name '*.md' | wc -l` → 64; 65 including this one) in six
directories, listed by `ls`:

- `docs/` (top level): `HUONG_DAN_SU_DUNG.md` (only file here)
- `docs/adr/` (2): `0001-runtime-architecture.md`, `0002-private-relay-and-remote-access.md`
- `docs/architecture/` (6): `mobile-client.md`, `overview.md`,
  `prompt-state-and-retention-contract.md`, `security-model.md`,
  `session-lifecycle.md`, `testing.md`
- `docs/audits/` (28 `.md` + `assets/`): `CAW_PERFORMANCE_AND_MOBILE_UX_REPORT.md`,
  `FINAL_HISTORY_UX_PLAYWRIGHT_REPORT.md`, `FINAL_PRODUCT_QUALITY_REPORT.md`,
  `FINAL_SCROLL_PERFORMANCE_AND_MODEL_MIGRATION.md`,
  `HISTORY_AND_MOBILE_UX_BASELINE.md`, `PREMIUM_DESIGN_SPEC.md`,
  `SCROLL_PERFORMANCE_RESEARCH.md`, `adversarial-review-round58.md`,
  `baseline-state-2026-11-06.md`, `model-migration-notes.md`,
  `reconciliation-verification.md`, `round-1-architecture.md`,
  `round-12-verification.md`, `round-2-security.md`,
  `round-27-verification.md`, `round-3-post-fix-verification.md`,
  `round-4-final-verification.md`, `round-5-verification-of-round-4.md`,
  `round-6-verification-of-p0-fixes.md`,
  `round-7-verification-of-ownership-fixes.md`,
  `round-8-build-ci-and-test-inventory.md`,
  `round-8-folder-and-conversation-workflow.md`,
  `round-8-mobile-reading-ux.md`,
  `round-8-protocol-history-and-reconnect.md`,
  `round-8-visual-review.md`, `round-9-verification.md`,
  `round54-premium-mobile-design.md`; plus `assets/round57/`, `assets/round58/`
- `docs/operations/` (16): `acceptance-run-plan.md`, `deepseek-context-cap.md`,
  `deployment.md`, `environment-quirks.md`, `evidence.md`,
  `implementation-status.md`, `iphone-access.md`, `iphone-setup.md`,
  `recovery.md`, `release-notes-v0.1.md`, `release-readiness.md`,
  `screenshot-policy.md`, `subagent-effort-policy.md`,
  `subagent-model-policy.md`, `troubleshooting.md`, `ubuntu-setup.md`
- `docs/research/` (11): `architecture-evaluation.md`, `collab-data-model.md`,
  `collab-relay-selfhost.md`, `mobile-ux-and-pwa.md`, `model-catalog.md`,
  `omp-compatibility.md`, `omp-rpc-sdk.md`, `omp-session-semantics.md`,
  `proof-of-concept.md`, `security-considerations.md`,
  `slash-command-feasibility.md`

### The named files, with line counts

```console
$ wc -l <file>
  1602 docs/HUONG_DAN_SU_DUNG.md
    62 docs/operations/subagent-model-policy.md
  1499 docs/audits/FINAL_SCROLL_PERFORMANCE_AND_MODEL_MIGRATION.md
   928 docs/audits/SCROLL_PERFORMANCE_RESEARCH.md
   266 docs/audits/adversarial-review-round58.md
   360 docs/audits/model-migration-notes.md
   532 docs/audits/PREMIUM_DESIGN_SPEC.md
```

| File | Exists | Lines |
|---|---|---|
| `docs/audits/FINAL_SCROLL_PERFORMANCE_AND_MODEL_MIGRATION.md` | yes | 1499 |
| `docs/audits/SCROLL_PERFORMANCE_RESEARCH.md` | yes | 928 |
| `docs/audits/adversarial-review-round58.md` | yes | 266 |
| `docs/audits/model-migration-notes.md` | yes | 360 |
| `docs/audits/PREMIUM_DESIGN_SPEC.md` | yes | 532 |
| `docs/operations/subagent-model-policy.md` | yes | 62 |
| `docs/HUONG_DAN_SU_DUNG.md` | yes | 1602 |

All seven exist. None is BLOCKED.

---

## Summary of the facts Phase 1 depends on

- HEAD = `879d51fee8c931b2fee6bd661b786304f7623c6a`, in sync with `origin/main`,
  clean tree. Last code-bearing commit in the deployed bundle: `d29ffe6`.
- Service MainPID **92072**, `active (running)` since `2026-11-06 15:39:16 +07`,
  `NRestarts=0`.
- tmux server PID **1204277**; sessions `$0`/`$1`/`$2`, panes `%0`/`%1`/`%2`,
  pane pids 1204278/2080435/2082046, none dead; unsorted snapshot hash
  `4d95021f…de48`.
- Assets (disk == loopback == public):
  - `index.html` `79abb38cb2344d68be299c3d923cbd1d205cb7b1b14b079fb1dddc3083a4806c`
  - `assets/index-hVfEUPqx.js` `02660079191e8615ea455b8e67b096023507c888b4539569f5b06fd5778a035b`
  - `assets/index-e2muy0ow.css` `ca7c06d554a6731ae852924c2aa8aba9060fb6fdd909839509eab27d131fccc5`
- Loopback `/` → `200`, `cache-control: no-cache`, `referrer-policy:
  no-referrer`, body hash matches disk exactly. Public surface reachable at
  `https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net` (tailnet-only) and
  byte-identical.
- **Static root: path computed at registration, one `realpathSync` applied once.**
  `apps/server/src/static-web.ts:173-178` captures `webRootReal`; every request
  joins against that captured value (`static-web.ts:257-260`) while only
  `existsSync(options.webDistDir)` (`static-web.ts:250`) is re-evaluated. There
  is no `@fastify/static`; a custom `O_NOFOLLOW` open + per-request `stat`
  (`static-web.ts:106-107`) streams each file, with SPA fallback at
  `static-web.ts:276-288`.
