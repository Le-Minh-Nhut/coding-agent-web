# Real-OMP Acceptance Run Plan & Evidence

Verification plan and observed results for Coding Agent Web driving real OMP agent processes on the Ubuntu host machine.

---

## 1. Four-Tier Verification Matrix

| Tier | Exact Command Line | Prerequisites & Environment | Spends Credits? |
| :--- | :--- | :--- | :--- |
| **Tier 1: Machine Capability Probe** | `node scripts/compat-check.mjs` (or `pnpm compat`) | Node 20.19+, OMP binary on `PATH`, tmux 3.2+, read access to `/proc/net/unix` and `~/.omp`. Spawns no agent. | **No** (Costs nothing) |
| **Tier 2: Real-OMP Compat Suite** | `CAW_COMPAT=1 npx vitest run tests/compat` | Vitest, Node 20.19+, functional OMP binary, tmux, active provider auth (`omp models`), disposable workspace under `/tmp`. Launches real agent processes into isolated test-scoped tmux servers. | **Yes** (Launches real agents; opt-in) |
| **Tier 3: Browser E2E Suite** | `TMPDIR=$HOME/.cache pnpm test:e2e` | Built web app (`pnpm --filter @caw/web build`), built guest bundle (`node scripts/build-guest.mjs`), Playwright Chromium, room in `TMPDIR`. `CAW_OMP_BINARY_PATH` pins the one `omp` binary the server runs — registry *and* agent launch — to a recorder stub, with a PATH canary behind it. | **No** (a launched "agent" is the stub, which exits immediately; `tests/e2e/no-launch-guard.spec.ts` proves it from the recorder logs). |
| **Tier 4: Acceptance Script (UI Drives Agent)** | `node scripts/acceptance-ui-drives-agent.mjs --base <origin> --tmp <dir> --root <dir> --password <secret>` | Running CAW server instance with web assets, Playwright Chrome channel, a seeded password supplied via `--password`, directory in `allowedRoots`, active provider credentials. Creates project and conversation via UI, driving a live agent. | **Yes** (Launches real agent process via server) |

---

## 2. Preflight Inspection

Read-only preflight inspection conducted prior to launching real-agent verification:

| Check | Target / Command | Value / Observed State |
| :--- | :--- | :--- |
| **OMP version** | `omp --version` | `omp/18.12.2` |
| **tmux version** | `tmux -V` | `tmux 3.6` |
| **Node.js version** | `node --version` | `v20.19.5` |
| **CPU cores** | `nproc` | `16` |
| **Root disk available** | `df -B1 /` / `df -h /` | `3,757,137,920 bytes` (~3.5 GB available, > 1 GB threshold) |
| **Repo config file** | `caw.config.json` at repo root | **Does not exist** (`no`) |
| **State directory** | `~/.local/state/coding-agent-web` | **Exists** (`true`, contains `auth-password.json`, `overlays/`) |
| **Running OMP processes** | `pgrep -a omp` | Baseline: 8 processes (3 CLI/agent PIDs: `1129996`, `2347340`, `3138100`; 5 daemon/mux PIDs: `1146759`, `2350604`, `2355085`, `2400133`, `2950248`; 9 kernel worker threads matching substring `comp`) |
| **Default tmux sessions** | `tmux ls` | 1 preexisting session: `caw-Integration-check` |
| **App private socket** | `tmux -S ~/.local/state/coding-agent-web/tmux.sock ls` | No socket file / server not running |

---

## 3. Observed Results

### Tier 1: Machine Capability Probe (`node scripts/compat-check.mjs`)
- **Initial Run**: 17 ok, 0 warn, 1 fail.
  ```text
  FAIL collab list --json shape — version=1 hosts=0 missing=instanceId,generation,pid,sessionId,cwd,relayConnected,inputRequired,busy,access
  ```
  *Root Cause*: `omp collab list --json` returned `{"hosts":[],"version":1}` when no agent hosts were active. Probe script asserted per-host fields on an empty array.
