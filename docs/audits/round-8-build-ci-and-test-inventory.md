# Round 8: Build, CI, and Test Inventory

## Repository and clean-checkout verification

Initial checkout commands, run while repository was clean:

```text
git ls-files | wc -l
252

git status --porcelain
[no output]
```

At current committed HEAD after policy update, `git ls-files | wc -l` returned `262`. The shared worktree later accumulated other agent changes; the clean-clone results below validate committed HEAD independently.

### Historical pre-fix clean clone

An initial clean clone, before commit `ff3052e` tracked the guest source, installed dependencies successfully:

```text
git clone /home/heheboiz/data/coding-agent-web /tmp/caw-round8.AeWKzN/clean
Cloning into '/tmp/caw-round8.AeWKzN/clean'...
done.

pnpm install --frozen-lockfile
Scope: all 9 workspace projects
Packages: +214
Done in 3.3s using pnpm v10.32.1
```

| Command | Observed result |
|---|---|
| `node scripts/build-guest.mjs` | Failed with 11 esbuild resolution errors because guest library files were absent from Git. Exact unresolved imports and importing files listed below. |
| `pnpm --filter @caw/web build` | Passed: `✓ 45 modules transformed.`; `dist/index.html 0.97 kB`, CSS `7.30 kB`, JS `240.69 kB`; `✓ built in 755ms`. |
| `pnpm typecheck` | Failed in `@caw/guest` with exit status 2; exact diagnostics listed below. |

Historical esbuild `Could not resolve` diagnostics:

```text
"./lib/client" — packages/guest/src/app.tsx:11:28
"./lib/use-guest" — packages/guest/src/app.tsx:12:33
"../../lib/format" — packages/guest/src/components/transcript/Transcript.tsx:19:26
"../../lib/format" — packages/guest/src/components/shell/HeaderBar.tsx:6:40
"../../lib/format" — packages/guest/src/components/agents/AgentDrawer.tsx:11:48
"../../lib/transcript-poll" — packages/guest/src/components/agents/AgentDrawer.tsx:12:37
"../../lib/theme" — packages/guest/src/components/shell/ThemeToggle.tsx:2:57
"../../lib/format" — packages/guest/src/components/transcript/ToolCard.tsx:4:28
"../../lib/format" — packages/guest/src/components/transcript/Markdown.tsx:6:27
"../../lib/format" — packages/guest/src/components/transcript/math.ts:9:27
"../../lib/format" — packages/guest/src/components/agents/AgentsPanel.tsx:9:57
```

At that commit, `git ls-files packages/guest/src/lib` returned no output. All nine paths below were missing from Git; the first five distinct imported modules in the diagnostics caused the clean-clone build failure:

```text
packages/guest/src/lib/client.ts
packages/guest/src/lib/codec.ts
packages/guest/src/lib/format.ts
packages/guest/src/lib/jsonl.ts
packages/guest/src/lib/link.ts
packages/guest/src/lib/socket.ts
packages/guest/src/lib/theme.ts
packages/guest/src/lib/transcript-poll.ts
packages/guest/src/lib/use-guest.ts
```

Historical clean-clone typecheck diagnostics:

```text
packages/guest typecheck: src/app.tsx(11,29): error TS2307: Cannot find module './lib/client' or its corresponding type declarations.
packages/guest typecheck: src/app.tsx(12,34): error TS2307: Cannot find module './lib/use-guest' or its corresponding type declarations.
packages/guest typecheck: src/app.tsx(65,16): error TS7006: Parameter 'prev' implicitly has an 'any' type.
packages/guest typecheck: src/app.tsx(72,16): error TS7006: Parameter 'prev' implicitly has an 'any' type.
packages/guest typecheck: src/app.tsx(146,31): error TS7006: Parameter 'a' implicitly has an 'any' type.
packages/guest typecheck: src/app.tsx(152,36): error TS7006: Parameter 'a' implicitly has an 'any' type.
packages/guest typecheck: src/app.tsx(180,27): error TS7006: Parameter 'a' implicitly has an 'any' type.
packages/guest typecheck: src/components/agents/AgentDrawer.tsx(10,34): error TS2307: Cannot find module '../../lib/client' or its corresponding type declarations.
packages/guest typecheck: src/components/agents/AgentDrawer.tsx(11,49): error TS2307: Cannot find module '../../lib/format' or its corresponding type declarations.
packages/guest typecheck: src/components/agents/AgentDrawer.tsx(12,38): error TS2307: Cannot find module '../../lib/transcript-poll' or its corresponding type declarations.
packages/guest typecheck: src/components/agents/AgentsPanel.tsx(9,58): error TS2307: Cannot find module '../../lib/format' or its corresponding type declarations.
packages/guest typecheck: src/components/shell/Banners.tsx(2,53): error TS2307: Cannot find module '../../lib/client' or its corresponding type declarations.
packages/guest typecheck: src/components/shell/Composer.tsx(5,51): error TS2307: Cannot find module '../../lib/client' or its corresponding type declarations.
packages/guest typecheck: src/components/shell/HeaderBar.tsx(5,38): error TS2307: Cannot find module '../../lib/client' or its corresponding type declarations.
packages/guest typecheck: src/components/shell/HeaderBar.tsx(6,41): error TS2307: Cannot find module '../../lib/format' or its corresponding type declarations.
packages/guest typecheck: src/components/shell/ThemeToggle.tsx(2,58): error TS2307: Cannot find module '../../lib/theme' or its corresponding type declarations.
packages/guest typecheck: src/components/shell/Toasts.tsx(4,29): error TS2307: Cannot find module '../../lib/client' or its corresponding type declarations.
packages/guest typecheck: src/components/transcript/Markdown.tsx(6,28): error TS2307: Cannot find module '../../lib/format' or its corresponding type declarations.
packages/guest typecheck: src/components/transcript/ToolCard.tsx(4,29): error TS2307: Cannot find module '../../lib/format' or its corresponding type declarations.
packages/guest typecheck: src/components/transcript/Transcript.tsx(18,50): error TS2307: Cannot find module '../../lib/client' or its corresponding type declarations.
packages/guest typecheck: src/components/transcript/Transcript.tsx(19,27): error TS2307: Cannot find module '../../lib/format' or its corresponding type declarations.
packages/guest typecheck: src/components/transcript/math.ts(9,28): error TS2307: Cannot find module '../../lib/format' or its corresponding type declarations.
packages/guest typecheck: Failed
/tmp/caw-round8.AeWKzN/clean/packages/guest:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @caw/guest@0.1.0 typecheck: `tsc -p tsconfig.json --noEmit`
Exit status 2
 ELIFECYCLE  Command failed with exit code 2
```

The ignore-rule fix and all nine source files were committed in `ff3052e` (`Track guest library source files`).

### Fresh clean clone at current commit

`git clone /home/heheboiz/data/coding-agent-web /tmp/caw-final-clean.nKEepx/clean` succeeded (`Cloning into '/tmp/caw-final-clean.nKEepx/clean'...` / `done.`). Clone HEAD was `bb60b43891ff8b70e6b0793f8d9a57f9e421d1a5`, matching source HEAD; it has 262 tracked files and all nine `packages/guest/src/lib/*.ts` paths are tracked.

```text
pnpm install --frozen-lockfile
Scope: all 9 workspace projects
Lockfile is up to date, resolution step is skipped
Packages: +214
Done in 1.2s using pnpm v10.32.1

node scripts/build-guest.mjs
[build-guest] built guest client in 279ms -> packages/guest/dist/
  JS: assets/app.ZUJJ5YZL.js
  CSS: assets/app.JQF725ON.css

pnpm --filter @caw/web build
✓ 45 modules transformed.
dist/index.html                   0.97 kB │ gzip:  0.46 kB
dist/assets/index-Dp6SWPTi.css    7.30 kB │ gzip:  1.98 kB
dist/assets/index-M8I_kLZi.js   240.69 kB │ gzip: 73.34 kB
✓ built in 833ms

pnpm typecheck
Scope: 8 of 9 workspace projects
packages/relay typecheck: Done
packages/collab-protocol typecheck: Done
packages/contracts typecheck: Done
packages/guest typecheck: Done
packages/runtime typecheck: Done
packages/omp-adapter typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done

pnpm --filter @caw/server build
> @caw/server@0.1.0 build /tmp/caw-final-clean.nKEepx/clean/apps/server
> tsc -p tsconfig.json
```

