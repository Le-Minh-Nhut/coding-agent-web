#!/usr/bin/env node
/**
 * Test-only launcher for the Coding Agent Web server (Playwright `webServer`).
 *
 * The full rationale — hermetic state, the password handoff, why this starts
 * `tsx` directly, and the process-group shutdown contract Playwright depends on
 * — is documented at the top of `tests/e2e/README.md`. Read that before
 * changing anything here.
 */
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Fixed, non-secret password: the specs must be able to type it deterministically. */
const E2E_PASSWORD = "e2e-password-do-not-use-anywhere-else";
/** 16-byte salt / 64-byte key, matching the formats apps/server/src/auth.ts validates. */
const SALT_BYTES = 16;
const HASH_BYTES = 64;

const SERVER_ENTRY = join(repoRoot, "apps", "server", "src", "server.ts");
const WEB_DIST = join(repoRoot, "apps", "web", "dist");
const WEB_INDEX = join(WEB_DIST, "index.html");

function refuse(message) {
  process.stderr.write(`\n[e2e-server] cannot start: ${message}\n\n`);
  process.exit(1);
}

// ── 1. Preconditions ────────────────────────────────────────────────────────
// The launcher starts the source entry point, so it needs the workspace's own
// dev tooling. It never falls back to `pnpm start` (a TypeScript build) because
// the point of running E2E now is to see the current source.
if (!existsSync(SERVER_ENTRY)) refuse(`apps/server/src/server.ts not found at ${SERVER_ENTRY}`);
if (!existsSync(WEB_INDEX)) {
  refuse(
    `no web build at ${WEB_INDEX} — run \`pnpm --filter @caw/web build\` first.\n` +
      `The specs drive the built SPA; there is nothing to test without it.`,
  );
}

// tsx is a devDependency that a plain `node` run cannot resolve; a global install
// is the only acceptable fallback, and only for interactive use.
const tsxGlobal = process.env.CAW_E2E_TSX ?? "";
const localTsx = join(repoRoot, "node_modules", ".bin", "tsx");
const tsxBin = existsSync(localTsx) ? localTsx : tsxGlobal;
if (!tsxBin) {
  refuse(
    "no TypeScript runner found. Run `pnpm install` (root devDependencies include tsx), " +
      "or set CAW_E2E_TSX=/path/to/tsx.",
  );
}

// ── 2. Hermetic state ──────────────────────────────────────────────────────
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "caw-e2e-")));
const stateDir = join(tempRoot, "state");
const rootsDir = join(tempRoot, "roots");
const secondaryRootsDir = join(tempRoot, "roots-secondary");

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(rootsDir, { recursive: true });
mkdirSync(secondaryRootsDir, { recursive: true });
// A deterministic tree the specs assert on. One directory per spec, so no spec
// depends on another having run, plus a file to prove non-directories are refused.
writeFileSync(join(rootsDir, "readme.txt"), "Deterministic E2E fixture file. Not a directory.\n");
for (const name of ["p-alpha", "p-beta", "p-gamma", "p-delta", "m-touch", "seeded"]) {
  mkdirSync(join(rootsDir, name), { recursive: true });
}
const pagedFixtureDir = join(rootsDir, "paged");
mkdirSync(pagedFixtureDir, { recursive: true });
for (let index = 1; index <= 205; index++) {
  mkdirSync(join(pagedFixtureDir, `entry-${String(index).padStart(3, "0")}`));
}

/**
 * Seed one project and one conversation so the specs can *open* a conversation
 * without creating one.
 *
 * Creating a conversation goes through the real supervisor and would launch an
 * `omp` process in tmux — and `omp` is resolved as a bare command name, so a
 * running tmux server would find the owner's real binary and spend credits. The
 * harness must never do that (see tests/e2e/README.md), which is why the state
 * the browser needs is written here instead of produced through the UI.
 */