- **Post-Fix Run**: 17 ok, 1 warn, 0 fail.
  ```text
  warn collab list --json shape — version=1 hosts=0 — no collab hosts running; per-host shape unverifiable without a live host
  ```
  *Resolution*: `scripts/compat-check.mjs` updated to verify `version === 1` and treat empty host list as `warn` rather than `fail`, with assert-based self-check covering empty hosts (`warn`), malformed host rows (`fail`), and non-v1 schema (`fail`).
### Tier 2: Real-OMP Compat Suite (`CAW_COMPAT=1 npx vitest run tests/compat`)
- **Summary**: 2 test files passed, 8 tests passed, 0 failed (Duration: 55.00s).
- **Test files**:
  - `tests/compat/omp-lifecycle.test.ts` (1 passed)
  - `tests/compat/reconciliation.test.ts` (7 passed)
- **Failures**: None.
- **Process Cleanup**: Every agent spawned by the test runner was terminated by the suite. Baseline `pgrep -x omp` count remained identical before and after.

### Tier 4: Acceptance Script (`node scripts/acceptance-ui-drives-agent.mjs`)
Server started with loopback origin (`http://127.0.0.1:8801`), relay on port `8802`, state in `/tmp/caw-acceptance/state`, and scratch root `/tmp/caw-acceptance/roots/proj`.

Verbatim output per criterion:
```text
PASS  login through the UI lands on the projects screen — http://127.0.0.1:8801/
PASS  conversation created (launches a real agent) — tmux $0
PASS  the agent published its native session — 01a1741d-4e2a-7641-a7e2-18240cfe6c24
PASS  state reflects a live agent — idle
PASS  a live session link is minted — {"status":200,"ok":true,"code":null,"urlPrefix":"http://127.0.0.1:8801/","secretBytes":109,"access":"full"}
PASS  our UI opened a guest socket to the relay — ws://127.0.0.1:8801/r/OZNa4KjeuWa79WwdciT2Kw
PASS  the conversation screen reports a live session — ← | Acceptance run | Effective model: 9router/wdb/deepseek-ai/DeepSeek-V4.1-Flash | Activity | Agents (1) | Conversation model settings
```

**Read that block as observation, not as assertion.** It is a hand-picked transcript, not the script's `RESULTS JSON`, and only the first two lines above are the script's own `pass(...)` records (`check1` at `acceptance-ui-drives-agent.mjs:903`; `check2c` at `:933`). Four of these criteria are **collected but never asserted** by the script as it stands:

| Criterion in the block above | Actual status in `scripts/acceptance-ui-drives-agent.mjs` |
| :--- | :--- |
| login through the UI → projects screen | Asserted: `pass("check1", …)` at `:903`. |
| conversation created, real agent launched | Asserted: `pass("check2c", "chat launch published tmux, native-session, and host identity", …)` at `:933`, reached only after `waitFreshConversation` (`:545-555`) has seen `tmuxSessionId`, `nativeSessionId` and `hostInstanceId`. |
| "state reflects a live agent — idle" | **Observed, not asserted.** `conversation.state` is interpolated into `check2c`'s evidence string (`:933`) only; no `pass`/`fail` predicate tests `state === "idle"`. |
| "a live session link is minted" | **Observed, not asserted.** Link responses are collected at `:2155` and read only inside check4's control gate (`:1042-1050`); no standalone pass/fail label. check15 mints a link at `:1889` but records failure as `skip` (`:1890-1893`), not `fail`. |
| "our UI opened a guest socket to the relay" | **Observed, not asserted at all.** `socketLog` is pushed at `:2158-2161` with a frame counter and is **never read** — `grep -n socketLog` finds only the declaration (`:509`) and that push (`:2160`). |
| "the conversation screen reports a live session" | **Observed, not asserted.** No such label exists; the nearest screen check is `check4`'s control evidence (`:1048`, reported inside `pass("check4a", …)` at `:1066`). |

Keep this section as the record of what the script *does* assert; do not treat the transcript above as coverage for the last four rows.


## Round 9 — real-OMP acceptance