Clean-clone Playwright launcher prerequisite was also checked after web/server builds:

```text
node scripts/e2e-server.mjs
[e2e-server] cannot start: no TypeScript runner found. Run `pnpm install` (root devDependencies include tsx), or set `CAW_E2E_TSX=/path/to/tsx`.
Command exited with code 1
```

`scripts/e2e-server.mjs` checks only `<repoRoot>/node_modules/.bin/tsx` or `CAW_E2E_TSX`; the clean pnpm install links `tsx` at `apps/server/node_modules/.bin/tsx`, not the root. `apps/server` declares `tsx`, and its build passes, but this leaves the workflow's Playwright server command unable to start from a clean checkout. E2E itself was not launched.

**Build/typecheck clean-checkout verdict: PASS. Full CI clean-checkout verdict: FAIL at E2E harness startup** unless its missing root TSX path is fixed. No guest library paths are missing from Git. Historical pre-fix guest build/typecheck failures above are resolved.

## CI workflow and command coverage

`.github/workflows/ci.yml` triggers on pushes to `main`, pull requests, and manual dispatch. It groups runs by ref and cancels an in-progress run in the same group.

The `verify` job runs on `ubuntu-latest`, checks out code, installs pnpm `10.32.1` and Node `20.19` (with pnpm cache), then runs, in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm -r typecheck`
3. `npx vitest run`
4. `node scripts/build-guest.mjs`
5. `pnpm --filter @caw/web build`
6. Inline shell check (`set -eu`) scans `apps/web/dist` and `packages/guest/dist` for `um.can.ac` or `my.omp.sh`; on a match it exits 1 with `A shipped bundle references a third-party or upstream origin.`, otherwise prints `bundles clean`.
7. `pnpm --filter @caw/server build`
8. `npx playwright install --with-deps chromium`
9. `npx playwright test --project=chromium` with `CI: "true"`.
10. On failure, upload `playwright-report/` as `playwright-report` for 7 days.

The separate `compat` job has condition `github.event_name == 'workflow_dispatch' || github.event_name == 'schedule'`: checkout; setup pnpm `10.32.1` and Node `20.19`; frozen install; `node scripts/compat-check.mjs`; install OMP via `curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/install.sh | bash` (warns and exits successfully if unavailable); then `CAW_COMPAT=1 npx vitest run tests/compat`. This opt-in suite launches real agents and was not run. The workflow declares no `schedule` trigger, so this job can currently be reached by manual dispatch only.

Command/script availability checked against root `package.json`, `pnpm-workspace.yaml`, and workspace manifests:

| CI command | Defined/available in repo |
|---|---|
| `pnpm install --frozen-lockfile` | Yes; root declares pnpm `10.32.1`, with workspace and lockfile present. |
| `pnpm -r typecheck` | Yes; all 8 recursive workspace packages expose `typecheck`; root `typecheck` invokes it. |
| `npx vitest run` | Yes; `vitest` is a root dev dependency; root `test` script is `vitest run`. |
| `node scripts/build-guest.mjs` | Yes; script exists; root `guest:build` and `@caw/guest` `build` invoke it. |
| `pnpm --filter @caw/web build` | Yes; `@caw/web` defines `build: vite build`. |
| Inline bundle-origin shell check | Defined inline in the workflow, not a package script. |
| `pnpm --filter @caw/server build` | Yes; `@caw/server` defines `build: tsc -p tsconfig.json`. |
| `npx playwright install --with-deps chromium` | Yes; `@playwright/test` is a root dev dependency. |
| `npx playwright test --project=chromium` | CLI/project config exists (`@playwright/test` is installed; root `test:e2e` names the command), but the clean-install E2E server prerequisite fails: `scripts/e2e-server.mjs` expects a root `.bin/tsx` link which pnpm does not create for the server-scoped `tsx` dependency. Full CI therefore cannot complete E2E from this clean checkout. |
| `node scripts/compat-check.mjs` | Yes; script exists and root `compat` invokes it. |
| `curl ... install.sh` | Defined inline in workflow, not a package script. |
| `CAW_COMPAT=1 npx vitest run tests/compat` | Yes; Vitest is installed and `tests/compat` exists; exact command is not a package script. |

Hosted CI: `gh` is unavailable (`command -v gh` returned no path). The public GitHub Actions API was reachable and reported exactly one run: run `40189420716`, commit `81c430f04ca42199e4908e1fec4d7d67326671e5`, conclusion `failure`. Its `verify` job failed at `Typecheck every package`; test/build/E2E steps were skipped; `compat` job was skipped. This is the initial pre-fix remote commit, not current local commit `bb60b43891ff8b70e6b0793f8d9a57f9e421d1a5`. **[NOT VERIFIED] Hosted CI status for current local HEAD:** current commit was not pushed and has no hosted result. Sources: https://api.github.com/repos/Le-Minh-Nhut/coding-agent-web/actions/runs?per_page=5 and https://api.github.com/repos/Le-Minh-Nhut/coding-agent-web/actions/runs/40189420716/jobs.

Clean-checkout hazard audit after tracking fix: all tracked workflow inputs (workflow, manifests/lockfile, scripts, package source/config, Vitest/Playwright config, and tracked tests) are present in a clean clone. `packages/guest/src/lib/` is tracked; no missing guest library files remain. Build-generated `apps/web/dist` and `packages/guest/dist` exist before the workflow's bundle scan. Five additional test files found in the current worktree are untracked (`tests/adapter/model-catalog.test.ts`, `tests/e2e/screens.spec.ts`, `tests/web/app-drafts.test.tsx`, `tests/web/mobile-reading-ux.test.tsx`, `tests/web/transcript.test.ts`) and are therefore not in a clone of current HEAD unless committed; the local suite below did include the four untracked Vitest files. Playwright E2E was not run. Full hosted CI for current HEAD remains **[NOT VERIFIED]**.

## Full local suite and typecheck

`pnpm test` ran in the current worktree. It included four currently untracked Vitest files; it did not run Playwright E2E.

The initial tracked-file/status snapshot was clean. Before this local suite, the shared checkout had other in-progress worktree edits (`git status --short` reported 28 modified tracked files and 17 untracked paths after the policy-only commit). These results therefore describe the live shared worktree, not just committed HEAD; the clean-clone install/build/typecheck results above describe committed HEAD.

```text
pnpm test

