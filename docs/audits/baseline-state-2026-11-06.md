# Baseline state — 2026-11-06 (read-only reconnaissance)

Captured on the owner's live machine at 2026-11-06 21:47 +07, with the service
running and three OMP agents alive. No source file was edited, no service was
restarted, no OMP session was signalled, and no Playwright perf spec was run
(another worker was profiling on this machine during the capture).

---

## 1. Git state

```console
$ git log --oneline -5
b0114e3 docs: state the last CI runs and separate the code-bearing revision
6b7eef1 docs: mark the amber-chip finding not reproduced, and why
091e8f4 docs: fix two report defects and settle the comparator/cache claim by measurement
46e26dc docs: finalise the deployment section — CI run 109 passed, served assets verified
018e607 fix(web): make the running header read as one control, and record what the pixels showed

$ git rev-parse HEAD
b0114e3f8a5dc59b298cdd2253506001629ebb98

$ git branch --show-current
main

$ git status --porcelain
?? tests/e2e/perf-scroll-harness.ts
?? tests/e2e/perf-scroll.spec.ts
?? tests/e2e/png.ts

$ git log --oneline origin/main -3
b0114e3 docs: state the last CI runs and separate the code-bearing revision
6b7eef1 docs: mark the amber-chip finding not reproduced, and why
091e8f4 docs: fix two report defects and settle the comparator/cache claim by measurement
```

| Item | Value |
| --- | --- |
| HEAD | `b0114e3f8a5dc59b298cdd2253506001629ebb98` |
| Branch | `main` (== `origin/main`; no ahead/behind) |
| Worktree | three **untracked** files only; no tracked modification, no staged change |
| Untracked | `tests/e2e/perf-scroll-harness.ts`, `tests/e2e/perf-scroll.spec.ts`, `tests/e2e/png.ts` |

The three untracked files appeared during this capture (mtimes 21:46–21:47) and
belong to the sibling worker profiling the scroll path; they are not part of any
commit. Nothing else in the tree changed while this file was written.

---

## 2. Previous performance commits

```console
$ git show --stat 6c33db1 2d819d3 018e607
6c33db1 perf(web): make streaming into a 4075-entry transcript cheap
 14 files changed, 1222 insertions(+), 51 deletions(-)
   apps/web/src/{advisor,agent-transcript}.ts, components/{AdvisorPanel,AgentDetail,
   AgentsCenter,ConversationView,FileDiffView,MessageRow,NoticeRow}.tsx, styles.css,
   tests/e2e/perf-cost.spec.ts, tests/web/{perf-derivations.test.ts,
   round57-performance.test.tsx, round57-panel-cost.test.tsx}
2d819d3 perf(web): compact running header on every phone width, and the round's gates
 5 files changed, 2226 insertions(+), 2 deletions(-)
   apps/web/src/styles.css, docs/audits/CAW_PERFORMANCE_AND_MOBILE_UX_REPORT.md,
   tests/e2e/{mobile-performance.spec.ts, perf-fixtures.ts, perf-running-header.spec.ts}
018e607 fix(web): make the running header read as one control, and record what the pixels showed
 11 files changed, 158 insertions(+), 58 deletions(-)
   apps/web/src/styles.css, CAW_PERFORMANCE_AND_MOBILE_UX_REPORT.md,
   8 × docs/audits/assets/round57/*.png (byte-size changes), tests/e2e/perf-running-header.spec.ts
```

| Commit | One-line summary |
| --- | --- |
| `6c33db1` | perf(web): make streaming into a 4075-entry transcript cheap — code + 4 new perf test files, 1222/51. |
| `2d819d3` | perf(web): compact running header on every phone width, and the round's gates — CSS + the perf report and 3 E2E perf specs, 2226/2. |
| `018e607` | fix(web): make the running header read as one control, and record what the pixels showed — CSS + refreshed round57 PNGs + spec update, 158/58. |

Parent listed: full subjects verbatim above; the `--stat` blocks are abridged to
the file list because the file-per-line body is long and adds nothing here.

---

## 3. Deployment state

`deploy/status.sh` is read-only (it resolves binaries, reads the unit's
`systemctl --user show` properties, `curl`s loopback for an HTTP code, reads
`tailscale serve status`, lists sessions on the private tmux socket, and prints
`journalctl --user -p warning..alert`). It was run unmodified.

