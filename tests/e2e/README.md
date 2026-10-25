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
- `CAW_ALLOWED_ROOTS` — the existing `roots` directory and a sibling `roots-secondary` directory inside the same temporary tree. The existing first root keeps its `readme.txt`, `p-alpha`, `p-beta`, `p-gamma`, `p-delta`, `m-touch`, and `seeded` contents unchanged; the secondary root exists only to exercise root switching. Both are removed with the fixture; the owner's directories are never touched.
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
