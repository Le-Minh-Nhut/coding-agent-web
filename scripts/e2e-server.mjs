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
 * Creating a conversation goes through the real supervisor and does launch a
 * process in tmux — but that process is the recorder stub `CAW_OMP_BINARY_PATH`
 * pins, so it exits immediately and starts no agent. The seeded pair still lets a
 * spec *open* a conversation without depending on a launch having happened; see
 * `tests/e2e/no-launch-guard.spec.ts` for the spec that does create one and
 * asserts, from the recorder log, that only the stub ever ran.
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
// This harness must never start a real agent. `omp` IS installed on a developer
// machine, so a create-chat that reaches the launch path would spawn the owner's
// real binary inside tmux — their config, their session, their credits.
//
// The guard is now product-level, not an absent binary:
//   1. `CAW_OMP_BINARY_PATH` pins `config.ompBinaryPath`, and that one value is
//      the binary every `omp` invocation the server makes resolves to — the
//      Collab registry read, the model catalog, the capability probe *and* the
//      command tmux is asked to launch. A launched "agent" is therefore this
//      stub, which dies immediately and stays harmless.
//   2. The stub appends every argv it receives to `CAW_E2E_OMP_STUB_LOG`, which is
//      how a spec proves after the fact which binary was executed.
//   3. A canary directory holds an executable named `omp` and is prepended to
//      PATH. It appends to `CAW_E2E_OMP_CANARY_LOG` and exits 1, so any code path
//      that still resolves a bare `omp` leaves evidence there. The spec asserts
//      that log is empty.
//
// Two extra layers keep the *registry* route clean on a runner with no OMP:
// first, the product answers `[]` on its own when the registry directory is
// absent (no directory means no host has ever published); second, the pinned
// stub answers `collab list` with an empty host list. The registry directory is
// pointed at the harness temp tree through `XDG_STATE_HOME` so the *populated
// directory* case is exercised hermetically — the owner's real
// `~/.omp/run/collab-hosts` is never read by a test.
const stubBinDir = join(tempRoot, "stub-bin");
mkdirSync(stubBinDir, { recursive: true });
const stubOmp = join(stubBinDir, "omp");
const stubLog = join(tempRoot, "omp-stub-argv.jsonl");
const canaryDir = join(tempRoot, "canary-bin");
mkdirSync(canaryDir, { recursive: true });
const canaryLog = join(tempRoot, "omp-canary.jsonl");
const xdgStateHome = join(tempRoot, "xdg-state");
const registryDir = join(xdgStateHome, "omp", "run", "collab-hosts");
mkdirSync(registryDir, { recursive: true });
writeFileSync(
  stubOmp,
  [
    `#!${process.execPath}`,
    "// Test double for `omp`: never a real agent. It answers the one registry read",
    "// the server makes, records every other invocation, and refuses it, so a",
    "// launched 'agent' dies in milliseconds.",
    'const { appendFileSync } = require("node:fs");',
    "const argv = process.argv.slice(2);",
    'if (argv[0] === "collab" && argv[1] === "list") {',
    '  process.stdout.write(\'{"version":1,"hosts":[]}\\n\');',
    "  process.exit(0);",
    "}",
    // `process.argv[1]` is this script, i.e. the path tmux was handed; recording it
    // lets a spec assert which binary was executed, not merely that one was.
    "const record = JSON.stringify({ exe: process.argv[1], argv });",
    `const log = process.env.CAW_E2E_OMP_STUB_LOG || ${JSON.stringify(stubLog)};`,
    "try { appendFileSync(log, `${record}\\n`); } catch {}",
    'process.stderr.write(`e2e stub omp: unsupported call: ${argv.join(" ")}\\n`);',
    "process.exit(1);",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(
  join(canaryDir, "omp"),
  [
    "#!/bin/sh",
    "# PATH canary. Any code path that still resolves a bare `omp` lands here and",
    "# leaves a line in the canary log, which the no-launch spec asserts is absent.",
    'printf \'%s\\n\' "[canary] $*" >> "$CAW_E2E_OMP_CANARY_LOG"',
    'echo "e2e canary omp: not an agent." >&2',
    "exit 1",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

const env = {
  ...process.env,
  CAW_HOST: "127.0.0.1",
  CAW_PORT: process.env.CAW_E2E_PORT ?? "4399",
  CAW_STATE_DIR: stateDir,
  CAW_ALLOWED_ROOTS: `${rootsDir},${secondaryRootsDir}`,
  // See the block above: this single value pins every omp call the server makes,
  // launch included. `CAW_OMP_PATH` is deliberately gone — nothing ever read it.
  CAW_OMP_BINARY_PATH: stubOmp,
  CAW_E2E_OMP_STUB_LOG: stubLog,
  CAW_E2E_OMP_CANARY_LOG: canaryLog,
  // Collab registry directory (and the session-lease owner dir) live in the harness
  // temp tree, so the "directory exists" branch is exercised without reading the
  // owner's real ~/.omp state.
  XDG_STATE_HOME: xdgStateHome,
  // Canary first: if any code path still runs a bare `omp`, it lands here and the
  // no-launch spec fails on a non-empty canary log instead of quietly paying for a
  // real agent.
  PATH: `${canaryDir}:${process.env.PATH ?? ""}`,
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
      // Proof surface for the no-launch guard: the binary every omp call is pinned
      // to, and the two logs the specs read after exercising a create.
      stubOmpPath: stubOmp,
      stubLogPath: stubLog,
      canaryLogPath: canaryLog,
      registryDir,
    },
    null,
    2,
  ),
  "utf8",
);

process.stdout.write(`[e2e-server] listening on http://127.0.0.1:${port}\n`);
process.stdout.write(`[e2e-server] state=${stateDir} roots=${rootsDir} fixture=${manifestFile}\n`);