```console
$ bash deploy/status.sh
enabled: enabled
running: active
ActiveEnterTimestamp=Fri 2026-11-06 15:39:16 +07
MainPID=92072
MemoryCurrent=110272512
CPUUsageNSec=94501472000
Service uptime: 21842s
HTTP readiness: 200
https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8791

Managed main OMP agents: 3
<20 lines of journalctl: "Found left-over process 1204277 (tmux: server) in control
 group while starting unit. Ignoring." at each of 10 prior starts — see below>
```

`systemctl status coding-agent-web.service --no-pager` at the **system** scope
returns `Unit coding-agent-web.service could not be found.` (exit 4) — the unit
is a **user** unit. At the user scope:

```console
$ systemctl --user show coding-agent-web.service -p MainPID -p ActiveEnterTimestamp -p MemoryCurrent -p CPUUsageNSec
ActiveEnterTimestamp=Fri 2026-11-06 15:39:16 +07
MainPID=92072
MemoryCurrent=107032576
CPUUsageNSec=94529662000

$ systemctl --user status coding-agent-web.service --no-pager   (head)
● coding-agent-web.service - Coding Agent Web
     Loaded: loaded (/home/heheboiz/.config/systemd/user/coding-agent-web.service; enabled; preset: enabled)
     Active: active (running) since Fri 2026-11-06 15:39:16 +07; 6h ago
   Main PID: 92072 (node)
      Tasks: 13 (limit: 17473)
     Memory: 104.4M (peak: 415.5M, swap: 18.8M, swap peak: 102.2M)
        CPU: 1min 34.505s
     CGroup: /user.slice/user-1000.slice/user@1000.service/app.slice/coding-agent-web.service
             ├─  92072 node --import tsx /home/heheboiz/data/coding-agent-web/apps/server/src/server.ts
             └─1204277 tmux -S /home/heheboiz/.local/state/coding-agent-web/tmux.sock new-session -d -P -F "#{session_id}\t#{socket_path}:#{start_time}:#{pid}" -s caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb -c /home/heheboiz/data/cir omp --config=…/c3dc09cb-….yml --resume /home/heheboiz/.omp/agent/sessions/-data-cir/2026-11-02T11-44-14-790Z_01a19c13-….jsonl
```

| Item | Value |
| --- | --- |
| Unit | `coding-agent-web.service` (**user** unit) |
| State | `enabled`, `active (running)` since `Fri 2026-11-06 15:39:16 +07` (~6h at capture) |
| MainPID | `92072` — `node --import tsx apps/server/src/server.ts` (source, not `dist`) |
| Uptime | 21842 s (≈6h04m) as reported by `status.sh` |
| Loopback HTTP | `200` on `http://127.0.0.1:8791/` |
| Public origin | `https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net` (Tailscale Serve → `127.0.0.1:8791`, tailnet only) |
| tmux sessions on the private socket | 3 (the `maxActiveAgents: 3` limit is full) |

Journal warning the script prints on every start, quoted once, verbatim:

```
Found left-over process 1204277 (tmux: server) in control group while starting unit. Ignoring.
This usually indicates unclean termination of a previous run, or service implementation deficiencies.
```

### Served assets vs `apps/web/dist`

```console
$ curl -s https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net/ | grep -o 'assets/[a-zA-Z0-9._-]*'
assets/index-C2QexEsC.js
assets/index-C6e9qhob.css
```

| Asset | `apps/web/dist` sha256 | served over loopback | served over the public origin |
| --- | --- | --- | --- |
| `assets/index-C2QexEsC.js` | `d3a9a9b50f09d231fa3764c09d57cd45ffb555cca0e72a91645fb89da726ba89` | same | same |
| `assets/index-C6e9qhob.css` | `1870cb75415f0954ffdfd958bda6c927db73ed5f26a99af0388a7716450d4a61` | same | same |
| `index.html` | `04971d1fa7721ddea10fe6c4559de2b77369700e4e09fb46ebcc432f1e59c90c` | same | same |

All six hashes (3 files × dist, loopback, public) are identical: the origin is
serving exactly the current `apps/web/dist` build, with no rebuild needed and no
restart (static files are read from disk). `apps/web/dist/` contains only
`index.html`, `manifest.webmanifest`, `assets/index-C2QexEsC.js` (455.7 K),
`assets/index-C6e9qhob.css` (49.0 K), `icons/`.

