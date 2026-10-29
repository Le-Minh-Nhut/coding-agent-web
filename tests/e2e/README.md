# Browser E2E harness

Playwright, Chromium at an iPhone-sized viewport (390x844, DPR 2, touch), driving
the real server and the real web bundle. Nothing here launches an LLM-backed
agent, so a full run is free.

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
- **No agent can be launched.** The state dir is pre-seeded with one project and
  one `stopped` conversation, so specs *open* a conversation instead of creating
  one through the supervisor. That matters: the tmux service resolves `omp` from
  `PATH`, so any launch would start the owner's real agent and spend credits.
- The server is started as `tsx apps/server/src/server.ts` (via the workspace's
  own `node_modules/.bin/tsx`, overridable with `CAW_E2E_TSX`) rather than a
  TypeScript build, so the suite exercises current source.
- The resolved URL and fixture paths are written to the manifest file the test
  process reads, and printed on stdout.

## Unexpected browser errors

`fixture.ts` attaches `pageerror`, `console` (`error` only) and `requestfailed`
collectors the first time a spec navigates (`gotoApp`/`login`), and exposes
`unexpectedAppErrors(page)` / `assertNoUnexpectedAppErrors(page)`. The specs that
inject faults or carry the most state (all of `round13.spec.ts` and
`regression.spec.ts`) assert the list is empty before they end. The filter is by
rule, never by weakening the assertion: a *response with an error status*
("Failed to load resource: the server responded with a status of 5xx/4xx") is the
injected case, as are `net::ERR_ABORTED` (navigation and un-routed mocks) and
favicon/icon requests. An uncaught exception or a `console.error` from the app is
always reported, and `tests/e2e/error-capture.spec.ts` proves both directions.

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
