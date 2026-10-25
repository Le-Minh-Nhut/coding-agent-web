# Round 8: Build, CI, and Test Inventory

## Repository and clean-checkout verification

Commands run from `/home/heheboiz/data/coding-agent-web`:

```text
git ls-files | wc -l
252

git status --porcelain
[no output]
```

The working tree was clean before verification. A local clean clone was made with:

```text
git clone /home/heheboiz/data/coding-agent-web /tmp/caw-round8.AeWKzN/clean
Cloning into '/tmp/caw-round8.AeWKzN/clean'...
done.
```

In that clone, `pnpm install --frozen-lockfile` succeeded. Output summary:

```text
Scope: all 9 workspace projects
Packages: +214
Done in 3.3s using pnpm v10.32.1
```

Clean-checkout commands and results:

| Command | Observed output/result |
|---|---|
| `node scripts/build-guest.mjs` | Failed: `[build-guest] build failed: Error: Build failed with 11 errors:`. Missing-module errors below. |
| `pnpm --filter @caw/web build` | Passed: `✓ 45 modules transformed.`; `dist/index.html 0.97 kB`, CSS `7.30 kB`, JS `240.69 kB`; `✓ built in 755ms`. |
| `pnpm typecheck` | Failed with exit code 2 in `@caw/guest`; package error output below. |

The exact distinct esbuild resolution errors observed:

```text
✘ [ERROR] Could not resolve "./lib/client"
    packages/guest/src/app.tsx:11:28
✘ [ERROR] Could not resolve "./lib/use-guest"
    packages/guest/src/app.tsx:12:33
✘ [ERROR] Could not resolve "../../lib/format"
    packages/guest/src/components/shell/HeaderBar.tsx:6:40
✘ [ERROR] Could not resolve "../../lib/format"
    packages/guest/src/components/agents/AgentsPanel.tsx:9:57
✘ [ERROR] Could not resolve "../../lib/format"
    packages/guest/src/components/agents/AgentDrawer.tsx:11:48
✘ [ERROR] Could not resolve "../../lib/transcript-poll"
    packages/guest/src/components/agents/AgentDrawer.tsx:12:37
✘ [ERROR] Could not resolve "../../lib/theme"
    packages/guest/src/components/shell/ThemeToggle.tsx:2:57
✘ [ERROR] Could not resolve "../../lib/format"
    packages/guest/src/components/transcript/Transcript.tsx:19:26
✘ [ERROR] Could not resolve "../../lib/format"
    packages/guest/src/components/transcript/ToolCard.tsx:4:28
✘ [ERROR] Could not resolve "../../lib/format"
    packages/guest/src/components/transcript/Markdown.tsx:6:27
✘ [ERROR] Could not resolve "../../lib/format"
    packages/guest/src/components/transcript/math.ts:9:27
```

Tracked-file check: `git ls-files packages/guest/src/lib` returned no output. The following existing checkout files are ignored/untracked, so absent from the clean clone:

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

`git check-ignore -v` identified `.gitignore:17:lib/` as the rule ignoring them. The directly observed build errors reference `client.ts`, `use-guest.ts`, `format.ts`, `transcript-poll.ts`, and `theme.ts` (several imports repeat). The remaining four files are also untracked, but no direct unresolved import for them appeared in the build output.

Clean-clone `pnpm typecheck` emitted these errors:

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

**Clean-checkout verdict: FAIL.** Frozen install and web build pass, but guest build and recursive typecheck fail because required guest source files are not tracked. Current-checkout results differ because those ignored files exist locally.

## CI workflow and command coverage

`.github/workflows/ci.yml` triggers on pushes to `main`, pull requests, and manual dispatch. It groups runs by ref and cancels an in-progress run in the same group.

The `verify` job runs on `ubuntu-latest`, checks out code, installs pnpm `10.32.1` and Node `20.19` (with pnpm cache), then runs, in order:

1. `pnpm install --frozen-lockfile`
2. `pnpm -r typecheck`
3. `npx vitest run`
4. `node scripts/build-guest.mjs`
5. `pnpm --filter @caw/web build`
6. A shell check (`set -eu`) that searches `apps/web/dist` and `packages/guest/dist` for `um.can.ac` or `my.omp.sh`; on a match it exits 1 with `A shipped bundle references a third-party or upstream origin.`, otherwise prints `bundles clean`.
7. `pnpm --filter @caw/server build`
8. `npx playwright install --with-deps chromium`
9. `CI: "true" npx playwright test --project=chromium`
10. On failure, uploads `playwright-report/` as `playwright-report` for 7 days.