---

## 4. Live OMP safety inventory (READ ONLY)

The tmux socket convention is `join(config.stateDir, "tmux.sock")`
(`apps/server/src/tmux-service.ts:25`, `privateTmuxSocketPath`), wired through
`packages/omp-adapter/src/tmux.ts` as `-S <path>`. From the repo config,
`stateDir` resolves to `~/.local/state/coding-agent-web`.

```console
$ tmux -S ~/.local/state/coding-agent-web/tmux.sock list-sessions -F '#{session_id} #{session_name} pane_pid=#{pane_pid}'
$1 caw-CTX--Debug-1M-context-limit-400-01321407 pane_pid=2080435
$0 caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb pane_pid=1204278
$2 caw-New-chat-b2dc0c99 pane_pid=2082046

$ tmux -S … list-panes -a -F '#{session_id} … pane_dead=#{pane_dead} cmd=#{pane_current_command}'
$1 … pane_pid=2080435 pane_dead=0 cmd=omp
$0 … pane_pid=1204278 pane_dead=0 cmd=omp
$2 … pane_pid=2082046 pane_dead=0 cmd=omp
```

| tmux id | Name | pane pid | pane cmd | alive |
| --- | --- | --- | --- | --- |
| `$0` | `caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb` | 1204278 | `omp` | yes (pane_dead=0) |
| `$1` | `caw-CTX--Debug-1M-context-limit-400-01321407` | 2080435 | `omp` | yes |
| `$2` | `caw-New-chat-b2dc0c99` | 2082046 | `omp` | yes |

`pgrep -af` filtered to `omp` (chrome/bwrap internals excluded; 19 raw matches,
the two CAW agents plus unrelated eval/daemon workers):

```console
1204278 omp --config=…/overlays/c3dc09cb-da7f-4d0b-88a3-103651dca7f2.yml --resume …/-data-cir/…_01a19c13-….jsonl
2080435 omp --config=…/overlays/01321407-6b88-45fe-8e80-fd1801069fb6.yml --resume …/-data-coding-agent-web/…_01a17ac9-….jsonl
2082046 omp --config=…/overlays/b2dc0c99-5857-4ad4-9b60-59b84d770f7c.yml
<strings>  omp -e setInterval(() => {}, 60000)   × 9  (1960296, 1961319, 2036649, 2038277, 2039799, 2041079, 2059388, 2060424, 2061493)
12809, 2125831, 3618048  /home/heheboiz/.local/bin/omp __omp_worker_daemon_broker
474031                   /home/heheboiz/.local/bin/omp __omp_worker_text_predict
2090691                  /home/heheboiz/.local/bin/omp __omp_worker_js_eval_process
2125857                  /home/heheboiz/.local/bin/omp browser-relay --port 9224
2568432                  omp
1204277                  tmux … new-session -d -P -F … -s caw-DOCKER-… -c /home/heheboiz/data/cir omp --config=… --resume …
```

No signal was sent. The three pane pids are the authority for "the CAW agents are
alive"; the extra `omp` processes are unrelated to the app's private socket.

---

## 5. Tooling availability

```console
$ node --version     → v20.19.5
$ pnpm --version     → 10.32.1
$ npx playwright --version → Version 1.64.1
$ ls ~/.cache/ms-playwright
ffmpeg-1013
webkit-2370
$ /usr/bin/google-chrome --version → Google Chrome 155.0.8059.84

$ npx playwright install --dry-run webkit
WebKit 27.2 (playwright webkit v2370)
  Install location:    /home/heheboiz/.cache/ms-playwright/webkit-2370
  Download url:        https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2370/webkit-ubuntu-26.04.zip
  …
FFmpeg (playwright ffmpeg v1013)
  Install location:    /home/heheboiz/.cache/ms-playwright/ffmpeg-1013
```

| Item | Observed |
| --- | --- |
| Node | `v20.19.5` |
| pnpm | `10.32.1` |
| `npx playwright --version` | `1.64.1` |
| Browser builds installed | **`webkit-2370`** and **`ffmpeg-1013`** only. **No `chromium-*`** (config uses system Chrome via `channel: "chrome"`). Also no `firefox-*`. |
| System Chrome | `/usr/bin/google-chrome` → `155.0.8059.84` |
| `npx playwright install --dry-run webkit` | prints the WebKit 27.2 / v2370 entry with **`Install location: ~/.cache/ms-playwright/webkit-2370`**. |

