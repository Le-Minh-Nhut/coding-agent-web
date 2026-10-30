# Browser E2E harness

Playwright, Chromium at an iPhone-sized viewport (390x844, DPR 2, touch), driving
the real server and the real web bundle. The `omp` binary is pinned to a recorder
stub, so nothing here launches an LLM-backed agent and a full run is free — see
`## The launcher` for the two layers that guarantee it.

## Running

```bash
pnpm install                          # adds @playwright/test (pinned 1.64.1)
node scripts/build-guest.mjs          # if not already built
pnpm --filter @caw/web build          # the specs drive apps/web/dist

pnpm test:e2e            # Chromium only
pnpm test:e2e:all        # Chromium + WebKit (when this machine has WebKit)
npx playwright test --list
npx playwright test tests/e2e/auth.spec.ts
```

Chromium uses the system Chrome (`channel: "chrome"`, `/usr/bin/google-chrome`),
so no browser download is required. WebKit needs
`npx playwright install webkit`; the project is **omitted automatically** when
`~/.cache/ms-playwright/webkit-*` is absent, and can be forced with
`CAW_E2E_SKIP_WEBKIT=1` / `CAW_E2E_FORCE_WEBKIT=1`.

| Variable | Effect |
| --- | --- |
| `CAW_E2E_PORT` | Reuse a server already listening on this port |
| `CAW_E2E_BASE_URL` | Point the specs at another origin (e.g. a proxy fronting the SPA) |
| `CAW_E2E_FIXTURE` | Fixture manifest path; defaults to `<tmp>/caw-e2e-fixture.json` |
| `CAW_E2E_SKIP_WEBKIT` / `CAW_E2E_FORCE_WEBKIT` | Exclude / force the WebKit project |

Playwright reuses an already-listening server outside CI, so a developer instance
is never fought over. In CI (`CI=1`) reuse is off and the launcher is started
fresh.

## The launcher (`scripts/e2e-server.mjs`)

Boots the server with **hermetic** state inside a temp dir that is removed
afterwards:

- `CAW_STATE_DIR` — temp; the owner's real state dir is never touched (asserted).
- The roots fixture also contains `paged/` with 205 child directories to exercise the paginated browser; it is created inside the harness temp tree and removed with the fixture.
- Password — a fixed test value, seeded by writing `auth-password.json`
  (hex salt + 64-byte `scrypt(password, salt)`) before the server starts, so
  nothing has to scrape the first-run setup-token message. The file format is the
  one `apps/server/src/auth.ts` validates.
- **No real agent can start. Two independent layers guarantee it.**
  1. *Product-level pin.* `CAW_OMP_BINARY_PATH` sets `config.ompBinaryPath`, and
     that one value is the binary **every** `omp` invocation the server makes
     resolves to: the Collab registry read, the model catalog, the capability
     probe, **and the command tmux is asked to launch**. The launcher points it at
     its own stub, so a create-chat spawns the stub — never the owner's OMP.
     Leaving the variable unset keeps the real-workload default (`omp` from PATH),
     unchanged for deployments.
  2. *Recorder + PATH canary.* The stub appends `{exe, argv}` to a log for every
     invocation that is not the registry read, so a spec asserts *which* binary was
     executed. A canary directory holding another executable named `omp` is
     prepended to `PATH`; any code path that regressed to bare-name resolution would
     land there and write to the canary log instead of starting an agent.
     `tests/e2e/no-launch-guard.spec.ts` asserts every recorded invocation was the
     stub and that the canary log is empty.

  The stub never runs a model: it answers `collab list` with an empty host list,
  records anything else, and exits 1. A launched "agent" therefore dies within
  milliseconds, and a created conversation settles as a failure (never `running`).
  `tests/server/round19-harness-record-auditor.test.ts` covers the same wiring
  without a tmux server at all.
- **Specs still prefer *opening* a conversation.** The state dir is pre-seeded with
  one project and one `stopped` conversation, so most specs open a conversation
  instead of creating one. That keeps runs fast and independent of tmux; it is no
  longer what keeps an agent from starting — the pin above does that.
- **The Collab registry needs no OMP, in two layers.** The server reads it by
  running `omp collab list --json`, which is ENOENT on a runner with no OMP.
  Layer 1 is the product: when the registry *directory* is itself absent,
  `DefaultCollabRegistryService.list()` answers `[]` without spawning anything —
  no directory means no host has ever published, so the empty list is a
  confirmed fact (proved by `tests/adapter/collab-registry.test.ts`). Layer 2 is
  the pinned stub, which answers that call with an empty host list. The launcher
  also sets `XDG_STATE_HOME` to the harness temp dir, so the registry directory
  *exists* under the harness (the "populated directory" branch is what gets
  exercised) and the owner's real `~/.omp/run/collab-hosts` is never read.
- The server is started as `tsx apps/server/src/server.ts` (via the workspace's
  own `node_modules/.bin/tsx`, overridable with `CAW_E2E_TSX`) rather than a
  TypeScript build, so the suite exercises current source.
- The resolved URL and fixture paths are written to the manifest file the test
  process reads, and printed on stdout.

## Unexpected browser errors

`fixture.ts` attaches `pageerror`, `console` (`error` only) and `requestfailed`
collectors the first time a spec navigates (`gotoApp`/`login`), and exposes
`unexpectedAppErrors(page)` / `assertNoUnexpectedAppErrors(page)`. The specs that
inject faults or carry the most state (all of `round13.spec.ts`,
`round17-flows.spec.ts` and `regression.spec.ts`) assert the list is empty before
they end. The filter is an
**allowlist, never a blanket rule**: a console error reporting a response status
is forgiven only when the spec *declares* that exact URL+status with
`declareInjectedFault(page, { urlPattern, status })`, registered where the fault
is installed (`page.route(...).fulfill(...)`). An *undeclared* 5xx/4xx is reported
— that is the defect the collector exists to catch. `net::ERR_ABORTED`
(navigation and un-routed mocks; the app has no `AbortController`) and
favicon/icon requests stay filtered by URL rule. An uncaught exception or a
`console.error` from the app is always reported, and
`tests/e2e/error-capture.spec.ts` proves all four directions: a declared fault is
forgiven, an undeclared error status is not, and pageerror/console.error surface.

## What still requires a physical iPhone

Playwright emulation is not iOS Safari. These are unverified by this suite and
must be checked by hand — they are listed in `docs/operations/iphone-setup.md`:

- the software keyboard: real focus/blur timing, `visualViewport` animation, and
  whether the composer ends up above the keyboard;
- safe-area insets on a notched device, and Home Screen standalone layout;
- reconnecting after iOS suspends the tab for minutes, and socket behaviour
  across a lock/unlock;
- ITP cookie/storage eviction and the installed-app cookie jar;
- edge-swipe navigation inside the installed app.

## Verifying the harness without a live relay

`GET /api/conversations/:id/link` is not implemented yet, and a real link needs a
live `omp` session, so the conversation specs answer that endpoint from the
harness and stand in for the relay with `page.routeWebSocket`. The mock host
seals real frames (4-byte big-endian peer prefix + AES-256-GCM `[12B IV][tag]`)
with a room key the harness minted, so it exercises the same decoding path the
product uses. `tests/e2e/fixture.ts` holds it; the specs drive it to reach each
connection state on demand.

When the server serves the built client itself, the proxy trick below is
unnecessary: point `CAW_E2E_BASE_URL` at the server and delete this note.