Tier 4 defines fifteen checks, `check1` … `check15` (`acceptance-ui-drives-agent.mjs:862-1962`; `:2067-2068 knownChecks = Object.keys(checks)`), including a prompt → reply → journal verification. **"Fifteen checks exist" is not "fifteen scenarios were verified."** Counts are per *criterion record*, not per check — each check emits several. One isolated real-OMP run completed against OMP `18.12.2` and reported `PASS 15 / FAIL 2 / SKIP 0` over a **partial selection**: that run passed `--only check1,check2,check4,check5,check7,check9,check10`, i.e. 7 of the 15 checks, so 17 criterion records came from 7 checks and the remaining 8 checks were recorded `NOT SELECTED` (`:2202 for (const name of notSelected) record(name, "NOT SELECTED", …)`).

Exact command:

```sh
node scripts/acceptance-ui-drives-agent.mjs --base http://127.0.0.1:8801 --tmp $HOME/.cache/caw-acc-final2 --root $HOME/.cache/caw-acc-final2/roots --password 'a-12-character-secret' --only check1,check2,check4,check5,check7,check9,check10
```

The harness owns the scratch tree and app state. It used a separate `HOME`, `PI_CODING_AGENT_DIR`, and `XDG_STATE_HOME`, plus private `omp-home`, `omp-agent`, and session directories under `--tmp`; it copied `config.yml`, `models.yml`, and `agent.db` into the scratch agent profile. The CAW server had its own `state/`, private tmux socket, and allowed root. The provider database and config copies were mode `0600`; credentials/config contents were not logged. The copy of the owner profile supplied authentication/config only, not the app's run target.

Verbatim PASS/FAIL lines:

```text
PASS provider database copied to scratch without logging secrets — /home/heheboiz/.cache/caw-acc-final2/omp-agent/agent.db (mode 0600)
PASS login through the UI (seeded password) lands on the projects screen — url=http://127.0.0.1:8801/
PASS project created from a folder typed in the UI — id=bd057638-2c4b-42b9-b158-0b1d8d31db7c; folderText="📁 proj-caw-acc-a42aa1\nSELECTED" browserSelectedPath=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 UI-selected-path=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 UI-card-visible=true API-status=200 API-project-path=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 API-projects=Acceptance CAW-ACC-a42aa1: /home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1
PASS project path matches selected folder and typed folder — selected=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1 API=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1
PASS chat launch published tmux, native-session, and host identity — state=idle tmux=$0 native=01a17839-0c0c-7386-afa6-8b504bfa5aaa host=ccec7024375c6dab
PASS tmux pane cwd equals the project path — pane_current_path=/home/heheboiz/.cache/caw-acc-final2/roots/proj-caw-acc-a42aa1
PASS user echo appears exactly once in transcript — marker=CAW-ACC-a42aa1-4 attempts=1 startupRefusals=0
PASS a real assistant reply follows the prompt — CAW-ACC-a42aa1-4 ACK
PASS journal on disk contains the prompt marker — native=01a17839-0c0c-7386-afa6-8b504bfa5aaa path=/home/heheboiz/.cache/caw-acc-final2/omp-agent/sessions/-tmp-roots-proj-caw-acc-a42aa1/2026-10-26T12-39-26-988Z_01a17839-0c0c-7386-afa6-8b504bfa5aaa.jsonl
PASS journal contains the assistant reply text — needle=CAW-ACC-a42aa1-4 ACK
PASS draft typed after sending survives — value="CAW-ACC-a42aa1-5draft"
PASS both sent markers reached the host journal — CAW-ACC-a42aa1-5a + CAW-ACC-a42aa1-5b
PASS history restored exactly once after leaving and returning — user rows containing marker=1
FAIL nothing was silently resent (one user journal row) — user journal rows containing marker=0
PASS identity survives a backend restart — native=01a17839-0c0c-7386-afa6-8b504bfa5aaa tmux=$0 state=idle
PASS no second writer appeared — private tmux sessions 1→1, lease sockets 13→13
FAIL check10 ran to completion — locator.fill: Error: Element is not an <input>, <textarea> or [contenteditable] element Call log: - waiting for locator('#<redacted>
```