**Dry-run semantics matter here:** `--dry-run` prints the *plan* (the location it
would use) and does **not** report absence — a control run against
`PLAYWRIGHT_BROWSERS_PATH=/tmp/nonexistent-pw-path` printed the same block with
that path. So the command does **not** say "webkit missing"; what says WebKit is
present is the cache listing (`webkit-2370/` containing `minibrowser-gtk/`,
`protocol.json`, `pw_run.sh`, `INSTALLATION_COMPLETE`), and what says Chromium is
absent is the same listing. Direct confirmation of "webkit missing" via the
playwright CLI is **NOT AVAILABLE**; the cache listing is the evidence.

---

## 6. Model catalog presence (read-only)

```console
$ omp --version
omp/18.15.0

$ omp models find DeepSeek-V4.1-Flash-1017 --json
{"models":[{"provider":"9router","kind":"chat","id":"or/deepseek/deepseek-v4.1-flash-1017",…},
{"provider":"9router","kind":"chat","id":"wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",…}]}
```

`wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017` **is present** in the catalog. Matching
entry verbatim from `omp models --json`:

```json
{
  "provider": "9router",
  "kind": "chat",
  "id": "wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "selector": "9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "name": "wdb/deepseek-ai/DeepSeek-V4.1-Flash-1017",
  "contextWindow": 1000000,
  "maxTokens": 128000,
  "reasoning": true,
  "thinking": ["low", "high", "max"],
  "input": ["text", "image"],
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
  "pricingStatus": "unknown"
}
```

No config was changed. A sibling alias also exists in the same catalog:
`or/deepseek/deepseek-v4.1-flash-1017` (same provider/limits).

---

## 7. Screenshot assets

`docs/audits/assets/` has exactly one subdirectory:

| Path | mtime |
| --- | --- |
| `docs/audits/assets/round57/` | 2026-11-06 19:11 (dir); files 19:42 |

Newest-first image listing in `docs/audits/assets/` (all 8, in `round57/`):

| File | Pixels |
| --- | --- |
| `docs/audits/assets/round57/running-320x568.png` | 640 × 1136 |
| `docs/audits/assets/round57/idle-430x932.png` | 860 × 1864 |
| `docs/audits/assets/round57/idle-390x844.png` | 780 × 1688 |
| `docs/audits/assets/round57/running-430x932.png` | 860 × 1864 |
| `docs/audits/assets/round57/running-390x844.png` | 780 × 1688 |
| `docs/audits/assets/round57/idle-375x667.png` | 750 × 1334 |
| `docs/audits/assets/round57/idle-320x568.png` | 640 × 1136 |
| `docs/audits/assets/round57/running-375x667.png` | 750 × 1334 |

(All eight share the 19:42 mtime; bytes are the saved RGB PNGs at DPR 2.)

**Most recent "current UI" screenshots:** the eight `docs/audits/assets/round57/`
files above (idle-* and running-* at 320×568, 375×667, 390×844, 430×932), produced
by `tests/e2e/perf-running-header.spec.ts` against the built bundle. Older current-UI
captures still on disk: `docs/assets/screens/round55/` (newest
`files-center-from-card.png`, 2026-11-06 19:43, 780 × 1688) and the external scratch
dir `~/.cache/caw-screens/` (newest `viewport-1440x900.png` etc., 2026-11-06 19:48;
dims 640×1136 … 2880×1800), which the screenshot policy keeps out of git.