const seededProject = {
  id: "e2e00000-0000-4000-8000-000000000001",
  path: join(rootsDir, "seeded"),
  label: "Seeded Fixture",
  favorite: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const seededConversation = {
  id: "e2e00000-0000-4000-8000-000000000002",
  projectId: seededProject.id,
  nativeSessionId: null,
  nativeSessionPath: null,
  title: "Seeded conversation",
  model: "effective/model",
  modelPreference: "preferred/model",
  ownership: "managed",
  state: "stopped",
  tmuxSessionId: null,
  tmuxSessionName: null,
  hostInstanceId: null,
  hostGeneration: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: null,
  statusDetail: null,
};
writeFileSync(
  join(stateDir, "metadata.jsonl"),
  `${JSON.stringify({ op: "project", value: seededProject })}\n${JSON.stringify({ op: "conversation", value: seededConversation })}\n`,
  { mode: 0o600 },
);

// The owner's real state dir must never be touched; assert rather than assume.
if (!tempRoot.startsWith(realpathSync(tmpdir()))) {
  refuse(`temporary state escaped the OS temp dir: ${tempRoot}`);
}

// ── 3. Credential seeding ──────────────────────────────────────────────────
// apps/server's first-run flow writes a one-time setup token as the password and
// prints it to stdout. E2E must not depend on scraping that (or on a provisional
// stdout format), so we write the credential file the server reads at startup:
// `auth-password.json` holding hex salt + scrypt(password, salt, 64).
const salt = randomBytes(SALT_BYTES);
const hash = scryptSync(E2E_PASSWORD, salt, HASH_BYTES);
const passwordFile = join(stateDir, "auth-password.json");
writeFileSync(passwordFile, JSON.stringify({ salt: salt.toString("hex"), hash: hash.toString("hex") }), "utf8");
chmodSync(passwordFile, 0o600);

// ── 4. Runtime configuration ───────────────────────────────────────────────
const env = {
  ...process.env,
  CAW_HOST: "127.0.0.1",
  CAW_PORT: process.env.CAW_E2E_PORT ?? "4399",
  CAW_STATE_DIR: stateDir,
  CAW_ALLOWED_ROOTS: `${rootsDir},${secondaryRootsDir}`,
  // `maxActiveAgents` refuses to go below 1, so the free-load guarantee comes
  // from CAW_OMP_PATH: the adapter probes this path, sees no binary, reports the
  // capability missing, and every launch is refused before any agent exists.
  // The owner's credits are never at risk from this harness.
  CAW_OMP_PATH: join(tempRoot, "no-agent-binary"),
  CAW_MAX_ACTIVE_AGENTS: "1",
  CAW_LOG_LEVEL: process.env.CAW_LOG_LEVEL ?? "warn",
};

const child = spawn(tsxBin, [SERVER_ENTRY], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
  shell: false, // array argv only; see AGENTS.md hard rule 1.
});

/**
 * Playwright's webServer teardown contract: on SIGTERM it waits up to
 * `gracefulShutdown.timeout`, then SIGKILLs. `gracefulShutdown` kills the whole
 * process group (`-pid`), but the group dies the moment this parent dies, so a
 * signal handler that exits immediately cannot be relied on to clean up.
 * Instead we ignore SIGTERM: the timeout expires, Playwright SIGKILLs the group
 * (taking the `tsx` child with it, since stdio is inherited and it does not
 * daemonize), and this handler removes the temp tree afterwards. The tree is
 * inside the OS temp dir either way, so a SIGKILL cannot leak anything precious.
 */
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {
  rmSync(tempRoot, { recursive: true, force: true });
  child.kill("SIGINT");
  process.exitCode = 0;
});

child.on("exit", (code) => {
  // The server ended on its own (crash, or an external stop). Remove the temp
  // tree and mirror the exit so Playwright reports the real failure.
  rmSync(tempRoot, { recursive: true, force: true });
  process.exit(code ?? 0);
});

const port = env.CAW_PORT;

// The specs need the exact fixture paths for their filesystem assertions, and
// reading them back out of API responses would mean casting unvalidated JSON.
// A fixed manifest in the temp dir is simpler and keeps the paths in one place.
const manifestFile = process.env.CAW_E2E_FIXTURE ?? join(tempRoot, "fixture.json");
writeFileSync(
  manifestFile,
  JSON.stringify(
    {
      port: Number(port),
      tempRoot,
      stateDir,
      rootsDir,
      password: E2E_PASSWORD,
      pid: process.pid,
      seededProjectId: seededProject.id,
      seededConversationId: seededConversation.id,
    },
    null,
    2,
  ),
  "utf8",
);

process.stdout.write(`[e2e-server] listening on http://127.0.0.1:${port}\n`);
process.stdout.write(`[e2e-server] state=${stateDir} roots=${rootsDir} fixture=${manifestFile}\n`);