> **These two FAIL lines describe OMP `18.12.2` runs from the round-9 vintage of the script. Both are now stale and must not be read as current known-failures.** The script at HEAD `26874b0` no longer produces either:
> - **"nothing was silently resent"** — that criterion no longer exists. Its successor is `check7b`, "prompt reached host exactly once" (`acceptance-ui-drives-agent.mjs:1263`), and its predicate (`:1255-1257`) counts an entry when it is `custom_message`/`collab-prompt` **or** `message` with `role: "user"`. That is exactly the non-`user`-role storage that made the round-9 journal count return zero, so the measurement disagreement that produced this FAIL is fixed in the script itself — the script was corrected, not the product.
> - **"check10 … locator.fill: Element is not an `<input>`"** — the `fill()`-on-a-`<select>` bug is gone. `check10` now selects the model through `chooseModelForRestart` (`:1507`), which uses `dropdown.selectOption(chosen)` on `select#conversation-model` (`:688-696`) and falls back to `#custom-model` only when that select is absent. Round 12 subsequently recorded `check10` passing with `argv --resume <journal path>`.
>
> The round-9 text originally concluded from these two failures that "duplicate-resend risk remains unproven" and that "real-agent restart/resume remains UNVERIFIED … covered only by unit tests." Both conclusions were warranted for that vintage of the script; at HEAD the corresponding checks (`check7b`, `check10`) have since been exercised, so treat those conclusions as superseded, not as current status.

Cleanup: recorded tmux sessions and OMP PIDs exited, owner's process count was unchanged (4 before/after), and the scratch directory was removed. Real-agent checks are distinct from hermetic Chromium E2E.

### Coverage claims: what is asserted, and what is silently skipped

Read this before quoting any PASS count from this document.

- **The script asserts; it does not merely print.** Every criterion goes through `record()` (`acceptance-ui-drives-agent.mjs:137-145`), `:142` `if (status === "FAIL") failed = true;`, and the process exits non-zero (`:2235 process.exit(failed ? 1 : 0);`). Its `RESULTS JSON` block (`:2232-2233`) is the authoritative record — prefer it over the hand-picked transcript in §3 above.
- **SKIP never fails the run.** `:39` "Exit code is 1 if any check FAILed; SKIP never fails the run." A green run therefore does not prove every criterion ran. Any PASS/FAIL/SKIP tally must be read with the SKIP count.
- **A run without `--password` executes only `check1`.** `:88-89` sets `BOOTSTRAP = hasFlag("--bootstrap") || !PASSWORD`, and `:2166-2168` then records every other selected check as `NOT RUN` (`"needs --password"`) and continues. Tier 4's prerequisites must include `--password` or the run is a login smoke test.
- **Model-dependent checks skip silently when the isolated catalog has nothing usable.** If the filtered catalog is empty, `check3`, `check10` and `check11` each `skip` outright (`:948`, `:1501`, `:1569`) after a `skip("preflight-model-catalog", …)` at `:286`. So "restart/resume verified" is only claimable when a non-excluded model was present.
- **Approval-dependent checks skip when no dialog appears.** `check6` (`:1170`) and `check15` (`:1886`) `skip` if `tools.approvalMode=always-ask` did not produce an approval request, and `check15` also `skip`s if the view-only link could not be minted (`:1890-1893`). A read-only-access verification can therefore be absent from a green run.
- **The concurrency check can decline to test anything.** `check8` records `notRun("check8-race", "two concurrent chats have distinct writers", "NOT POSSIBLE VIA UI: …")` (`:1342`) when two independent browser contexts did not overlap their create request. That is a `NOT RUN`, not a pass.
- **`--only` is a subset.** `:91` parses it and `:2202` records everything else as `NOT SELECTED`. The round-9 command below selects 7 of the 15 checks; the remaining 8 were not executed in that run.
- **Provider credentials come from a copied profile.** `:221-231` copies `agent.db` from `--omp-auth-db` (mode `0600`, secrets not logged) or records `skip("preflight-agent-auth", "provider credentials", …)`.

