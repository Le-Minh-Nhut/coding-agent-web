# History recovery and mobile UX — baseline

Captured before any change in this round, on the owner's live machine, with the
OMP sessions running. Everything here is an observation, not an inference; the
few things that could not be observed are named as such at the end.

## Repository

| Item | Value |
| --- | --- |
| HEAD at audit start | `9a4ab8cd422f7605eb9647023f40dc47a516ea09` (`main`) |
| Working tree | clean (`git status --porcelain` empty) |
| Deployed code revision | `d00281a` (docs-only commits follow it; it is an ancestor of `51a9e30`, whose CI run 93 was green) |
| CI at HEAD | run 98 on `3b43b1d` completed successfully |

## Service

| Item | Value |
| --- | --- |
| Unit | `coding-agent-web.service` (user), `active (running)` since 2026-11-06 11:14:40 +07 |
| Main PID | `3831506` |
| Command | `node --import tsx apps/server/src/server.ts` (source, not `dist`) |
| cwd | `/home/heheboiz/data/coding-agent-web` |
| Ports | 8791 (HTTP/API/relay attachment), 8792 (relay) |
| Public origin | `https://heheboiz-legion-5-15arh7.tail8d8eff.ts.net` (Tailscale Serve → `127.0.0.1:8791`) |
| Config | `caw.config.json`, `maxActiveAgents: 3` |

## Deployed frontend assets

| Asset | SHA-256 |
| --- | --- |
| `assets/index-DVGo8aHh.js` | `39b4433276d3d697d1c677483fa08f52718b4ab14b769044840b9b432fef1435` |
| `assets/index-Cwr45H40.css` | `9040b1fdf54c0293f20dae907526b114f8d0a75036a41b99afd2165b141036ac` |

The served `index.html` references exactly those two files, and the served bytes
match `apps/web/dist` (static files are read from disk, so a web rebuild is live
without a service restart). `index.html` is `cache-control: no-cache`; hashed
assets are `immutable`.

## CAW conversations

Five conversations in `metadata.jsonl` (66 rows; ops: `project` ×6,
`project-cascade-delete` ×1, `conversation` ×45, `event` ×14). No `setting` row
exists, so the effective agent limit is the config default of 3.

| Conversation | State | `nativeSessionId` | `nativeSessionPath` | tmux | pane pid | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `c3dc09cb…` | idle | `01a19c13-…` | set | `$0` | 1204278 | DOCKER: Quét Docker trên máy |
| `01321407…` | unknown | `01a17ac9-…` | set | `$1` | 2080435 | 📏 CTX: Debug 1M context limit 400 |
| `b2dc0c99…` | idle | `01a1aa0b-…` | **null** | `$2` | 2082046 | New chat |
| `3920a48b…` | stopped | `01a172d5-…` | null | — | — | PUSH: Build and deploy mobile coding-agent client |
| `af9f907f…` | error | **null** | null | — | — | New chat |

## Native OMP sessions (live)

`omp collab list --json` reports three hosts; the registry is the authority for
which native session each live process serves.

| Host PID | Registry `sessionId` | Registry `sessionName` | cwd | busy | relayConnected | Started |
| --- | --- | --- | --- | --- | --- | --- |
| 1204278 | `01a19c13-05c6-75dc-9a9a-e634313b598f` | DOCKER: Quét Docker trên máy | `/home/heheboiz/data/cir` | false | true | 2026-11-05 03:27 |
| 2080435 | `01a1a258-cc57-7051-8c6c-c35e6c735795` | 📏 CTX: Điều tra setup-token không được tạo | `/home/heheboiz/data/coding-agent-web` | false | true | 2026-11-05 11:48 |
| 2082046 | `01a1aa0b-fec4-7629-8043-6993c82d793f` | OMP: Fix smoke test settings persistence | `/home/heheboiz/data/coding-agent-web` | **true** | true | 2026-11-05 11:51 |

Two discrepancies with the CAW metadata are visible here and are **not** the
reported bug; they are recorded so they cannot be mistaken for it later:

- `b2dc0c99` ("New chat") is **bound to a session it did not create**. Its pane
  process `2082046` was launched *without* `--resume` (argv: `omp
  --config=…/b2dc0c99-….yml`, no resume operand), but OMP adopted the native
  session `01a1aa0b` from the project's most recent session. The conversation row
  still has `nativeSessionPath: null`, so the two roles of that column have
  diverged: `nativeSessionId` is the live host's session, while
  `nativeSessionPath` is the journal CAW would resume — and there is none.
- `01321407` records `01a17ac9` but its live host serves `01a1a258`. A fork
  journal for `01a1a258` exists, consistent with the known OMP fork-on-concurrent-writer
  behaviour rather than with data loss. The CAW row holds the pre-fork identity.

Both are real and worth a follow-up; neither explains the blank screen, because
the *route does not consult them* (see the report).

## Native journals (for the three bound sessions)

| Session | Journal | Lines | Bytes |
| --- | --- | --- | --- |
| `01a19c13-…` | `…/-data-cir/2026-11-02T11-44-14-790Z_01a19c13-….jsonl` | 70 | — |
| `01a1aa0b-…` | `…/-data-coding-agent-web/2026-11-05T04-51-15-268Z_01a1aa0b-….jsonl` | 4907 | ~10.6 MB, observed growing during the audit (10,589,333 → 10,771,231), so this is the live writer |
| `01a17ac9-…` | `…/-data-coding-agent-web/2026-10-27T00-36-52-191Z_01a17ac9-….jsonl` | 626 | — |

`01a1aa0b` is by far the largest: it is the conversation that renders blank.

## tmux identity

Socket `~/.local/state/coding-agent-web/tmux.sock`. Sessions are addressed by
`#{session_id}`, never by name.

| Session id | Name | Pane pid | Command | cwd | Created |
| --- | --- | --- | --- | --- | --- |
| `$0` | `caw-DOCKER--Qu-t-Docker-tr-n-m-y-c3dc09cb` | 1204278 | `omp` | `/home/heheboiz/data/cir` | 2026-11-05 03:27 |
| `$1` | `caw-CTX--Debug-1M-context-limit-400-01321407` | 2080435 | `omp` | `/home/heheboiz/data/coding-agent-web` | 2026-11-05 11:48 |
| `$2` | `caw-New-chat-b2dc0c99` | 2082046 | `omp` | `/home/heheboiz/data/coding-agent-web` | 2026-11-05 11:51 |

All three pane pids verified alive (`kill -0`) at audit time. Three sessions
equals the active limit of three, so a further launch would currently be refused
`conflict_limit`.

## Test baseline

| Check | Result |
| --- | --- |
| `npx vitest run` (full) | 1687 passed, 8 skipped, 189 files (last full run before this round) |
| `pnpm -r typecheck` | clean |
| `playwright test --project=chromium` | 115 passed, 0 failed (before this round's specs) |
| `scripts/verify-agent-limit.mjs` | limit is real, validated, and persists across restart (3 → 7 → refused 9999 → restart → 7) |

The 8 skipped tests are pre-existing and require either a launched agent or a
real `systemctl` unit; they are reported as skipped, never as passing.

## Known limitations of this baseline

- **No physical iPhone was used.** Every browser claim in this round comes from
  Chromium at an emulated iPhone viewport, plus WebKit where the machine has it.
  Safari-on-device behaviour (backgrounding, safe areas, real keyboard) is
  **BLOCKED**, not verified.
- **No authenticated read of the deployed API.** That needs the owner's password.
  `GET /api/agent-limit` answers `401` unauthenticated, which proves the route is
  mounted, not that it returns the right value.
- **`omp` is a compiled binary.** Protocol and CLI behaviour below is read from
  the cached upstream source at `~/.cache/r35-omp/src-v18.15.0` (OMP 18.15.0) and
  cross-checked against the installed binary's observed output; where the two
  could differ, the observed output is what is recorded.
- The registry's `busy` flag is a turn-in-flight hint only and is never read as
  "idle" or "finished".