The separate `compat` job runs only for `workflow_dispatch` or `schedule`: checkout; setup pnpm `10.32.1` and Node `20.19`; frozen install; `node scripts/compat-check.mjs`; install OMP via `curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/install.sh | bash` (warns and exits successfully if unavailable); then `CAW_COMPAT=1 npx vitest run tests/compat`. This real-OMP suite launches agents and was not run for this audit.

Command/script availability checked against root `package.json`, `pnpm-workspace.yaml`, and workspace manifests:

| CI command | Defined/available in repo |
|---|---|
| `pnpm install --frozen-lockfile` | Yes; pnpm `10.32.1` is declared in root `package.json`, workspace and lockfile exist. |
| `pnpm -r typecheck` | Yes; all 8 recursive workspace packages expose `typecheck`; root `typecheck` invokes this command too. |
| `npx vitest run` | Yes; `vitest` is a root dev dependency; root `test` script is `vitest run`. |
| `node scripts/build-guest.mjs` | Yes; script exists, root `guest:build` and `@caw/guest` `build` scripts invoke it. |
| `pnpm --filter @caw/web build` | Yes; `@caw/web` defines `build: vite build`. |
| Inline bundle-origin shell check | Not a package script; command is defined inline in workflow. |
| `pnpm --filter @caw/server build` | Yes; `@caw/server` defines `build: tsc -p tsconfig.json`. |
| `npx playwright install --with-deps chromium` | Yes; `@playwright/test` is a root dev dependency. |
| `npx playwright test --project=chromium` | Yes; `@playwright/test` is installed; root `test:e2e` is `playwright test --project=chromium`. |
| `node scripts/compat-check.mjs` | Yes; script exists and root `compat` invokes it. |
| `curl ... install.sh` | Inline workflow command; not a package script. |
| `CAW_COMPAT=1 npx vitest run tests/compat` | Yes; Vitest is installed and `tests/compat` exists; this exact command is not a package script. |

CI status: **NOT VERIFIED**. `command -v gh` printed `gh not installed`; the attempted `gh auth status && gh run list --limit 5` therefore did not run. No provider/compat tests or real agent launches were run.

## Full local suite and typecheck

Commands run from the original checkout:

```text
pnpm test
```

Observed Vitest summary:

```text
Test Files  38 passed | 2 skipped (40)
     Tests  334 passed | 8 skipped (342)
Start at 18:50:59
Duration 17.15s (transform 2.71s, setup 0ms, collect 9.87s, tests 32.37s, environment 4.12s, prepare 5.25s)
```

No failures. Both skipped files are `tests/compat/omp-lifecycle.test.ts` (2 tests) and `tests/compat/reconciliation.test.ts` (6 tests). Output included repeated Fastify deprecation warning: `[FSTDEP023] FastifyDeprecation: disableRequestLogging option is deprecated. Use the logController option with disableRequestLogging or isLogDisabled override instead. The disableRequestLogging top-level option will be removed in fastify@6.`

Then:

```text
pnpm typecheck
```

Passed. Final package output was `packages/runtime typecheck: Done`, `packages/omp-adapter typecheck: Done`, `apps/web typecheck: Done`, and `apps/server typecheck: Done`; earlier recursive package typechecks also reported `Done`.

## Test inventory

The 46 automated test files (`*.test.*` and `*.spec.*`) under `tests/**`:

| Test file | Behavior pinned |
|---|---|
| `tests/adapter/capabilities.test.ts` | Parses OMP/tmux version strings, handles missing binaries, and caches/refreshes capability probes. |
| `tests/adapter/collab-link.test.ts` | Preserves actual CLI identity evidence and refuses to fabricate or accept malformed link identity. |
| `tests/adapter/collab-registry.test.ts` | Parses collab listings defensively; missing or malformed fields stay unknown, invalid rows drop, and unreadable registry errors remain distinguishable. |
| `tests/adapter/session-catalog.test.ts` | Encodes session directories and parses/discovers native session headers while surfacing unreadable discovery failures. |
| `tests/adapter/session-lease.test.ts` | Computes lease names and distinguishes live, absent, invalid, and unverifiable lease observations. |
| `tests/adapter/tmux-probe.test.ts` | Distinguishes absent tmux sessions from probe failures, permission failures, and failed guarded kills. |
| `tests/adapter/tmux.test.ts` | Exercises isolated tmux session creation/list/capture/termination, identity on restart, and visibility of live unmanaged/renamed sessions. |
| `tests/compat/omp-lifecycle.test.ts` | Opt-in real-OMP managed launch, terminal continuity, duplicate-writer refusal, and session journal parsing. |
| `tests/compat/reconciliation.test.ts` | Opt-in real-OMP reconciliation for live/dead/external sessions and writer/registry uncertainty. |
| `tests/e2e/auth.spec.ts` | Browser login failures/success, secure session-cookie attributes, logout, and protected API access. |
| `tests/e2e/browse.spec.ts` | Browser path-browser refusal for outside roots/files and configured-root breadcrumb navigation. |
| `tests/e2e/conversation.spec.ts` | Mobile conversation composer reachability, unavailable/unknown/disconnected states, turn-in-flight rendering, and prompt delivery. |
| `tests/e2e/mobile.spec.ts` | Mobile viewport overflow, touch-target dimensions, keyboard-shrink composer visibility, and code-block scrolling. |
| `tests/e2e/projects.spec.ts` | Project creation, label-only rename, favorite persistence, and metadata deletion without deleting directories. |
| `tests/e2e/reconnect.spec.ts` | Dropped-connection recovery without resubmission, offline-vs-idle display, and failed prompt delivery when host is gone. |
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
| `tests/web/composer.test.tsx` | Tests disabled/in-flight composer behavior, idempotency keys, and emitted prompt frame. |
| `tests/web/folder-browser.test.tsx` | Tests path errors, filtering/disabled outside-root entries, and folder selection behavior. |
| `tests/web/sanitization.test.tsx` | Tests dangerous links, raw HTML, and local-file URLs render inertly. |
| `tests/web/session-badges.test.tsx` | Tests live/unknown/free lease badge display and tracked badge independence. |
| `tests/web/status-banner.test.tsx` | Tests distinct disconnected/unknown states and registry model/restart guidance. |
| `tests/web/touch-targets.test.ts` | Pins CSS minimum touch-target token and selectors. |

`tests/e2e/fixture.ts` and `tests/e2e/README.md` are support files, not test files.

### Weak or limited tests

- `tests/guest/build-smoke.test.ts` is a shallow build smoke test: it checks generated-file presence/basic HTML and bundle references, not whether the bundled app works in a browser.
- `tests/guest/static-assertions.test.ts` inspects generated asset strings/manifest properties; it is useful as a static policy check but does not execute client behavior.
- `tests/web/touch-targets.test.ts` checks CSS text with regex, not computed dimensions in a browser. `tests/e2e/mobile.spec.ts` separately provides browser-level viewport/touch checks.
- The explicit call assertions found in `tests/web/activity-panel.test.tsx` and `tests/web/folder-browser.test.tsx` are accompanied by rendered-item/selection assertions; neither is only a function-called or mock-echo test. No standalone call-only test was identified.

## Resolution

Root cause: the Python template's bare `lib/` ignore rule also matched `packages/guest/src/lib/`, hiding required TypeScript source from Git. Before the fix, `git ls-files | grep -c '^.*/lib/'` printed `0` (no tracked lib paths); `find . -type d -name lib -not -path './.git/*' -not -path '*/node_modules/*'` found only `./packages/guest/src/lib`. No other `lib/` build-output directory or legitimate ignored `lib/` directory exists in this checkout. Removed only the `lib/` line; kept `lib64/`.

Committed fix and audit report in `ff3052e9e1d9d1ed4619a5df987d6e9c5fb771f2` (`Track guest library source files`). Exact change: delete `.gitignore` line `lib/`; add these 9 previously ignored source files; add this audit report:

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

Before commit, `git status --short` showed `.gitignore` modified, the report added, and all 9 source paths added; `git ls-files packages/guest/src/lib | wc -l` printed `9`. The ignore fix requires no negation rule.

Fresh post-commit clone: `git clone /home/heheboiz/data/coding-agent-web /tmp/caw-round8-fixed-ff3052e` succeeded (`Cloning into '/tmp/caw-round8-fixed-ff3052e'...` / `done.`). In that clone, commands and observed outcomes:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed: `Scope: all 9 workspace projects`, `Packages: +214`, `Done in 923ms using pnpm v10.32.1`. |
| `node scripts/build-guest.mjs` | Passed: `[build-guest] built guest client in 244ms -> packages/guest/dist/`; JS `assets/app.ZUJJ5YZL.js`, CSS `assets/app.JQF725ON.css`. |
| `pnpm -r typecheck` | Passed: 8 of 9 workspace projects; all package `typecheck: Done`, including `packages/guest`, `apps/web`, and `apps/server`. |
| `npx vitest run` | Passed: `Test Files  38 passed | 2 skipped (40)`; `Tests  334 passed | 8 skipped (342)`; zero failures. Skipped only `tests/compat/omp-lifecycle.test.ts` (2) and `tests/compat/reconciliation.test.ts` (6). No real-OMP suite was run. |

Post-fix clean-clone verdict: PASS for install, guest build, recursive typecheck, and non-compat Vitest suite. No push performed.
