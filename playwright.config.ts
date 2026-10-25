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
 * The test process and the launcher must agree on this path, so it is pinned here
 * and handed to both; specs skip with a clear reason when it is missing.
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
    // Chrome is present at /usr/bin/google-chrome on the target machine; the
    // `chrome` channel uses it instead of downloading Playwright's own Chromium.
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...MOBILE_CONTEXT, channel: "chrome" } },
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
    },
  },
});