**Therefore: a check's existence is not evidence that it ran, and a run's exit code 0 is not evidence that every scenario was verified.** Quote the `RESULTS JSON` counts (PASS / FAIL / SKIP / NOT SELECTED / NOT RUN) together with the `--only` selection, never a bare PASS total.

---

## 4. Cleanup Proof

Cleanup was executed strictly by recorded IDs and PIDs:

1. **Tmux Session Termination**:
   - Recorded session `$0` (`caw-Acceptance-run-108aa2cd`) killed via:
     `tmux -S /tmp/caw-acceptance/state/tmux.sock kill-session -t '$0'`
   - Pane PID `1280908` (`omp --config=...`) confirmed exited.
   - Private tmux server killed via:
     `tmux -S /tmp/caw-acceptance/state/tmux.sock kill-server`
   - Verification command:
     `tmux -S /tmp/caw-acceptance/state/tmux.sock list-sessions`
   - Verification result:
     `no server running on /tmp/caw-acceptance/state/tmux.sock`

2. **Server Process Termination**:
   - Recorded server process PIDs `1280564` (Node.js/Fastify) and `1280504` (pnpm) terminated.
   - Subagent node worker PID `1281065` terminated.
   - Verified process exit via `ps -p 1280504,1280564,1281065`.

3. **OMP Process Integrity**:
   - Verification command: `pgrep -x omp -a && pgrep -f '__omp_worker' -a`
   - Output matched preflight baseline exactly: PIDs `1129996`, `2347340`, `3138100` (`omp`), and worker daemons `1146759`, `2350604`, `2355085`, `2400133`, `2950248`. No lingering agent or worker survived.

4. **Filesystem Cleanup**:
   - Scratch directories `/tmp/caw-acceptance` and `/tmp/caw-final` removed.

---

## 5. iPhone Manual Verification Checklist

Automated suites run in desktop/emulated viewports, but hardware iOS Safari quirks require physical device verification. **No automated check in this repository covers any row below**, and none may be upgraded on the strength of a green automation run: the acceptance harness launches Chromium only — `chromium.launch({ channel: "chrome" })` with a `390 × 844` emulated viewport (`acceptance-ui-drives-agent.mjs:2085-2089`) — which provides no iOS Safari rendering engine, no real virtual keyboard, no `visualViewport` resize behaviour, and no Home-Screen/PWA install path. All ten rows stay **UNVERIFIED** until a physical iPhone run records otherwise.

| Item | What to watch for (One-line) | Status |
| :--- | :--- | :--- |
| **Safari login** | Password input focuses cleanly without page zoom and session cookie persists across tab switches. | **UNVERIFIED** (Requires physical iPhone) |
| **Folder selection** | Folder picker drawer navigates hierarchy and selects paths without touch lag or tap hijacking. | **UNVERIFIED** (Requires physical iPhone) |
| **Prompt submission** | Send button triggers turn immediately without requiring double taps or losing text cursor focus. | **UNVERIFIED** (Requires physical iPhone) |
| **Multiline typing** | Textarea auto-expands upward smoothly without pushing the composer off-screen. | **UNVERIFIED** (Requires physical iPhone) |
| **Keyboard resize** | Virtual keyboard appearance respects `visualViewport` without obscuring composer or sticky header. | **UNVERIFIED** (Requires physical iPhone) |
| **Long chat scrolling** | Streaming tokens append smoothly without scroll jitter, jump-to-top bugs, or momentum glitches. | **UNVERIFIED** (Requires physical iPhone) |
| **Code block copy** | Tap-to-copy button copies full block content without triggering iOS text selection magnifying glass. | **UNVERIFIED** (Requires physical iPhone) |
| **Lock/unlock the phone** | Backgrounded/suspended tab resumes WebSocket connection on wake without stale replay or silent drop. | **UNVERIFIED** (Requires physical iPhone) |
| **Reopening the same session** | Reopening existing URL or conversation card reconnects cleanly without triggering a duplicate writer conflict. | **UNVERIFIED** (Requires physical iPhone) |
| **PWA launch from Home Screen** | Standalone mode displays proper full-height layout respecting top notch and bottom Home indicator insets. | **UNVERIFIED** (Requires physical iPhone) |