**Premium-reference screenshot: NOT FOUND as a tracked or named artifact.**
`grep -rin premium docs/` matches only `docs/audits/round54-premium-mobile-design.md`
(whose §1 states *"from the brief; the screenshot itself was not available"*) and one
sentence in `FINAL_HISTORY_UX_PLAYWRIGHT_REPORT.md:266` ("the owner's premium
reference"). No `*premium*`/`*reference*` image exists in the repo or in
`~/Downloads`, `~/Pictures`, `~/Desktop`.

The only plausible owner-supplied candidates on this machine, reported by path and
size only (contents not read or described here):

| Path | Pixels | mtime |
| --- | --- | --- |
| `/home/heheboiz/Pictures/Screenshots/Screenshot From 2026-11-06 00-15-26.png` | 1919 × 1009 | 2026-11-06 00:15 |
| `/home/heheboiz/Pictures/Screenshots/Screenshot From 2026-11-06 00-15-21.png` | 1919 × 1009 | 2026-11-06 00:15 |
| `/home/heheboiz/Pictures/Screenshots/Screenshot From 2026-11-03 01-35-03.png` | 1426 × 325 | 2026-11-03 01:35 |
| `/home/heheboiz/Pictures/Screenshots/Screenshot From 2026-10-31 09-38-07.png` | 1228 × 175 | 2026-10-31 09:38 |

Whether any of these is the premium reference is **UNVERIFIED** (would require
reading the image; AGENTS.md rule 11 forbids the main agent doing so).

---

## 8. Web/test suite inventory (commands the repo defines)

Exact scripts from the root `package.json`:

| Script | Command |
| --- | --- |
| `typecheck` | `pnpm -r typecheck` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `test:e2e` | `playwright test --project=chromium` |
| `test:e2e:all` | `playwright test` |
| `compat` | `node scripts/compat-check.mjs` |
| `typecheck:compat` | `tsc -p tsconfig.compat.json --noEmit` |
| `build` | `pnpm -r build` |
| `guest:build` | `node scripts/build-guest.mjs` |
| `dev` / `start` | `pnpm --filter @caw/server dev` / `start` |
| `format` / `format:check` | `prettier --write .` / `prettier --check .` |

Per-package `typecheck` (what `pnpm -r` fans out to): `apps/web` `tsc -p tsconfig.json
--noEmit`; `apps/server` `tsc -p tsconfig.json --noEmit`; `packages/{contracts,omp-adapter,
relay,runtime,guest}` `tsc -p tsconfig.json --noEmit`. `apps/web build` is `vite build`;
`apps/server start` is `tsx src/server.ts` (documented in its `//start` note).

**Perf-related scripts: there are none in `package.json`.** Perf lives in specs
invoked directly:

| Path | Role |
| --- | --- |
| `tests/e2e/mobile-performance.spec.ts` | added by `2d819d3` |
| `tests/e2e/perf-fixtures.ts` | fixtures for the perf specs |
| `tests/e2e/perf-running-header.spec.ts` | round57 running-header captures + geometry |
| `tests/e2e/perf-cost.spec.ts` | added by `6c33db1` |
| `tests/e2e/round50-measure.spec.ts` | earlier measurement spec |
| `tests/web/perf-derivations.test.ts`, `round57-performance.test.tsx`, `round57-panel-cost.test.tsx` | unit-level perf logic |
| `tests/e2e/perf-scroll.spec.ts`, `perf-scroll-harness.ts`, `png.ts` | **untracked, sibling worker, in progress** |

Relevant config facts: `playwright.config.ts` runs **serial** (`fullyParallel: false`,
`workers: 1`), `testDir: ./tests/e2e`, viewport 390×844 DPR 2 with `channel: "chrome"`,
and **omits WebKit by its own rule unless a `webkit-*` bundle is present** — it is
present here (`webkit-2370`), so `test:e2e:all` would include the `webkit` project.
`vitest.config.ts` halves the machine (`maxWorkers = max(2, availableParallelism()/2)`)
and excludes `tests/e2e`.

---

## Blocked / not run

| Item | Reason |
| --- | --- |
| Playwright perf/scroll specs | Deliberately not run — sibling worker owned machine timing. |
| "webkit missing" verdict from the playwright CLI | `install --dry-run` does not report absence (proven with a fake browsers path); verdict taken from the cache listing instead. |
| Premium-reference screenshot identification | No such artifact exists by name in the repo/home; the `~/Pictures/Screenshots` 1919×1009 candidates are unverified (contents not read — AGENTS.md rule 11). |
| `systemctl status coding-agent-web.service` (system scope) | Unit not found at system scope (exit 4); it is a user unit — captured with `--user`. |
| Full `git show --stat` body for the three perf commits | Abridged to file lists; full per-file line counts are one `git show` away. |
| Anything requiring the owner's password (authenticated live-origin walks) | No credential held; not attempted. |