Test Files  42 passed | 2 skipped (44)
     Tests  372 passed | 8 skipped (380)
Start at  01:41:47
Duration  17.16s (transform 1.85s, setup 0ms, collect 6.02s, tests 28.99s, environment 3.59s, prepare 3.31s)
```

No failures. Skips: `tests/compat/omp-lifecycle.test.ts` (2 tests) and `tests/compat/reconciliation.test.ts` (6 tests). Output included Fastify deprecation warning: `[FSTDEP023] FastifyDeprecation: disableRequestLogging option is deprecated. Use the logController option with disableRequestLogging or isLogDisabled override instead. The disableRequestLogging top-level option will be removed in fastify@6.`

Then:

```text
pnpm typecheck
Scope: 8 of 9 workspace projects
packages/relay typecheck: Done
packages/collab-protocol typecheck: Done
packages/contracts typecheck: Done
packages/guest typecheck: Done
packages/runtime typecheck: Done
packages/omp-adapter typecheck: Done
apps/web typecheck: Done
apps/server typecheck: Done
```

Typecheck passed.

## Test inventory

The current worktree contains 51 automated test files (`*.test.*` and `*.spec.*`) under `tests/**`; four Vitest test files listed below are untracked in this worktree, and the E2E screen-inventory spec is also untracked.

| Test file | Behavior pinned |
|---|---|
| `tests/adapter/capabilities.test.ts` | Parses OMP/tmux version strings, handles missing binaries, and caches/refreshes capability probes. |
| `tests/adapter/collab-link.test.ts` | Preserves actual CLI identity evidence and refuses to fabricate or accept malformed link identity. |
| `tests/adapter/collab-registry.test.ts` | Parses collab listings defensively; missing or malformed fields stay unknown, invalid rows drop, and unreadable registry errors remain distinguishable. |
| `tests/adapter/session-catalog.test.ts` | Encodes session directories and parses/discovers native session headers while surfacing unreadable discovery failures. |
| `tests/adapter/session-lease.test.ts` | Computes lease names and distinguishes live, absent, invalid, and unverifiable lease observations. |
| `tests/adapter/tmux-probe.test.ts` | Distinguishes absent tmux sessions from probe failures, permission failures, and failed guarded kills. |
| `tests/adapter/tmux.test.ts` | Exercises isolated tmux session creation/list/capture/termination, identity on restart, and visibility of live unmanaged/renamed sessions. |
| `tests/adapter/model-catalog.test.ts` | Parses and validates provider-qualified model listings, drops malformed/duplicate rows, checks stand-in CLI listing and caching, and returns empty results for unavailable or unsupported sources. |
| `tests/compat/omp-lifecycle.test.ts` | Opt-in real-OMP managed launch, terminal continuity, duplicate-writer refusal, and session journal parsing. |
| `tests/compat/reconciliation.test.ts` | Opt-in real-OMP reconciliation for live/dead/external sessions and writer/registry uncertainty. |
| `tests/e2e/auth.spec.ts` | Browser login failures/success, secure session-cookie attributes, logout, and protected API access. |
| `tests/e2e/browse.spec.ts` | Browser path-browser refusal for outside roots/files and configured-root breadcrumb navigation. |
| `tests/e2e/conversation.spec.ts` | Mobile conversation composer reachability, unavailable/unknown/disconnected states, turn-in-flight rendering, and prompt delivery. |
| `tests/e2e/mobile.spec.ts` | Mobile viewport overflow, touch-target dimensions, keyboard-shrink composer visibility, and code-block scrolling. |
| `tests/e2e/projects.spec.ts` | Project creation, label-only rename, favorite persistence, and metadata deletion without deleting directories. |
| `tests/e2e/reconnect.spec.ts` | Dropped-connection recovery without resubmission, offline-vs-idle display, and failed prompt delivery when host is gone. |
| `tests/e2e/screens.spec.ts` | Captures browser screen inventory and checks layout/scroll/composer behavior across five viewport sizes, including overflow and scroll-position preservation. |
| `tests/guest/build-smoke.test.ts` | Runs the guest build and checks generated HTML, bundle references, manifest, and icon-file existence. |
| `tests/guest/markdown-hardening.test.ts` | Allows safe image/link URLs, rejects unsafe schemes/HTML, and adds safe external-link attributes. |
| `tests/guest/static-assertions.test.ts` | Checks built guest assets for external-origin/secret strings, standalone origin-relative manifest fields, and safe room-link history handling. |
| `tests/protocol/codec.test.ts` | Exercises room-key lengths, AES-GCM encode/decode, authentication failures, tamper detection, and truncated-frame rejection. |
| `tests/protocol/envelope.test.ts` | Packs/unpacks and rewrites wire envelopes and handles undersized frames safely. |
| `tests/protocol/link.test.ts` | Parses/validates supported collaboration-link forms and formats compact/bare links. |
| `tests/protocol/socket.test.ts` | Checks ordered real-WebSocket frame delivery, terminal decryption failure, and reconnect/backoff after disconnect. |
| `tests/relay/package.test.ts` | Pins relay version/cap constants, env validation, and clean start/stop behavior. |
| `tests/relay/relay.test.ts` | Tests relay routing, peer IDs, control frames, admission/limits, origins, counters, and shutdown over WebSockets. |
| `tests/relay/static.test.ts` | Tests static asset/MIME serving, cache handling, traversal/symlink rejection, method restrictions, and health endpoints. |
| `tests/runtime/reconcile-dead-process.test.ts` | Reports a managed process stopped only when its journal survives and lease is free. |
| `tests/runtime/state.test.ts` | Maps observations to honest running/idle/awaiting/stopped/error/unknown states, including ownership and missing evidence. |
| `tests/runtime/supervisor.test.ts` | Tests writer exclusivity, launch reservations/caps, lease and registry guards, timeout recovery, and recording/adoption lifecycle. |
| `tests/server/app.test.ts` | Tests API auth/CSRF/body-size guards, project deletion safety, launch/session behavior, attach identity checks, and honest runtime/error responses. |
| `tests/server/auth.test.ts` | Tests setup-password storage, hashed sessions/expiry/CSRF/revocation, and per-IP/distributed login backoff. |
| `tests/server/config.test.ts` | Tests secure config defaults, file/env merging, invalid settings, public-origin validation, and secret redaction. |
| `tests/server/conversation-link.test.ts` | Tests authenticated link minting, access and generation/identity guards, request shape, and safe deep-link rewriting/errors. |
| `tests/server/events.test.ts` | Tests authenticated event pagination, query validation/limits, ordering, and event-secret redaction. |
| `tests/server/link-rewrite.test.ts` | Tests relay/deep-link rewriting, secret preservation, and rejection of malformed schemes/paths/queries. |
| `tests/server/path-policy.test.ts` | Tests allowed-root containment, symlink/traversal rejection, NFC/NFD lookup, and directory requirements. |
| `tests/server/relay-auth.test.ts` | Tests relay listener isolation from forwarded app-origin/Tailscale access and valid managed-host/guest connection. |
| `tests/server/single-origin.test.ts` | Tests same-origin app/guest/PWA serving, SPA/API fallback, traversal refusal, WebSocket behavior, and generated overlay content. |
| `tests/server/store.test.ts` | Tests idempotent command storage, monotonic event replay, and persistence after store recreation. |
| `tests/web/activity-panel.test.tsx` | Tests activity labels, empty/unknown rendering, newest-first details, and event pagination display. |
| `tests/web/approvals.test.tsx` | Tests approval question rendering, FIFO queueing, exactly-once responses, and settlement/removal behavior. |
| `tests/web/app-drafts.test.tsx` | Preserves separate unsent drafts when switching between conversations and returning. |
| `tests/web/mobile-reading-ux.test.tsx` | Checks detached reader scroll, latest-tail behavior, markdown safety/layout, clipboard success/failure, composer sizing, IME Enter, slash-command handling, and Latest-button visibility. |
| `tests/web/composer.test.tsx` | Tests disabled/in-flight composer behavior, idempotency keys, and emitted prompt frame. |
| `tests/web/folder-browser.test.tsx` | Tests path errors, filtering/disabled outside-root entries, and folder selection behavior. |
| `tests/web/sanitization.test.tsx` | Tests dangerous links, raw HTML, and local-file URLs render inertly. |
| `tests/web/session-badges.test.tsx` | Tests live/unknown/free lease badge display and tracked badge independence. |
| `tests/web/status-banner.test.tsx` | Tests distinct disconnected/unknown states and registry model/restart guidance. |
| `tests/web/touch-targets.test.ts` | Pins CSS minimum touch-target token and selectors. |
| `tests/web/transcript.test.ts` | Exercises snapshot chunk ordering, live-event queuing/deduplication, stable entry reconciliation, reconnect history replacement, streaming status, and transcript-request correlation/cleanup. |

`tests/e2e/fixture.ts` and `tests/e2e/README.md` are support files, not test files.

### Weak or limited tests

- `tests/guest/build-smoke.test.ts` is a shallow build smoke test: it checks generated-file presence/basic HTML and bundle references, not whether the bundled app works in a browser.
- `tests/guest/static-assertions.test.ts` inspects generated asset strings/manifest properties; it is useful as a static policy check but does not execute client behavior.
- `tests/web/touch-targets.test.ts` checks CSS text with regex, not computed dimensions in a browser. `tests/e2e/mobile.spec.ts` separately provides browser-level viewport/touch checks.
- Tests using mocks still assert behavior: `tests/web/app-drafts.test.tsx` verifies draft persistence with mocked child views; `tests/adapter/model-catalog.test.ts` verifies parsed catalog results and caching against a stand-in binary; UI call assertions in `tests/web/activity-panel.test.tsx`, `tests/web/folder-browser.test.tsx`, and `tests/web/mobile-reading-ux.test.tsx` accompany rendered state or emitted-frame assertions. No test was found that only asserts a mock call/echo without asserting observable behavior.

## Resolution

Root cause: `.gitignore`'s bare `lib/` rule hid required guest TypeScript files. Commit `ff3052e` removed that ignore rule and tracked all nine `packages/guest/src/lib/*.ts` files. The initial clean clone failed to bundle/typecheck because those files were unavailable; the fresh clean clone at current HEAD passed install, guest build, web build, and recursive typecheck as recorded above. No missing tracked guest source files remain.
