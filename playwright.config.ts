import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E harness for Coding Agent Web.
 *
 * Everything here is deliberately test-only: the specs drive the real server
 * (`scripts/e2e-server.mjs`) and the real web bundle, but never an LLM-backed
 * agent. See `tests/e2e/README.md` for how to run it and what still requires a
 * physical iPhone.
 */

/** The one place the mobile geometry is defined; every project shares it. */
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MOBILE_CONTEXT = {
  viewport: MOBILE_VIEWPORT,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  screen: MOBILE_VIEWPORT,
} as const;

/** Set CAW_E2E_PORT to reuse an already-running server instead of launching one. */
const REUSE_PORT = process.env.CAW_E2E_PORT;
const BASE_URL = process.env.CAW_E2E_BASE_URL ?? (REUSE_PORT ? `http://127.0.0.1:${REUSE_PORT}` : "http://127.0.0.1:4399");

/**
 * Where the launcher publishes the fixture paths (temp roots tree, seeded ids).
 * The launcher owns the file and removes it on shutdown; the default below is
 * only this config's fallback (a `--list` run, or a developer-started server),
 * and the launcher's own default is the same path — the two must match so a
 * direct `node scripts/e2e-server.mjs` and a Playwright run agree. Specs skip
 * with a clear reason when it is missing.
 */
const FIXTURE_FILE = process.env.CAW_E2E_FIXTURE ?? join(tmpdir(), "caw-e2e-fixture.json");
process.env.CAW_E2E_FIXTURE = FIXTURE_FILE;

/**
 * WebKit is skipped when this machine has no WebKit build. Playwright's browser
 * bundles live in PLAYWRIGHT_BROWSERS_PATH or the platform cache directory
 * (Ubuntu/macOS: ~/.cache/ms-playwright); reading that directory is cheap and
 * avoids launching a browser just to discover it is missing.
 *
 * CAW_E2E_SKIP_WEBKIT=1 excludes WebKit explicitly.
 * CAW_E2E_FORCE_WEBKIT=1 includes it even when the bundle is not detected, so a
 * non-standard install location or a wrong guess fails loudly instead of quietly
 * losing the project.
 */
const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache", "ms-playwright");
let webkitBundleInstalled = false;
try {
  webkitBundleInstalled = readdirSync(browsersDir).some((entry) => entry.startsWith("webkit-"));
} catch {
  webkitBundleInstalled = false;
}
const includeWebkit = process.env.CAW_E2E_SKIP_WEBKIT !== "1" && (webkitBundleInstalled || process.env.CAW_E2E_FORCE_WEBKIT === "1");

/**
 * The session-cookie mode this run uses, resolved ONCE and published to both sides.
 *
 * WebKit will not store `__Host-caw_session` over plain HTTP — the prefix REQUIRES
 * `Secure`, and unlike Chrome it does not exempt loopback — so a WebKit run needs the
 * app's loopback-only dev mode (`CAW_INSECURE_COOKIES=1`), which names the cookie
 * `caw_session` without `Secure`. The server already refuses that flag unless the bind
 * host is localhost (`apps/server/src/config.ts:151`) and `scripts/e2e-server.mjs` binds
 * 127.0.0.1, so it cannot reach a deployment.
 *
 * This used to be set ONLY inside `webServer.env`. The server therefore ran in dev-cookie
 * mode while the spec process saw `undefined` and asserted the production `__Host-`
 * cookie against a server that was never going to issue it — measured as `Expected
 * "__Host-caw_session" / Received "caw_session"` in `auth.spec.ts`. One value, assigned
 * to `process.env` and passed through to the server, is what keeps the assertion honest:
 * a spec can now tell which mode the run is in without inferring it from the cookie it is
 * testing.
 */
const insecureCookies = includeWebkit;
if (insecureCookies) process.env.CAW_INSECURE_COOKIES = "1";
else delete process.env.CAW_INSECURE_COOKIES;

/**
 * This machine drives the real installed Chrome (present at /usr/bin/google-chrome);
 * CI installs Playwright's own chromium bundle and has no system Chrome, so naming
 * the channel there fails with "executable doesn't exist". `CAW_E2E_CHANNEL` forces
 * either lane when diagnosing.
 */
const forcedChannel = process.env.CAW_E2E_CHANNEL;
const chromiumChannel =
  forcedChannel === "bundled" ? undefined
  : forcedChannel === "chrome" ? ("chrome" as const)
  : process.env.CI ? undefined
  : ("chrome" as const);

export default defineConfig({
  testDir: "./tests/e2e",
  // Ceiling: one server, state dir, fixture manifest, and folder tree, so specs stay serial. Upgrade path: per-shard server with its own port, state dir, fixture manifest, and roots before enabling `--shard` + N workers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
  },

  projects: [
    // Chrome is present at /usr/bin/google-chrome on the target machine; CI installs
    // Playwright's own chromium bundle. The channel is resolved above from the
    // environment (see CAW_E2E_CHANNEL) so both lanes name one real browser.
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...MOBILE_CONTEXT,
        ...(chromiumChannel === undefined ? {} : { channel: chromiumChannel }),
      },
    },
    ...(includeWebkit ? [{ name: "webkit", use: { ...devices["Desktop Safari"], ...MOBILE_CONTEXT } }] : []),
  ],

  webServer: {
    command: "node scripts/e2e-server.mjs",
    // `url` (not `port`) because readiness must mean "the API answers", which is
    // also what makes reuse of a running instance work: Playwright probes this
    // URL first and only spawns the command when nothing answers.
    url: `${BASE_URL}/api/capabilities`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // The launcher survives SIGTERM so Playwright escalates to SIGKILL at the
    // end of the run; see scripts/e2e-server.mjs for why (process-group signal
    // lifetime, not signal coverage).
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    env: {
      CAW_E2E_FIXTURE: FIXTURE_FILE,
      ...(REUSE_PORT ? { CAW_E2E_PORT: REUSE_PORT } : {}),
      /**
       * WebKit will not store `__Host-caw_session` over plain HTTP: the prefix
       * REQUIRES `Secure`, and unlike Chrome, WebKit does not exempt loopback from
       * that rule. The browser accepts the login response, discards the cookie, and
       * every later request is 401 — measured, with the harness logging in through
       * the screen and then reading an empty cookie jar.
       *
       * The server already has the flag for exactly this situation: it is the app's
       * documented loopback-only dev mode, refused unless the bind host is localhost
       * (`apps/server/src/config.ts:151`), and it switches to `caw_session` without
       * `Secure` (`auth.ts:50`). The harness server is always bound to 127.0.0.1, so
       * this cannot leak into a deployment.
       *
       * Set only when the WebKit project is in the run, so a Chromium-only run still
       * exercises the production cookie — and `auth.spec.ts` asserts the right cookie
       * for whichever mode the run is in rather than being weakened. The same resolved
       * value is published to `process.env` above, so the spec and the server cannot
       * disagree about which mode is under test.
       */
      ...(insecureCookies ? { CAW_INSECURE_COOKIES: "1" } : {}),
    },
  },
});
