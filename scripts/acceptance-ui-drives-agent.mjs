#!/usr/bin/env node
/**
 * M4 acceptance: OUR web UI drives a REAL OMP agent, end to end.
 *
 * This replaces the M3 script, which proved only startup: it created the
 * project and conversation with `fetch` inside `page.evaluate`, never typed a
 * prompt, and stopped at a screenshot. Everything a user is claimed to do here
 * goes through the UI: login, choosing a folder, creating a project, creating a
 * chat, saving a model, typing and sending prompts, answering an approval,
 * leaving and coming back, restarting. API calls are used only for
 * preconditions an operator would otherwise do by hand (seeding the password)
 * and for host-side cross-checks a browser cannot perform (tmux pane identity,
 * journal bytes on disk).
 *
 * Requirements:
 *   - a repo checkout with `node_modules` installed (tsx + @playwright/test);
 *   - Chrome for Playwright (`channel: "chrome"`);
 *   - a working `omp` on PATH with provider credentials — this spends credits;
 *   - tmux.
 *
 * It starts and stops its OWN server on `--base`, in its own state dir, with
 * `allowedRoots` pointing at a scratch root it creates. It never touches the
 * owner's `~/.local/state/coding-agent-web`, never lists or kills a tmux session
 * it did not launch, and never prints a Collab link, room secret or token.
 *
 *   node scripts/acceptance-ui-drives-agent.mjs \
 *     --base http://127.0.0.1:8801 \
 *     --tmp /tmp/caw-acc \
 *     --root /tmp/caw-acc/roots \
 *     --password 'a-12-character-secret'
 *
 * Optional:
 *   --only check4,check5   run a subset (repeatable, comma-separated)
 *   --keep-tmp             do not delete the scratch/state dirs at the end
 *   --bootstrap            exercise the first-run token path instead of a
 *                          seeded password (see check1; the UI cannot currently
 *                          complete it — the check says so with evidence)
 *
 * Exit code is 1 if any check FAILed; SKIP never fails the run.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const execFileAsync = promisify(execFile);
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const hasFlag = (name) => argv.includes(name);

const BASE = argValue("--base", "http://127.0.0.1:8801");
const CACHE_ROOT = resolve(process.env.HOME ?? "", ".cache");
const TMP_ROOT = resolve(tmpdir());
const TMP = resolve(argValue("--tmp", join(TMP_ROOT, `caw-acc-${process.pid}`)));
const ROOT = resolve(argValue("--root", join(TMP, "roots")));
const scratchRelative = relative(TMP, ROOT);
if (existsSync(TMP)) throw new Error(`refusing to use existing temp directory: ${TMP}`);
if (!TMP.startsWith(`${TMP_ROOT}${sep}`) && dirname(TMP) !== CACHE_ROOT) throw new Error(`--tmp must be under ${TMP_ROOT} or a direct child of ${CACHE_ROOT}: ${TMP}`);
if (scratchRelative === ".." || scratchRelative.startsWith(`..${sep}`) || isAbsolute(scratchRelative)) throw new Error(`--root must be inside --tmp so cleanup stays contained: ${ROOT}`);
const STATE_DIR = join(TMP, "state");
const OMP_HOME = join(TMP, "omp-home");
const OMP_AGENT_DIR = join(TMP, "omp-agent");
const SESSION_ROOT = join(OMP_AGENT_DIR, "sessions");
const OMP_CONFIG_ROOT = join(OMP_HOME, ".omp");
const OMP_WRAPPER_DIR = join(TMP, "bin");
const REAL_AGENT_DIR = argValue("--omp-agent-dir", process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", process.env.PI_CONFIG_DIR ?? ".omp", "agent"));
const SOURCE_AGENT_DB = argValue("--omp-auth-db", process.env.PI_CODING_AGENT_DIR
  ? join(process.env.PI_CODING_AGENT_DIR, "agent.db")
  : process.env.XDG_DATA_HOME && existsSync(join(process.env.XDG_DATA_HOME, "omp"))
    ? join(process.env.XDG_DATA_HOME, "omp", "agent.db")
    : join(REAL_AGENT_DIR, "agent.db"));
const WRAPPER_PATH = join(OMP_WRAPPER_DIR, "omp");
const OMP_PID_LOG = join(TMP, "omp-processes.jsonl");
const SERVER_LOG = join(TMP, "server-output.log");
let realOmpBinary = null;
const PASSWORD = argValue("--password", null);
const BOOTSTRAP = hasFlag("--bootstrap") || !PASSWORD;
const KEEP_TMP = hasFlag("--keep-tmp");
const ONLY = argValue("--only", null)?.split(",").map((value) => value.trim()).filter(Boolean) ?? null;

const baseUrl = new URL(BASE);
if (baseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)) throw new Error(`--base must be a loopback http origin: ${BASE}`);
const port = Number(baseUrl.port || 80);
if (BASE !== baseUrl.origin || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) throw new Error(`--base must be a loopback origin without path, query, or fragment: ${BASE}`);
if (!Number.isInteger(port) || port < 1 || port >= 65535) throw new Error(`--base port must leave room for a relay port: ${port}`);
const RELAY_PORT = port + 1;
const TMUX_SOCKET = join(STATE_DIR, "tmux.sock");
const MARKER = `CAW-ACC-${randomBytes(3).toString("hex")}`;
const CHECK_TIMEOUT_MS = 120_000;
const MAX_RUNTIME_MS = 14 * 60_000;

// ── Result reporting ────────────────────────────────────────────────────────

/** One record per criterion; the JSON block at the end is the machine-readable form. */
const results = [];
let failed = false;
let setupTokenSecret = null;

const redactLink = (url) => {
  if (typeof url !== "string" || !url.includes("/r/")) return "<redacted>";
  const at = url.indexOf("/r/");
  return `${url.slice(0, at)}/r/<redacted>`;
};
const redactSecretOutput = (text) => {
  let clean = String(text).replace(/(one-time setup token:\s*)\S+/gi, "$1<redacted>");
  if (PASSWORD) clean = clean.replaceAll(PASSWORD, "<redacted-password>");
  if (setupTokenSecret) clean = clean.replaceAll(setupTokenSecret, "<redacted-setup-token>");
  const room = clean.indexOf("/r/");
  if (room >= 0) clean = `${clean.slice(0, room)}/r/<redacted>`;
  const fragment = clean.indexOf("#");
  if (fragment >= 0) clean = `${clean.slice(0, fragment)}#<redacted>`;
  return clean;
};

function record(id, status, label, evidence = "") {
  const clean = redactSecretOutput(String(evidence)).replace(/\s+/g, " ").slice(0, 1_200);
  if (status === "FAIL") failed = true;
  results.push({ id, status, label, evidence: clean });
  console.log(`${status.padEnd(4)} ${label}${clean ? ` — ${clean}` : ""}`);
}

const pass = (id, label, evidence) => record(id, "PASS", label, evidence);
const fail = (id, label, evidence) => record(id, "FAIL", label, evidence);
const skip = (id, label, evidence) => record(id, "SKIP", label, evidence);

function section(name) {
  console.log(`\n### ${name}`);
}

// ── Small utilities ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Every wait is bounded and reports which condition timed out. */
async function waitFor(label, fn, { timeout = 60_000, interval = 500 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${label}${last === undefined ? "" : ` (last=${String(last).slice(0, 120)})`}`);
}

/** Refuse to attach our scratch server to an existing listener. */
async function assertPortFree(portToCheck) {
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(portToCheck, "127.0.0.1", () => {
      probe.removeListener("error", rejectListen);
      probe.close((error) => error ? rejectListen(error) : resolveListen());
    });
  }).catch((error) => {
    throw new Error(`port ${portToCheck} unavailable; refusing to reuse another server (${error.message})`);
  });
}

const clearedAgentEnvKeys = new Set([
  "HOME", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_CONFIG_FILES",
  "PI_PROFILE", "OMP_PROFILE", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "OMP_SESSION_OWNERS_DIR",
]);
const cleanParentEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !clearedAgentEnvKeys.has(key)));

function agentEnv() {
  return {
    ...cleanParentEnv,
    HOME: OMP_HOME,
    PI_CONFIG_DIR: ".omp",
    PI_CODING_AGENT_DIR: OMP_AGENT_DIR,
    OMP_SESSION_OWNERS_DIR: join(OMP_CONFIG_ROOT, "run", "session-owners"),
    CAW_ACC_PID_LOG: OMP_PID_LOG,
    PATH: `${OMP_WRAPPER_DIR}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    TMPDIR: TMP,
  };
}

async function prepareOmpIsolation() {
  await mkdir(TMP, { recursive: true, mode: 0o700 });
  await chmod(TMP, 0o700);
  await mkdir(OMP_CONFIG_ROOT, { recursive: true, mode: 0o700 });
  realOmpBinary = await run("which", ["omp"]);
  await mkdir(OMP_AGENT_DIR, { recursive: true, mode: 0o700 });
  await chmod(OMP_AGENT_DIR, 0o700);
  await mkdir(SESSION_ROOT, { recursive: true, mode: 0o700 });
  await mkdir(OMP_WRAPPER_DIR, { recursive: true, mode: 0o700 });
  const realOmp = realOmpBinary;
  let credentialCopy = false;
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${SOURCE_AGENT_DB}${suffix}`;
    if (!existsSync(source)) continue;
    const target = `${join(OMP_AGENT_DIR, "agent.db")}${suffix}`;
    await copyFile(source, target);
    await chmod(target, 0o600);
    if (suffix === "") credentialCopy = true;
  }
  if (credentialCopy) pass("preflight-agent-auth", "provider database copied to scratch without logging secrets", `${join(OMP_AGENT_DIR, "agent.db")} (mode 0600)`);
  else skip("preflight-agent-auth", "provider credentials", "no source agent.db found; OMP may still authenticate from inherited provider environment variables");
  const configFiles = ["config.yml", "models.yml"].filter((name) => existsSync(join(REAL_AGENT_DIR, name)));
  for (const name of configFiles) {
    const source = join(REAL_AGENT_DIR, name);
    const target = join(OMP_AGENT_DIR, name);
    await copyFile(source, target);
    await chmod(target, 0o600);
    const [sourceSize, targetSize] = await Promise.all([run("stat", ["-c", "%s", source]), run("stat", ["-c", "%s", target])]);
    const [sourceHash, targetHash] = await Promise.all([run("sha256sum", [source]), run("sha256sum", [target])]);
    if (sourceSize !== targetSize || sourceHash.split(" ")[0] !== targetHash.split(" ")[0]) throw new Error(`isolated OMP config copy mismatch: ${name}`);
  }
  const copiedConfigFiles = await Promise.all(configFiles.map(async (name) => `${name} ${await run("stat", ["-c", "%s", join(OMP_AGENT_DIR, name)])} bytes`));
  console.log(`OMP config copied to private scratch: ${copiedConfigFiles.length ? copiedConfigFiles.join(", ") : "none"}`);
  console.log(`OMP config lookup: ${OMP_AGENT_DIR}/{config.yml,models.yml}`);

  const wrapper = [
    "#!/usr/bin/env node",
    'import { spawn } from "node:child_process";',
    'import { appendFileSync, readFileSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    'const argvClass = args.some((arg) => arg.startsWith("__omp_worker_")) ? "worker-daemon" : args.some((arg) => arg.startsWith("--config=")) ? "configured-omp" : "other";',
    `const child = spawn(${JSON.stringify(realOmp)}, args, {`,
    '  stdio: "inherit",',
    "  env: {",
    "    ...process.env,",
    `    HOME: ${JSON.stringify(OMP_HOME)},`,
    '    PI_CONFIG_DIR: ".omp",',
    `    PI_CODING_AGENT_DIR: ${JSON.stringify(OMP_AGENT_DIR)},`,
    `    OMP_SESSION_OWNERS_DIR: ${JSON.stringify(join(OMP_CONFIG_ROOT, "run", "session-owners"))},`,
    `    CAW_ACC_PID_LOG: ${JSON.stringify(OMP_PID_LOG)},`,
    "  },",
    "});",
    'for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));',
    'child.once("spawn", () => { try { const raw = readFileSync(`/proc/${child.pid}/stat`, "utf8"); const tail = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\\s+/); appendFileSync(process.env.CAW_ACC_PID_LOG, JSON.stringify({ pid: child.pid, startTicks: tail[19], argvClass, cwd: process.cwd() }) + "\\n", { mode: 0o600 }); } catch {} });',
    'child.on("error", (error) => { process.stderr.write(error.message + "\\n"); process.exitCode = 127; });',
    'child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });',
    "",
  ].join(String.fromCharCode(10));
  await writeFile(WRAPPER_PATH, wrapper, { mode: 0o700 });
  await chmod(WRAPPER_PATH, 0o700);
  const catalogOutput = await run(WRAPPER_PATH, ["models", "--json"], { env: agentEnv() });
  let modelCount;
  try {
    const catalog = JSON.parse(catalogOutput);
    modelCount = Array.isArray(catalog?.models) ? catalog.models.length : null;
  } catch {
    modelCount = null;
  }
  console.log(`OMP wrapper model preflight: ${modelCount ?? "invalid response"} models`);
  if (modelCount === null || modelCount === 0) {
    throw new Error(`isolated OMP model preflight failed; config lookup: ${OMP_AGENT_DIR}/{config.yml,models.yml}`);
  }
}

async function run(cmd, args, options = {}) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, ...options });
  return stdout.trim();
}

const tmux = (socket, args, env = process.env) => run("tmux", ["-S", socket, ...args], { env });
const tmuxPrivate = (args) => tmux(TMUX_SOCKET, args, agentEnv());

/** This socket is the ownership boundary; `$N` is the process identity. */
async function tmuxSessions(socket) {
  try {
    const out = await tmux(socket, ["list-sessions", "-F", "#{session_id}\t#{session_name}\t#{pane_pid}\t#{pane_current_path}"], agentEnv());
    return out ? out.split("\n").map((line) => {
      const [id, name, panePid, cwd] = line.split("\t");
      return { id, name, panePid: Number(panePid), cwd };
    }) : [];
  } catch {
    return [];
  }
}

const EXTERNAL_SOCKET = join(TMP, "external.sock");
const tmuxExternal = (args) => tmux(EXTERNAL_SOCKET, args, agentEnv());

async function paneStartCommand(sessionId, socket = TMUX_SOCKET) {
  return tmux(socket, ["list-panes", "-t", sessionId, "-F", "#{pane_start_command}"], agentEnv());
}

// ── Server lifecycle (we own this process) ──────────────────────────────────

const createdTmuxPrivate = new Set();
/** Sessions on our own scratch tmux socket (check12); never the owner's server. */
const createdTmuxExternal = new Set();
let serverChild = null;
let movedJournal = null;
/** Server stdout, so the first-run branch can read the token the server prints. */
let serverOutput = "";
const serverLogPending = { stdout: "", stderr: "" };

function serverEnv() {
  return {
    ...agentEnv(),
    CAW_CONFIG: join(TMP, "caw.config.json"),
    CAW_HOST: "127.0.0.1",
    CAW_PORT: String(port),
    CAW_STATE_DIR: STATE_DIR,
    CAW_ALLOWED_ROOTS: ROOT,
    CAW_RELAY_ALLOWED_ORIGINS: BASE,
    CAW_LOG_LEVEL: process.env.CAW_LOG_LEVEL ?? "warn",
  };
}

/** Documented entrypoint is `pnpm --filter @caw/server start` → `tsx src/server.ts`. */
async function startServer() {
  const tsx = join(REPO, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) throw new Error(`tsx not found at ${tsx}: run pnpm install first`);
  const child = spawn(tsx, ["apps/server/src/server.ts"], {
    cwd: REPO,
    env: serverEnv(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", (error) => { serverOutput += `server spawn error: ${error.message}\\n`; });
  const writeServerLines = (stream, buffer, flush = false) => {
    const text = String(buffer);
    if (flush && text.length === 0 && serverLogPending[stream].length === 0) return;
    serverOutput += text;
    const parts = (serverLogPending[stream] + text).split(String.fromCharCode(10));
    const unfinished = flush ? "" : parts.pop() ?? "";
    if (flush && parts.at(-1) !== "") parts.push(unfinished);
    serverLogPending[stream] = unfinished;
    for (const part of parts) {
      const redacted = redactSecretOutput(part);
      const timestamp = new Date().toISOString();
      appendFileSync(SERVER_LOG, `${timestamp} ${stream} ${redacted}${String.fromCharCode(10)}`, { mode: 0o600 });
      if (process.env.CAW_ACC_VERBOSE) (stream === "stdout" ? process.stdout : process.stderr).write(`[server:${timestamp}] ${redacted}${String.fromCharCode(10)}`);
    }
  };
  child.stdout.on("data", (buffer) => writeServerLines("stdout", buffer));
  child.stderr.on("data", (buffer) => writeServerLines("stderr", buffer));
  child.stdout.on("end", () => writeServerLines("stdout", "", true));
  child.stderr.on("end", () => writeServerLines("stderr", "", true));
  child.stdout.on("close", () => writeServerLines("stdout", "", true));
  child.stderr.on("close", () => writeServerLines("stderr", "", true));
  serverChild = child;
  await waitFor(`server on ${BASE}`, async () => {
    try {
      const res = await fetch(`${BASE}/`);
      return res.status < 500;
    } catch {
      return false;
    }
  }, { timeout: 45_000 });
  return child;
}

/** SIGTERM the whole process group we created; never by name, never by pattern. */
async function stopServer({ timeoutMs = 15_000 } = {}) {
  const child = serverChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, alreadyGone: true };
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    await sleep(200);
  }
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!exited) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    try { process.kill(child.pid, "SIGKILL"); } catch { /* recorded server pid already exited */ }
    const forcedDeadline = Date.now() + 5_000;
    while (Date.now() < forcedDeadline && child.exitCode === null && child.signalCode === null) await sleep(100);
  }
  const result = { exited: child.exitCode !== null || child.signalCode !== null, pid: child.pid };
  serverChild = null;
  return result;
}

// ── Preconditions and host-side cross-checks ────────────────────────────────

/** Seed the credential file the server reads at boot (the operator's hand-step). */
async function seedPassword() {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const salt = randomBytes(16);
  const hash = scryptSync(PASSWORD, salt, 64);
  const file = join(STATE_DIR, "auth-password.json");
  await writeFile(file, JSON.stringify({ salt: salt.toString("hex"), hash: hash.toString("hex"), kind: "password" }), { mode: 0o600 });
  await chmod(file, 0o600);
}

async function writeConfig() {
  await mkdir(TMP, { recursive: true });
  await mkdir(ROOT, { recursive: true });
  const config = {
    host: "127.0.0.1",
    port,
    relayPort: RELAY_PORT,
    stateDir: STATE_DIR,
    allowedRoots: [ROOT],
    maxActiveAgents: 4,
    relayAllowedOrigins: [BASE],
    logLevel: process.env.CAW_LOG_LEVEL ?? "warn",
  };
  await writeFile(join(TMP, "caw.config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Resolve a real journal only after API discovery and its OMP header agree. */
async function resolveConversationJournal(conversation, expectedCwd) {
  if (!conversation?.nativeSessionId) return null;
  let path = conversation.nativeSessionPath ?? state.journalPaths.get(conversation.nativeSessionId);
  if (!path) {
    const sessions = (await api(page, `/api/projects/${conversation.projectId}/sessions`)).body?.data ?? [];
    path = sessions.find((session) => session.sessionId === conversation.nativeSessionId)?.path;
  }
  if (!path) return null;
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  const header = text.split(String.fromCharCode(10)).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).find((entry) => entry?.type === "session");
  if (header?.id !== conversation.nativeSessionId || header.cwd !== expectedCwd) return null;
  state.journalPaths.set(conversation.nativeSessionId, path);
  return { conversation: { ...conversation, nativeSessionPath: path }, path, text, header };
}

const conversationJournalPath = (conversation) =>
  conversation?.nativeSessionPath ?? state.journalPaths.get(conversation?.nativeSessionId) ?? null;

/** Read journal named by API/header cross-check or a previously verified id. */
async function journalText(conversation) {
  let path = conversationJournalPath(conversation);
  if (!path && conversation?.nativeSessionId && state.projectPath) {
    const resolved = await resolveConversationJournal(conversation, state.projectPath);
    if (resolved) return resolved.text;
    path = conversationJournalPath(conversation);
  }
  if (!path) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function journalSize(conversation) {
  let path = conversationJournalPath(conversation);
  if (!path && conversation?.nativeSessionId && state.projectPath) {
    const resolved = await resolveConversationJournal(conversation, state.projectPath);
    if (resolved) path = resolved.path;
  }
  if (!path) return null;
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

// ── Browser helpers ─────────────────────────────────────────────────────────

let browser = null;
let context = null;
let page = null;
const consoleLog = [];
const socketLog = [];
const collabLinkResponses = [];

async function api(page, path, { method = "GET", body } = {}) {
  return page.evaluate(async ({ path, method, body }) => {
    const timedFetch = async (url, init = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try { return await fetch(url, { ...init, signal: controller.signal }); }
      finally { clearTimeout(timer); }
    };
    const csrfResponse = await timedFetch("/api/auth/me", { credentials: "include" });
    const csrf = (await csrfResponse.json())?.data?.csrfToken;
    const headers = { "content-type": "application/json", ...(method === "GET" ? {} : { "x-caw-csrf": csrf }) };
    const res = await timedFetch(path, { method, credentials: "include", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    let json = null;
    try { json = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: json };
  }, { path, method, body });
}

const conversationOf = async (id) => (await api(page, `/api/conversations/${id}`)).body?.data ?? null;

async function waitConversation(id, predicate, label, timeout = 60_000) {
  return waitFor(label, async () => {
    const conversation = await conversationOf(id);
    return conversation && predicate(conversation) ? conversation : null;
  }, { timeout, interval: 1_500 });
}

async function waitFreshConversation(id, label, timeout = 90_000) {
  let missingFields = ["conversation record"];
  return waitFor(label, async () => {
    const conversation = await conversationOf(id);
    missingFields = conversation
      ? ["tmuxSessionId", "nativeSessionId", "hostInstanceId"].filter((field) => !conversation[field])
      : ["conversation record"];
    return missingFields.length ? null : conversation;
  }, { timeout, interval: 1_500 }).catch((error) => {
    throw new Error(`${error.message}; missing fields: ${missingFields.join(", ")}`);
  });
}

// ── UI actions ──────────────────────────────────────────────────────────────

async function loginThroughUi() {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const passwordInput = page.locator("input[type=password]");
  await passwordInput.waitFor({ state: "visible", timeout: 20_000 });
  await passwordInput.fill(PASSWORD);
  await page.locator("form button[type=submit]").first().click();
  await page.locator("text=Projects").first().waitFor({ state: "visible", timeout: 20_000 });
}

/** Browse → new folder → pick → label → create, all through the UI. */
async function visibleUiFailureEvidence() {
  const errors = await page.locator('[role="alert"], .banner, .error').allInnerTexts().catch(() => []);
  const body = await page.locator("body").innerText().catch(() => "<unavailable>");
  return `visibleErrors=${JSON.stringify(errors)} body=${JSON.stringify(body.slice(0, 600))}`;
}

/** Browse → new folder → pick → label → create, all through the UI. */
async function createProjectThroughUi(folderName, label) {
  await page.locator("button", { hasText: "+ New Project" }).first().click();
  await page.locator("text=Browse Folders").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("button", { hasText: "+ New Folder" }).first().click();
  await page.locator("#new-folder-name").fill(folderName);
  const folderParentLabel = await page.locator('label[for="new-folder-name"]').innerText();
  const folderParentPath = folderParentLabel.replace(/^New folder in\s*/u, "").trim();
  await page.locator("button", { hasText: "Create folder" }).first().click();

  const folderItem = page.locator(".folder-browser-list .folder-item").filter({ hasText: folderName });
  try {
    await folderItem.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return { project: null, selectedPath: null, evidence: `folder ${folderName} did not appear in browser list; ${await visibleUiFailureEvidence()}` };
  }
  const selectedFolder = page.locator(".folder-browser-list .folder-item.selected").filter({ hasText: folderName });
  try {
    await selectedFolder.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return { project: null, selectedPath: null, evidence: `folder ${folderName} appeared but was not selected; ${await visibleUiFailureEvidence()}` };
  }
  const browserSelectedPath = join(folderParentPath, folderName);
  const selectedFolderText = await selectedFolder.innerText();
  await page.locator("button", { hasText: "Use this folder" }).first().click({ timeout: 15_000 });

  const createCard = page.locator(".card").filter({ hasText: "Create Project" }).first();
  const folderPrompt = await createCard.innerText();
  const selectedPath = /^\s*Folder:\s*(.+)$/mu.exec(folderPrompt)?.[1]?.trim() ?? browserSelectedPath;
  await page.locator('input[placeholder="Display label (e.g. My Backend)"]').fill(label);
  await page.locator("button", { hasText: "Create" }).first().click();

  let uiCardVisible = true;
  try {
    await Promise.all([
      page.locator("h2", { hasText: "Projects" }).first().waitFor({ state: "visible", timeout: 10_000 }),
      page.locator(".modal-overlay").waitFor({ state: "detached", timeout: 10_000 }),
      page.locator(".card", { hasText: label }).first().waitFor({ state: "visible", timeout: 10_000 }),
    ]);
  } catch {
    uiCardVisible = false;
  }
  const listed = await api(page, "/api/projects");
  const project = (listed.body?.data ?? []).find((item) => item.label === label) ?? null;
  const listedPaths = (listed.body?.data ?? []).map((item) => `${item.label}: ${item.path}`).join("; ") || "none";
  const evidence = `folderText=${JSON.stringify(selectedFolderText)} browserSelectedPath=${browserSelectedPath} UI-selected-path=${selectedPath} UI-card-visible=${uiCardVisible} API-status=${listed.status} API-project-path=${project?.path ?? "none"} API-projects=${listedPaths}${listed.body?.error ? ` API-error=${JSON.stringify(listed.body.error)}` : ""}${uiCardVisible ? "" : `; ${await visibleUiFailureEvidence()}`}`;
  return { project, selectedPath, evidence };
}

async function openProjectThroughUi(label) {
  await page.locator(".card", { hasText: label }).first().click();
  await page.locator("h3", { hasText: "Conversations" }).first().waitFor({ timeout: 15_000 });
}

/**
 * The project screen renders conversation cards first and native-session cards
 * after them, in `listConversations` order, so a conversation's index in that
 * list addresses its card. Titles are not usable: every chat this app creates
 * through the UI is titled "New chat".
 */
async function conversationIndex(conversationId, projectId = state.projectId) {
  const list = (await api(page, `/api/projects/${projectId}/conversations`)).body?.data ?? [];
  return list.findIndex((item) => item.id === conversationId);
}

async function openConversationThroughUi(conversationId, projectId = state.projectId) {
  const index = await conversationIndex(conversationId, projectId);
  if (index < 0) throw new Error(`conversation ${conversationId} is not in the project list`);
  await page.locator(".card").nth(index).click();
  await page.locator("textarea.composer-input").waitFor({ state: "visible", timeout: 45_000 });
}

/**
 * Create a chat with the UI's own button. Returns the conversation the app
 * created: the UI navigates into it, so we diff the project's list against the
 * ids we already know rather than trusting a position.
 */
async function newChatThroughUi(knownIds = [], projectId = state.projectId) {
  await page.locator("button", { hasText: "+ New chat" }).first().click();
  await page.locator("textarea.composer-input").waitFor({ state: "visible", timeout: 45_000 });
  return waitFor("the new conversation to appear in the project list", async () => {
    const list = (await api(page, `/api/projects/${projectId}/conversations`)).body?.data ?? [];
    return list.find((item) => !knownIds.includes(item.id))?.id ?? null;
  }, { timeout: 30_000 });
}

async function projectConversationIds(projectId = state.projectId) {
  const list = (await api(page, `/api/projects/${projectId}/conversations`)).body?.data ?? [];
  return list.map((item) => item.id);
}

/** Composer send; the UI's Send button, never a synthetic socket frame. */
async function sendPrompt(text) {
  const composer = page.locator("textarea.composer-input");
  await composer.waitFor({ state: "visible", timeout: 20_000 });
  await composer.fill(text);
  await page.locator("form.composer-container button[type=submit]").first().click();
}
async function pollHostReadiness(text, marker, intervalMs = 15_000, observeMs = 90_000) {
  const welcomeAt = await page.evaluate(() => window.__cawWelcomeAt ?? null);
  if (!welcomeAt) throw new Error("Collab welcome timestamp unavailable");
  const deadline = welcomeAt + observeMs;
  const timeline = [];
  let attempts = 0;
  let startupRefusals = 0;
  let seenFrameCount = 0;
  let outcome = "not-ready";
  while (Date.now() < deadline) {
    attempts++;
    const attemptAt = Date.now();
    const before = await page.evaluate(() => ({
      errors: (window.__cawHostPromptErrors ?? []).length,
      echoes: (window.__cawHostPromptEchoes ?? []).length,
      frameCount: (window.__cawReadinessFrames ?? []).length,
      summaryCount: (window.__cawAgentMessageSummaries ?? []).length,
    }));
    const composer = page.locator("textarea.composer-input");
    await composer.fill(text);
    const firstSendState = attempts === 1 ? await page.evaluate(() => ({
      welcomeReadOnly: (window.__cawWelcomeReadOnly ?? []).at(-1) ?? null,
      composerDisabled: document.querySelector("textarea.composer-input")?.disabled ?? null,
      composerValue: document.querySelector("textarea.composer-input")?.value ?? null,
    })) : null;
    await page.locator("form.composer-container button[type=submit]").first().click();
    if (attempts === 1) {
      await waitFor("first prompt row to render", async () => userTranscriptRowsContaining(marker) > 0, { timeout: 2_000, interval: 100 }).catch(() => null);
      await sleep(250);
      const ui = {
        firstSend: firstSendState,
        userRows: await page.locator(".message-card.user").count(),
        markerUserRows: await userTranscriptRowsContaining(marker),
        messagesContent: redactSecretOutput(await page.locator(".messages-content").innerText().catch(() => "<unavailable>"))
          .replace(/(?:\bsk[-_][A-Za-z0-9_-]{12,}|\bBearer\s+\S+|\bapi[_-]?key\s*[:=]\s*\S+)/gi, "[redacted]"),
        sendError: await page.locator('form .banner[role="alert"]').allInnerTexts().catch(() => []),
      };
      console.log("CHECK4 FIRST-SEND UI: " + JSON.stringify(ui, null, 2));
    }
    let response = null;
    while (Date.now() < Math.min(deadline, attemptAt + intervalMs)) {
      const current = await page.evaluate(() => ({
        errors: window.__cawHostPromptErrors ?? [],
        echoes: window.__cawHostPromptEchoes ?? [],
      }));
      if (current.echoes.length > before.echoes) {
        response = { kind: "echo" };
        outcome = "accepted";
        break;
      }
      const error = current.errors[before.errors];
      if (error) {
        response = { kind: error.startup ? "startup-refusal" : "other-error", message: error.message };
        if (error.startup) startupRefusals++;
        else outcome = "gate-cleared-other-error";
        break;
      }
      await sleep(100);
    }
    const app = await page.evaluate(() => {
      const frames = window.__cawReadinessFrames ?? [];
      const newFrames = frames.slice(window.__cawReadinessFrameCursor ?? 0);
      window.__cawReadinessFrameCursor = frames.length;
      return {
        appTimeSecondsAfterWelcome: ((Date.now() - (window.__cawWelcomeAt ?? Date.now())) / 1000).toFixed(1),
        banners: [...document.querySelectorAll(".banner")].map((element) => element.innerText),
        frames: newFrames,
      };
    });
    seenFrameCount += app.frames.length;
    const conversation = await conversationOf(state.conversationId);
    timeline.push({
      attempt: attempts,
      secondsAfterWelcome: ((attemptAt - welcomeAt) / 1000).toFixed(1),
      response: response ?? { kind: "no-error-or-echo-before-next-poll" },
      conversation: conversation ? { state: conversation.state, statusDetail: conversation.statusDetail } : null,
      appBanners: app.banners,
      inboundFrames: app.frames,
    });
    if (response?.kind === "echo") {
      await waitFor("host prompt echo to render", async () => userTranscriptRowsContaining(marker) === 1, {
        timeout: Math.max(1, deadline - Date.now()), interval: 100,
      });
      outcome = "accepted";
      break;
    }
    if (response?.kind === "other-error") break;
    const nextAttemptAt = welcomeAt + attempts * intervalMs;
    if (Date.now() < Math.min(deadline, nextAttemptAt)) await sleep(Math.min(deadline, nextAttemptAt) - Date.now());
  }
  const finalConversation = await conversationOf(state.conversationId);
  const finalApp = await page.evaluate(() => {
    const frames = window.__cawReadinessFrames ?? [];
    const newFrames = frames.slice(window.__cawReadinessFrameCursor ?? 0);
    window.__cawReadinessFrameCursor = frames.length;
    return {
      secondsAfterWelcome: ((Date.now() - (window.__cawWelcomeAt ?? Date.now())) / 1000).toFixed(1),
      banners: [...document.querySelectorAll(".banner")].map((element) => element.innerText),
      frames: newFrames,
    };
  });
  seenFrameCount += finalApp.frames.length;
  timeline.push({
    final: true,
    secondsAfterWelcome: finalApp.secondsAfterWelcome,
    conversation: finalConversation ? { state: finalConversation.state, statusDetail: finalConversation.statusDetail } : null,
    appBanners: finalApp.banners,
    inboundFrames: finalApp.frames,
  });
  console.log("\n--- CHECK4 STARTUP READINESS TIMELINE ---");
  console.log(JSON.stringify({ outcome, attempts, startupRefusals, observedSecondsAfterWelcome: finalApp.secondsAfterWelcome, observedInboundFrameCount: seenFrameCount, timeline }, null, 2));
  return { kind: outcome, attempts, startupRefusals, observedSeconds: Number(finalApp.secondsAfterWelcome) };
}

async function transcriptText() {
  return page.locator(".messages-content").innerText();
}
async function userTranscriptRowsContaining(marker) {
  return page.locator(".message-card.user").filter({ hasText: marker }).count();
}


async function assistantTranscriptRows() {
  return page.locator(".message-card.assistant .message-content").allInnerTexts();
}

async function toolTranscriptText() {
  return (await page.locator(".message-card.tool").allInnerTexts()).join("\\n");
}

// ── Checks ──────────────────────────────────────────────────────────────────

const state = {
  projectId: null,
  projectPath: null,
  conversationId: null,
  nativeSessionId: null,
  tmuxSessionId: null,
  secondConversationId: null,
  secondNativeSessionId: null,
  approvalConversationId: null,
  subagentConversationId: null,
  approvalProjectId: null,
  journalPaths: new Map(),
};

const checks = {
  async check1() {
    section("check1 login through the UI");
    if (BOOTSTRAP) {
      // Fresh state: the server mints a one-time token and prints it to stdout
      // (apps/server/src/auth.ts:153). The owner is documented to "enter that
      // token and choose a password" (docs/operations/ubuntu-setup.md:103), so
      // this branch checks whether the UI can actually do that.
      const token = await waitFor("the server to print its one-time setup token", async () => {
        const match = /one-time setup token: (\S+)/.exec(serverOutput);
        return match?.[1] ?? null;
      }, { timeout: 20_000 }).catch(() => null);
      setupTokenSecret = token;
      if (!token) {
        fail("check1a", "server printed a first-run setup token", `stdout had no "one-time setup token: …" line; first 200 chars: ${serverOutput.slice(0, 200)}`);
        return;
      }
      pass("check1a", "server printed a first-run setup token", `captured token value redacted (${token.length} chars)`);

      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.locator("input[type=password]").fill(token);
      await page.locator("form button[type=submit]").first().click();
      await page.locator("text=Projects").first().waitFor({ state: "visible", timeout: 20_000 });

      // The session now carries passwordSetupRequired, and every API except
      // set-password/logout is refused (apps/server/src/app.ts:112). If the UI
      // offers no way to set a password, the app is unusable from a browser.
      const probe = await api(page, "/api/projects");
      const setPasswordUi = await page.locator("text=/set.pass|choose a password|new password/i").count();
      if (probe.status === 403) {
        fail(
          "check1b",
          "the UI can finish first-run password setup",
          `GET /api/projects → 403 ${JSON.stringify(probe.body?.error ?? null)}; password-setup controls found in the DOM: ${setPasswordUi}. The server exposes POST /api/auth/set-password; no UI calls it.`,
        );
      } else {
        pass("check1b", "the UI can finish first-run password setup", `GET /api/projects → ${probe.status}`);
      }
      return;
    }
    await loginThroughUi();
    pass("check1", "login through the UI (seeded password) lands on the projects screen", `url=${BASE}/`);
  },

  async check2() {
    section("check2 folder, project, chat, path cross-check");
    const folder = `proj-${MARKER.toLowerCase()}`;
    const label = `Acceptance ${MARKER}`;
    const { project, selectedPath, evidence } = await createProjectThroughUi(folder, label);
    if (!project) {
      fail("check2a", "project created from a folder typed in the UI", evidence);
      return false;
    }
    pass("check2a", "project created from a folder typed in the UI", `id=${project.id}; ${evidence}`);

    const expected = join(ROOT, folder);
    if (project.path === selectedPath && selectedPath === expected) {
      pass("check2b", "project path matches selected folder and typed folder", `selected=${selectedPath} API=${project.path}`);
    } else {
      fail("check2b", "project path matches selected folder and typed folder", `expected=${expected} UI-selected=${selectedPath} API=${project.path}`);
    }
    state.projectId = project.id;
    state.projectPath = project.path;

    await openProjectThroughUi(label);
    const conversationId = await newChatThroughUi([]);
    const conversation = await waitFreshConversation(conversationId, "conversation launch", 90_000);
    state.conversationId = conversation.id;
    state.nativeSessionId = conversation.nativeSessionId;
    state.tmuxSessionId = conversation.tmuxSessionId;
    if (conversation.tmuxSessionId) createdTmuxPrivate.add(conversation.tmuxSessionId);
    pass("check2c", "chat launch published tmux, native-session, and host identity", `state=${conversation.state} tmux=${conversation.tmuxSessionId} native=${conversation.nativeSessionId} host=${conversation.hostInstanceId}`);

    const sessions = await tmuxSessions(TMUX_SOCKET);
    const session = sessions.find((item) => item.id === conversation.tmuxSessionId);
    if (session?.cwd === project.path) {
      pass("check2d", "tmux pane cwd equals the project path", `pane_current_path=${session.cwd}`);
    } else {
      fail("check2d", "tmux pane cwd equals the project path", `session=${conversation.tmuxSessionId} expected=${project.path} got=${session?.cwd ?? "missing"}`);
    }
    return true;
  },

  async check3() {
    section("check3 model preference, effective model, Save & restart");
    const conversation = await conversationOf(state.conversationId);
    const catalog = await api(page, "/api/models");
    const models = catalog.body?.data?.models ?? [];

    await page.locator("summary", { hasText: "Conversation model settings" }).first().click();
    const dropdown = page.locator("select#conversation-model");
    if (!(await dropdown.count())) {
      fail("check3-dropdown", "model selected from a dropdown", "select#conversation-model is missing from the conversation settings DOM");
    }

    let chosen;
    if (models.length > 0) {
      chosen = models.find((model) => model !== conversation?.model) ?? models[0];
      if (await dropdown.count()) {
        await dropdown.selectOption(chosen);
        pass("check3-dropdown", "model selected from a dropdown", `select#conversation-model=${chosen}`);
      } else {
        await page.locator("#custom-model").fill(chosen);
      }
    } else {
      const customModel = page.locator("#custom-model");
      if (!(await customModel.count())) {
        fail("check3", "custom model accepted when catalog is empty", "model catalog was empty and #custom-model is missing from the conversation settings DOM");
        return;
      }
      chosen = conversation?.model ?? conversation?.modelPreference;
      if (!chosen) {
        fail("check3", "custom model accepted when catalog is empty", "model catalog was empty and conversation has no current model ID to enter in #custom-model");
        return;
      }
      await customModel.fill(chosen);
      pass("check3-custom", "custom model ID used with empty catalog", `catalog source=${catalog.body?.data?.source ?? "?"}; #custom-model=${chosen}`);
    }
    const before = { preference: conversation?.modelPreference ?? null, effective: conversation?.model ?? null };
    await page.locator("button", { hasText: "Save model" }).first().click();
    await waitFor("model preference saved", async () => {
      const current = await conversationOf(state.conversationId);
      return current?.modelPreference === chosen ? current : null;
    }, { timeout: 20_000 });
    const afterSave = await conversationOf(state.conversationId);
    if (afterSave.modelPreference === chosen) {
      pass("check3a", "saved model preference through the UI", `${before.preference} → ${afterSave.modelPreference}`);
    } else {
      fail("check3a", "saved model preference through the UI", `expected ${chosen} got ${afterSave.modelPreference}`);
    }
    if (afterSave.model === before.effective) {
      pass("check3b", "effective model unchanged before restart", `model=${afterSave.model}`);
    } else {
      fail("check3b", "effective model unchanged before restart", `effective moved ${before.effective} → ${afterSave.model} on save alone`);
    }
    const priorJournalPath = conversationJournalPath(afterSave);
    const journalBefore = priorJournalPath ? await readFile(priorJournalPath, "utf8").catch(() => null) : null;
    if (!journalBefore || !priorJournalPath) {
      skip("check3e", "same native journal survives model restart", "journal is written on first flush; continuity is covered by check10");
    }
    await page.locator("button", { hasText: "Save & restart agent" }).first().click();
    const restarted = await waitFor("restart to produce a new tmux session", async () => {
      const current = await conversationOf(state.conversationId);
      return current && current.tmuxSessionId && current.tmuxSessionId !== state.tmuxSessionId ? current : null;
    }, { timeout: 90_000 });
    if (restarted.tmuxSessionId) createdTmuxPrivate.add(restarted.tmuxSessionId);
    await waitFor("Collab connection restored after model restart", async () => /Connected — no turn in flight/.test(await page.locator("body").innerText()), { timeout: 45_000 });
    state.tmuxSessionId = restarted.tmuxSessionId;
    state.nativeSessionId = restarted.nativeSessionId;

    const argv = await paneStartCommand(restarted.tmuxSessionId).catch(() => "");
    if (argv.includes(`--model=${chosen}`)) {
      pass("check3c", "new tmux argv carries the chosen model", argv.slice(0, 200));
    } else {
      fail("check3c", "new tmux argv carries the chosen model", `expected --model=${chosen} in: ${argv.slice(0, 200)}`);
    }
    if (restarted.nativeSessionId === priorNative && restarted.nativeSessionId) {
      pass("check3d", "nativeSessionId preserved across restart", restarted.nativeSessionId);
    } else {
      fail("check3d", "nativeSessionId preserved across restart", `${priorNative} → ${restarted.nativeSessionId}`);
    }
    const journalAfter = journalBefore && priorJournalPath ? await journalText(restarted) : null;
    if (journalBefore && priorJournalPath && journalAfter && restarted.nativeSessionPath === priorJournalPath && journalAfter.includes(priorNative)) {
      pass("check3e", "same native journal survives model restart", `path=${restarted.nativeSessionPath} bytes=${journalAfter.length} header/session=${priorNative}`);
    } else if (journalBefore && priorJournalPath) {
      fail("check3e", "same native journal survives model restart", `path=${priorJournalPath} → ${restarted.nativeSessionPath}; journal=${journalAfter ? journalAfter.length : "unreadable"}; session id present=${Boolean(priorNative && journalAfter?.includes(priorNative))}`);
    }
  },

  async check4() {
    section("check4 prompt in, echo and real reply, journal cross-check");
    const marker = `${MARKER}-4`;
    const prompt = `Reply with exactly this text and nothing else: ${marker} ACK`;
    const diagnostics = await waitFor("Collab welcome or link rejection", async () => {
      const welcomeReadOnly = await page.evaluate(() => window.__cawWelcomeReadOnly ?? []);
      const responses = await Promise.all(collabLinkResponses);
      return welcomeReadOnly.length || responses.some((response) => response.status !== 200) ? { welcomeReadOnly, responses } : null;
    }, { timeout: 45_000, interval: 250 }).catch(() => null);
    const welcomeReadOnly = diagnostics?.welcomeReadOnly ?? await page.evaluate(() => window.__cawWelcomeReadOnly ?? []);
    const linkEvidence = JSON.stringify(diagnostics?.responses ?? await Promise.all(collabLinkResponses));
    const composerState = await page.locator("textarea.composer-input").evaluate((element) => ({ disabled: element.disabled, placeholder: element.getAttribute("placeholder") }));
    const controlEvidence = `linkResponses=${linkEvidence} welcomeReadOnly=${JSON.stringify(welcomeReadOnly)} composer=${JSON.stringify(composerState)}`;
    if (!diagnostics || welcomeReadOnly.at(-1) === true || composerState.disabled) {
      fail("check4", "control Collab link permits prompts", `${controlEvidence}${diagnostics ? "" : " welcome/link timeout"}`);
      return;
    }
    const sendResult = await pollHostReadiness(prompt, marker, 15_000, 90_000);
    if (sendResult.kind === "not-ready") {
      fail("check4-host-readiness", "host becomes ready within 90 seconds", `host never became ready within ${sendResult.observedSeconds.toFixed(1)}s (${sendResult.startupRefusals} startup refusals across ${sendResult.attempts} sends)`);
      return;
    }
    if (sendResult.kind === "gate-cleared-other-error") {
      fail("check4-host-error", "host accepts prompt after startup gate clears", "host gate cleared but a different error prevented prompt acceptance");
      return;
    }
    if (sendResult.kind !== "accepted") {
      fail("check4-delivery", "host echoes prompt within 90 seconds", `no host echo after ${sendResult.attempts} sends`);
      return;
    }
    pass("check4a", "user echo appears exactly once in transcript", `marker=${marker} attempts=${sendResult.attempts} startupRefusals=${sendResult.startupRefusals}`);

    await waitFor("assistant reply after the prompt", async () => {
      const rows = await assistantTranscriptRows();
      return rows.some((row) => row.includes(marker)) ? rows : null;
    }, { timeout: 180_000 });
    await waitFor("assistant turn to finish", async () => /Connected — no turn in flight/.test(await page.locator("body").innerText()), { timeout: 60_000 });
    const assistantRows = await assistantTranscriptRows();
    const replyRegion = assistantRows.find((row) => row.includes(marker))?.trim() ?? "";
    pass("check4b", "a real assistant reply follows the prompt", replyRegion.slice(0, 120));

    const conversation = await waitFor("journal to contain the prompt marker", async () => {
      const current = await conversationOf(state.conversationId);
      const resolved = await resolveConversationJournal(current, state.projectPath);
      return resolved?.text.includes(marker) ? { current: resolved.conversation, journal: resolved.text, path: resolved.path } : null;
    }, { timeout: 30_000 });
    pass("check4c", "journal on disk contains the prompt marker", `native=${conversation.current.nativeSessionId} path=${conversation.path}`);
    state.nativeSessionId = conversation.current.nativeSessionId;

    const needle = replyRegion.slice(0, 40);
    if (needle.length > 8 && conversation.journal.includes(needle)) {
      pass("check4d", "journal contains the assistant reply text", `needle=${needle}`);
    } else {
      fail("check4d", "journal contains the assistant reply text", `needle=${needle} present=${conversation.journal.includes(needle)}`);
    }
  },

  async check5() {
    section("check5 follow-up while running, draft not wiped");
    const first = `${MARKER}-5a`;
    const second = `${MARKER}-5b`;
    const draft = `${MARKER}-5draft`;
    await sendPrompt(`Run this harmless command and print its result: sleep 20; printf '%s\\n' ${first}`);
    await waitFor("turn to be in flight", async () => /Agent is working on a turn/.test(await page.locator("body").innerText()), { timeout: 30_000 });

    await sendPrompt(`Also mention ${second} in your answer.`);
    const composer = page.locator("textarea.composer-input");
    await composer.fill(draft);
    await sleep(4_000);
    const draftAfter = await composer.inputValue().catch(() => "");
    if (draftAfter === draft) {
      pass("check5a", "draft typed after sending survives", `value=${JSON.stringify(draftAfter)}`);
    } else {
      fail("check5a", "draft typed after sending survives", `expected ${JSON.stringify(draft)} got ${JSON.stringify(draftAfter)}`);
    }

    await waitFor("both markers reach the journal", async () => {
      const current = await conversationOf(state.conversationId);
      const journal = await journalText(current);
      return journal && journal.includes(first) && journal.includes(second) ? journal : null;
    }, { timeout: 240_000 });
    pass("check5b", "both sent markers reached the host journal", `${first} + ${second}`);
  },

  /**
   * Approval needs `tools.approvalMode: always-ask` (v18.12.2 tag:
   * tools/settings.ts:311-315). We set it in the PROJECT config
   * (`<project>/.omp/config.yml`) because the app generates the launch overlay
   * itself and we must not edit source. Without the setting, the mode defaults
   * to `yolo` and no dialog is expected — that is a SKIP naming the key, never a
   * pass.
   */
  async check6() {
    section("check6 approval dialog (Approve then Deny)");
    const folder = `approval-${MARKER.toLowerCase()}`;
    const label = `Approval ${MARKER}`;
    const project = await createProjectThroughUi(folder, label);
    if (!project) {
      skip("check6", "approval dialog", "approval project could not be created");
      return;
    }
    state.approvalProjectId = project.id;
    const settingsDir = join(project.path, ".omp");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "config.yml"), "tools:\n  approvalMode: always-ask\n");

    await openProjectThroughUi(label);
    const conversationId = await newChatThroughUi([], project.id);
    const conversation = await waitFreshConversation(conversationId, "approval conversation launch", 90_000);
    if (conversation.tmuxSessionId) createdTmuxPrivate.add(conversation.tmuxSessionId);
    state.approvalConversationId = conversation.id;

    const card = page.locator(".card", { hasText: "Approval Requested" });
    const approveMarker = `${MARKER}-6ok`;
    await sendPrompt(`Run this exact harmless shell command and show its output: echo ${approveMarker}`);
    const appeared = await card.waitFor({ state: "visible", timeout: 120_000 }).then(() => true).catch(() => false);
    if (!appeared) {
      skip("check6a", "approval dialog appears", `no dialog with tools.approvalMode=always-ask in ${project.path}/.omp/config.yml; setting tried, but this OMP/config combination did not request approval`);
      return;
    }
    pass("check6a", "approval dialog appears", `title=${(await card.locator("p").first().innerText().catch(() => "")).slice(0, 120)}`);

    const beforeApprove = await toolTranscriptText();
    const approveButton = card.locator("button").filter({ hasNotText: /deny|reject|decline|refuse|disallow|cancel/i }).first();
    await approveButton.click();
    await waitFor("approved tool result", async () => {
      const text = await toolTranscriptText();
      return text.length > beforeApprove.length && text.includes(approveMarker) ? text : null;
    }, { timeout: 90_000 });
    pass("check6b", "Approve lets the shell tool run", `tool transcript contains ${approveMarker}`);

    const denyMarker = `${MARKER}-6no`;
    const beforeDeny = await toolTranscriptText();
    await sendPrompt(`Run this exact harmless shell command and show its output: echo ${denyMarker}`);
    const secondCard = await card.waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
    if (!secondCard) {
      skip("check6c", "Deny blocks the shell tool", "second approval dialog did not appear");
    } else {
      const denyButton = card.locator("button").filter({ hasText: /deny|reject|decline|refuse|disallow|cancel/i }).first();
      await denyButton.click();
      const deniedTools = await waitFor("host denial result", async () => {
        const text = await toolTranscriptText();
        return text.length > beforeDeny.length ? text : null;
      }, { timeout: 60_000 });
      if (!deniedTools.includes(denyMarker) && /denied|declined|rejected|not approved/i.test(deniedTools)) {
        pass("check6c", "Deny blocked the shell tool", `tool result=${deniedTools.slice(-160)}`);
      } else {
        fail("check6c", "Deny blocked the shell tool", `tool result=${deniedTools.slice(-160)} marker=${denyMarker}`);
      }
    }
  },
  async check7() {
    section("check7 leave and return mid-turn, history restored once");
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator("text=Projects").first().waitFor({ state: "visible", timeout: 20_000 });
    await openProjectThroughUi(`Acceptance ${MARKER}`);
    await openConversationThroughUi(state.conversationId);
    const marker = `${MARKER}-7`;
    await sendPrompt(`Run this harmless command and print its result: sleep 20; printf '%s\\n' ${marker}`);
    await waitFor("turn in flight for the navigation test", async () => /Agent is working on a turn/.test(await page.locator("body").innerText()), { timeout: 30_000 });

    await page.locator('button[title="Back"]').first().click();
    await page.locator("h3", { hasText: "Conversations" }).first().waitFor({ timeout: 15_000 });
    await openConversationThroughUi(state.conversationId);
    await waitFor("transcript restored after returning", async () => (await userTranscriptRowsContaining(marker)) > 0, { timeout: 60_000 });
    const occurrences = await userTranscriptRowsContaining(marker);
    if (occurrences === 1) {
      pass("check7a", "history restored exactly once after leaving and returning", `user rows containing marker=${occurrences}`);
    } else {
      fail("check7a", "history restored exactly once after leaving and returning", `user rows containing marker=${occurrences}`);
    }
    const journal = await journalText(await conversationOf(state.conversationId));
    const userJournalRows = journal?.split("\n").filter((line) => {
      try {
        const entry = JSON.parse(line);
        return entry.type === "message" && entry.message?.role === "user" && line.includes(marker);
      } catch {
        return false;
      }
    }).length ?? 0;
    if (userJournalRows === 1) {
      pass("check7b", "nothing was silently resent (one user journal row)", `user journal rows containing marker=${userJournalRows}`);
    } else {
      fail("check7b", "nothing was silently resent (one user journal row)", `user journal rows containing marker=${userJournalRows}`);
    }
  },

  async check8() {
    section("check8 two chats in one project keep separate sessions");
    await page.locator('button[title="Back"]').first().click();
    await page.locator("h3", { hasText: "Conversations" }).first().waitFor({ timeout: 15_000 });
    const secondId = await newChatThroughUi([state.conversationId]);
    const second = await waitFreshConversation(secondId, "second conversation launch", 90_000);
    if (second.tmuxSessionId) createdTmuxPrivate.add(second.tmuxSessionId);
    state.secondConversationId = second.id;
    state.secondNativeSessionId = second.nativeSessionId;

    const markerSecond = `${MARKER}-8b`;
    await sendPrompt(`Reply with exactly: ${markerSecond} ACK`);
    await waitFor("second chat journal holds its marker", async () => {
      const journal = await journalText(await conversationOf(second.id));
      return journal && journal.includes(markerSecond);
    }, { timeout: 180_000 });

    const first = await conversationOf(state.conversationId);
    const secondJournal = await journalText(await conversationOf(second.id));
    const firstJournal = await journalText(first);
    const firstMarker = `${MARKER}-4`;
    if (first.nativeSessionId !== second.nativeSessionId) {
      pass("check8a", "each conversation kept its own nativeSessionId", `${first.nativeSessionId} vs ${second.nativeSessionId}`);
    } else {
      fail("check8a", "each conversation kept its own nativeSessionId", `both are ${first.nativeSessionId}`);
    }
    if (firstJournal?.includes(firstMarker) && !secondJournal?.includes(firstMarker) && secondJournal?.includes(markerSecond) && !firstJournal?.includes(markerSecond)) {
      pass("check8b", "each marker landed only in its own journal", `${firstMarker}→${first.nativeSessionId}; ${markerSecond}→${second.nativeSessionId}`);
    } else {
      fail("check8b", "each marker landed only in its own journal", `firstOwn=${Boolean(firstJournal?.includes(firstMarker))} secondOwn=${Boolean(secondJournal?.includes(markerSecond))} crossLeak=${Boolean(firstJournal?.includes(markerSecond) || secondJournal?.includes(firstMarker))}`);
    }
  },

  async check9() {
    section("check9 backend restart keeps identity, adds no second writer");
    const before = await conversationOf(state.conversationId);
    const leaseSet = async () => {
      const unix = await readFile("/proc/net/unix", "utf8");
      return [...new Set(unix.match(/@omp-file-lock-[0-9a-f]{32}/g) ?? [])].sort();
    };
    const leasesBefore = await leaseSet();
    const sessionsBefore = (await tmuxSessions(TMUX_SOCKET)).length;

    const stopped = await stopServer();
    if (!stopped.exited) {
      fail("check9a", "backend stops for the restart test", "server did not exit after SIGTERM");
      return;
    }
    await startServer();
    await loginThroughUi();
    await openProjectThroughUi(`Acceptance ${MARKER}`);
    await openConversationThroughUi(state.conversationId);
    const after = await conversationOf(state.conversationId);
    if (after.nativeSessionId === before.nativeSessionId && after.tmuxSessionId === before.tmuxSessionId) {
      pass("check9a", "identity survives a backend restart", `native=${after.nativeSessionId} tmux=${after.tmuxSessionId} state=${after.state}`);
    } else {
      fail("check9a", "identity survives a backend restart", `before ${before.nativeSessionId}/${before.tmuxSessionId} after ${after.nativeSessionId}/${after.tmuxSessionId}`);
    }
    const sessionsAfter = (await tmuxSessions(TMUX_SOCKET)).length;
    const leasesAfter = await leaseSet();
    if (sessionsAfter === sessionsBefore && JSON.stringify(leasesAfter) === JSON.stringify(leasesBefore)) {
      pass("check9b", "no second writer appeared", `private tmux sessions ${sessionsBefore}→${sessionsAfter}, lease sockets ${leasesBefore.length}→${leasesAfter.length}`);
    } else {
      fail("check9b", "no second writer appeared", `private tmux sessions ${sessionsBefore}→${sessionsAfter}, lease sockets ${leasesBefore.length}→${leasesAfter.length}`);
    }
  },

  async check10() {
    section("check10 agent restart resumes the same journal");
    const before = await conversationOf(state.conversationId);
    const sizeBefore = await journalSize(before);
    await page.locator("summary", { hasText: "Conversation model settings" }).first().click();
    const chosen = (await conversationOf(state.conversationId)).modelPreference ?? "default";
    await page.locator("#conversation-model").fill(chosen);
    await page.locator("button", { hasText: "Save & restart agent" }).first().click();
    const after = await waitFor("agent restart to finish", async () => {
      const current = await conversationOf(state.conversationId);
      return current && current.tmuxSessionId && current.tmuxSessionId !== before.tmuxSessionId ? current : null;
    }, { timeout: 90_000 });
    if (after.tmuxSessionId) createdTmuxPrivate.add(after.tmuxSessionId);
    await waitFor("Collab connection restored after agent restart", async () => /Connected — no turn in flight/.test(await page.locator("body").innerText()), { timeout: 45_000 });

    if (after.nativeSessionId === before.nativeSessionId) {
      pass("check10a", "nativeSessionId survives an agent restart", after.nativeSessionId);
    } else {
      fail("check10a", "nativeSessionId survives an agent restart", `${before.nativeSessionId} → ${after.nativeSessionId}`);
    }
    const marker = `${MARKER}-10`;
    await sendPrompt(`Reply with exactly: ${marker} ACK`);
    const journalAfter = await waitFor("journal to append the post-restart prompt", async () => {
      const current = await conversationOf(state.conversationId);
      const text = await journalText(current);
      return text?.includes(marker) ? text : null;
    }, { timeout: 90_000 });
    const sizeAfter = await journalSize(after);
    if (sizeBefore !== null && sizeAfter !== null && sizeAfter > sizeBefore && journalAfter.includes(marker)) {
      pass("check10b", "journal grew rather than reset", `${sizeBefore} → ${sizeAfter} bytes; marker=${marker}`);
    } else {
      fail("check10b", "journal grew rather than reset", `${sizeBefore} → ${sizeAfter} bytes; marker=${journalAfter.includes(marker)}`);
    }
    const argv = await paneStartCommand(after.tmuxSessionId).catch(() => "");
    if (before.nativeSessionPath && argv.includes("--resume") && argv.includes(before.nativeSessionPath)) {
      pass("check10c", "new argv carries --resume <journal path>", argv.slice(0, 220));
    } else {
      fail("check10c", "new argv carries --resume <journal path>", `expected --resume ${before.nativeSessionPath} in: ${argv.slice(0, 220)}`);
    }
    state.tmuxSessionId = after.tmuxSessionId;
  },

  async check11() {
    section("check11 restart with the known journal missing is refused");
    const conversation = await conversationOf(state.conversationId);
    if (!conversation?.nativeSessionPath || !conversation.nativeSessionId) {
      skip("check11", "restart refuses when the known journal is missing", "conversation has no recorded journal to move aside");
      return;
    }
    if (conversation.state !== "stopped") {
      const stop = await api(page, `/api/conversations/${state.conversationId}/actions`, { method: "POST", body: { action: "stop" } });
      if (stop.status !== 200) {
        skip("check11", "restart refusal with missing journal", `could not stop created agent first: ${stop.status} ${JSON.stringify(stop.body?.error ?? null)}`);
        return;
      }
      await waitConversation(state.conversationId, (current) => current.state === "stopped", "agent stop before moving its journal", 30_000);
    }
    const journal = conversation.nativeSessionPath;
    const header = await readFile(journal, "utf8").then((text) => text.split("\n").slice(0, 2).join("\n")).catch(() => "");
    if (!header.includes(conversation.nativeSessionId)) {
      skip("check11", "restart refuses when the known journal is missing", `refusing to move ${journal}: its header does not name ${conversation.nativeSessionId}`);
      return;
    }

    // Only the journal this run created is ever touched; verify identity first.
    const aside = `${journal}.caw-acc-aside`;
    await rename(journal, aside);
    movedJournal = { journal, aside };
    const sessionsBefore = (await tmuxSessions(TMUX_SOCKET)).map((session) => session.id).sort().join(",");

    await page.locator("summary", { hasText: "Conversation model settings" }).first().click();
    await page.locator("#conversation-model").fill(conversation.modelPreference ?? "default");
    const restartResponsePromise = page.waitForResponse((response) =>
      response.request().method() === "POST" && response.url().includes(`/api/conversations/${state.conversationId}/actions`),
    { timeout: 60_000 });
    await page.locator("button", { hasText: "Save & restart agent" }).first().click();
    const restartResponse = await restartResponsePromise;
    const restartBody = await restartResponse.json().catch(() => null);

    const after = await conversationOf(state.conversationId);
    const sessionsAfter = (await tmuxSessions(TMUX_SOCKET)).map((session) => session.id).sort().join(",");
    const launched = sessionsAfter !== sessionsBefore;
    if (restartResponse.status() !== 200 && !launched) {
      pass("check11a", "restart refuses missing journal and launches nothing", `POST restart → ${restartResponse.status()} code=${restartBody?.error?.code ?? "none"} sessions=${sessionsAfter || "none"}`);
    } else {
      fail("check11a", "restart refuses missing journal and launches nothing", `POST restart → ${restartResponse.status()} code=${restartBody?.error?.code ?? "none"}; sessions ${sessionsBefore || "none"} → ${sessionsAfter || "none"}`);
    }
    if (after.nativeSessionId === conversation.nativeSessionId) {
      pass("check11b", "nativeSessionId not silently replaced", after.nativeSessionId);
    } else {
      fail("check11b", "nativeSessionId not silently replaced", `${conversation.nativeSessionId} → ${after.nativeSessionId}`);
    }

    await rename(aside, journal);
    movedJournal = null;
    pass("check11c", "journal restored after the check", journal);
    if (launched) {
      const sessions = await tmuxSessions(TMUX_SOCKET);
      for (const session of sessions) if (!sessionsBefore.split(",").includes(session.id)) createdTmuxPrivate.add(session.id);
    }
  },

  async check12() {
    section("check12 a hand-started host is reported external and cannot be stopped");
    // The app must not be the writer, so stop our own agent first (the UI has no
    // stop-conversation control; this is an operator action).
    const stopped = await api(page, `/api/conversations/${state.conversationId}/actions`, { method: "POST", body: { action: "stop" } });
    if (stopped.status !== 200) {
      skip("check12", "external host classification", `could not stop the managed agent: ${stopped.status} ${JSON.stringify(stopped.body?.error ?? null)}`);
      return;
    }
    const conversation = await conversationOf(state.conversationId);
    if (!conversation.nativeSessionPath) {
      skip("check12", "external host classification", "conversation has no journal to resume by hand");
      return;
    }

    const overlay = join(STATE_DIR, "overlays", `${conversation.id.replace(/[^a-zA-Z0-9-]/g, "")}.yml`);
    // A tmux server of our own for this check: never the owner's default server,
    // never the app's private socket. Both are outside our ownership boundary.
    const args = [
      "new-session", "-d", "-P", "-F", "#{session_id}",
      "-s", `caw-acc-ext-${process.pid}`,
      "-c", conversation.nativeSessionPath.replace(/\/[^/]+$/, ""),
      "omp", `--config=${overlay}`, "--resume", conversation.nativeSessionPath,
    ];
    const manualId = await tmuxExternal(args);
    createdTmuxExternal.add(manualId);
    pass("check12a", "hand-started agent running outside the app's socket", `tmux ${manualId} on ${EXTERNAL_SOCKET}, --resume ${conversation.nativeSessionPath}`);

    const external = await waitFor("app to classify the hand-started host as external", async () => {
      const current = await conversationOf(state.conversationId);
      return current?.ownership === "external" ? current : null;
    }, { timeout: 120_000 }).catch(() => null);
    if (external) {
      pass("check12b", "app reports it as external", `ownership=${external.ownership} state=${external.state} detail=${external.statusDetail ?? ""}`);
    } else {
      const current = await conversationOf(state.conversationId);
      fail("check12b", "app reports it as external", `ownership=${current?.ownership} state=${current?.state} detail=${current?.statusDetail ?? ""}`);
    }

    const refusal = await api(page, `/api/conversations/${state.conversationId}/actions`, { method: "POST", body: { action: "stop" } });
    const alive = (await tmuxSessions(EXTERNAL_SOCKET)).some((session) => session.id === manualId);
    if (refusal.status !== 200 && alive) {
      pass("check12c", "stop refuses instead of killing it", `POST stop → ${refusal.status} ${JSON.stringify(refusal.body?.error?.code ?? null)}; tmux ${manualId} still alive`);
    } else {
      fail("check12c", "stop refuses instead of killing it", `status=${refusal.status} alive=${alive}`);
    }

    await tmuxExternal(["kill-session", "-t", manualId]).catch(() => {});
    createdTmuxExternal.delete(manualId);
    await sleep(2_000);
    pass("check12d", "hand-started session cleaned up by recorded id", `tmux ${manualId} on ${EXTERNAL_SOCKET}`);
  },

  /**
   * Create one untracked stopped native session with a short real OMP print
   * request, then resume it through the UI. The hand-start is a host-side
   * precondition; creating the conversation and writer uses the product UI.
   */
  async check13() {
    section("check13 resume a stopped native session through the UI");
    const appConversation = await conversationOf(state.conversationId);
    if (appConversation?.state !== "stopped") {
      const stop = await api(page, `/api/conversations/${state.conversationId}/actions`, { method: "POST", body: { action: "stop" } });
      if (stop.status !== 200) {
        skip("check13", "app-owned agent stopped before resume", `POST stop → ${stop.status} ${JSON.stringify(stop.body?.error ?? null)}`);
        return;
      }
      await waitConversation(state.conversationId, (current) => current.state === "stopped", "app agent stop before resume", 30_000);
    }
    pass("check13a", "app-owned agent stopped before resume", `state=${(await conversationOf(state.conversationId))?.state}`);
    const before = (await api(page, `/api/projects/${state.projectId}/sessions`)).body?.data ?? [];
    const marker = `${MARKER}-13`;
    const output = await tmuxExternal([
      "new-session", "-d", "-P", "-F", "#{session_id}\\t#{pane_pid}",
      "-s", `caw-acc-resume-${process.pid}`,
      "-c", state.projectPath,
      "omp", "--print", `Reply with exactly: ${marker} ACK`,
    ]).catch((error) => `error: ${error.message}`);
    if (String(output).startsWith("error")) {
      skip("check13", "resume in app", `could not create disposable OMP journal: ${output}`);
      return;
    }
    const [externalId, panePidText] = output.split(String.fromCharCode(9));
    const panePid = Number(panePidText);
    createdTmuxExternal.add(externalId);
    const created = await waitFor("OMP to write a new stopped session journal", async () => {
      const current = (await api(page, `/api/projects/${state.projectId}/sessions`)).body?.data ?? [];
      return current.find((session) => !before.some((old) => old.sessionId === session.sessionId) && session.cwd === state.projectPath && session.live === false && !session.tracked) ?? null;
    }, { timeout: 90_000 }).catch(() => null);
    if (!created) {
      await tmuxExternal(["kill-session", "-t", externalId]).catch(() => {});
      createdTmuxExternal.delete(externalId);
      skip("check13", "resume in app", "no new free, untracked journal appeared after the one-shot OMP prompt");
      return;
    }
    const original = await readFile(created.path, "utf8").catch(() => "");
    const header = original.split(String.fromCharCode(10)).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((entry) => entry?.type === "session");
    if (header?.id !== created.sessionId || !original.includes(marker)) {
      await tmuxExternal(["kill-session", "-t", externalId]).catch(() => {});
      createdTmuxExternal.delete(externalId);
      skip("check13", "resume in app", `journal header/marker mismatch for ${created.path}; refusing to resume unverified session id`);
      return;
    }
    await tmuxExternal(["kill-session", "-t", externalId]).catch(() => {});
    createdTmuxExternal.delete(externalId);
    pass("check13a", "hand-started journal verified and writer stopped", `tmux ${externalId} panePID=${panePid} session=${header.id} bytes=${original.length}`);

    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator("text=Projects").first().waitFor({ state: "visible", timeout: 20_000 });
    await openProjectThroughUi(`Acceptance ${MARKER}`);
    const resume = page.locator("button", { hasText: "Resume in app" }).first();
    const available = await resume.waitFor({ state: "visible", timeout: 45_000 }).then(() => true).catch(() => false);
    if (!available) {
      const notes = await page.locator("text=/Writer lease|already has a writer/").allInnerTexts().catch(() => []);
      skip("check13b", "resume in app starts a writer", `no Resume in app button; lease evidence: ${notes.join(" | ").slice(0, 160)}`);
      return;
    }
    const excludedIds = await projectConversationIds();
    await resume.click();
    await page.locator("textarea.composer-input").waitFor({ state: "visible", timeout: 90_000 });
    const resumed = await waitFor("the resumed conversation to have a writer", async () => {
      const list = (await api(page, `/api/projects/${state.projectId}/conversations`)).body?.data ?? [];
      const candidate = list.find((item) => !excludedIds.includes(item.id) && item.nativeSessionId === created.sessionId);
      return candidate?.tmuxSessionId ? candidate : null;
    }, { timeout: 90_000 });
    createdTmuxPrivate.add(resumed.tmuxSessionId);
    const argv = await paneStartCommand(resumed.tmuxSessionId).catch(() => "");
    if (argv.includes("--resume") && argv.includes(created.path)) {
      pass("check13b", "resumed writer carries --resume <that journal>", argv.slice(0, 220));
    } else {
      fail("check13b", "resumed writer carries --resume <that journal>", `expected --resume ${created.path} in: ${argv.slice(0, 220)}`);
    }
    const journal = await journalText(resumed);
    if (resumed.nativeSessionId === created.sessionId && journal?.includes(marker)) {
      pass("check13c", "resumed conversation keeps session identity and history", `native=${resumed.nativeSessionId} bytes=${journal.length} marker=${marker}`);
    } else {
      fail("check13c", "resumed conversation keeps session identity and history", `native=${resumed.nativeSessionId} expected=${created.sessionId} marker=${Boolean(journal?.includes(marker))}`);
    }
    state.resumedConversationId = resumed.id;
  },

  async check14() {
    section("check14 subagent transcript loads and grows");
    await page.locator('button[title="Back"]').first().click();
    await page.locator("h3", { hasText: "Conversations" }).first().waitFor({ timeout: 15_000 });
    const conversationId = await newChatThroughUi(await projectConversationIds());
    const conversation = await waitFreshConversation(conversationId, "subagent conversation launch", 90_000);
    if (conversation.tmuxSessionId) createdTmuxPrivate.add(conversation.tmuxSessionId);
    state.subagentConversationId = conversation.id;

    const markerStart = `${MARKER}-14a`;
    const markerEnd = `${MARKER}-14b`;
    await sendPrompt(`Use the task tool to start exactly one subagent. Its entire job: print ${markerStart}, run harmless shell sleep 25, then print ${markerEnd}. Do not read or modify files.`);
    const agentsButton = page.locator("button", { hasText: "Agents (" }).first();
    const agentsVisible = await agentsButton.waitFor({ state: "visible", timeout: 120_000 }).then(() => true).catch(() => false);
    if (!agentsVisible) {
      skip("check14", "subagent transcript", "no Agents (n) button appeared; model did not visibly spawn a subagent");
      return;
    }
    await agentsButton.click();
    await page.locator(".modal-content .card").first().click();
    const transcript = page.locator(".modal-content pre code").first();
    await transcript.waitFor({ state: "visible", timeout: 60_000 });
    pass("check14a", "subagent transcript loads", `initial text=${(await transcript.innerText()).slice(0, 100)}`);

    const tapAvailable = await page.evaluate(() => window.__cawTranscriptTap === true);
    if (!tapAvailable) {
      skip("check14b", "host transcript newSize advances", "browser crypto instrumentation unavailable; rendered text alone cannot prove two cursor offsets");
    } else {
      const initialReplies = await page.evaluate(() => window.__cawTranscriptReplies ?? []);
      const firstReply = await waitFor("first fetch-transcript reply", async () => {
        const replies = await page.evaluate(() => window.__cawTranscriptReplies ?? []);
        return replies.length > initialReplies.length ? replies[replies.length - 1] : null;
      }, { timeout: 30_000 });
      await waitFor("second subagent output reaches its transcript", async () => (await transcript.innerText()).includes(markerEnd), { timeout: 90_000 });
      const secondReply = await waitFor("fetch-transcript cursor advances after new output", async () => {
        const replies = await page.evaluate(() => window.__cawTranscriptReplies ?? []);
        return replies.find((reply, index) => index >= initialReplies.length && reply.newSize > firstReply.newSize) ?? null;
      }, { timeout: 30_000 });
      pass("check14b", "transcript grows across two reads", `newSize ${firstReply.newSize} → ${secondReply.newSize}`);
    }

    await waitFor("subagent task to settle", async () => (await conversationOf(conversation.id))?.state === "idle", { timeout: 60_000 }).catch(() => null);
    const button = page.locator('[aria-label="Close subagents"]').first();
    await button.click();
    const repliesAfterDrain = await page.evaluate(() => (window.__cawTranscriptReplies ?? []).length);
    await sleep(3_500);
    const repliesAfterClose = await page.evaluate(() => (window.__cawTranscriptReplies ?? []).length);
    if (repliesAfterClose === repliesAfterDrain) {
      pass("check14c", "closing the panel stops transcript polling", `decrypt-observed transcript replies ${repliesAfterDrain} → ${repliesAfterClose} over 3.5s`);
    } else {
      fail("check14c", "closing the panel stops transcript polling", `decrypt-observed transcript replies ${repliesAfterDrain} → ${repliesAfterClose} over 3.5s`);
    }
  },

  async check15() {
    section("check15 view-only link disables composer and withholds approval controls");
    if (!state.approvalConversationId || !state.approvalProjectId) {
      skip("check15", "read-only access link", "approval conversation was not created; check6 could not prepare live approval host");
      return;
    }
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator("text=Projects").first().waitFor({ state: "visible", timeout: 20_000 });
    await openProjectThroughUi(`Approval ${MARKER}`);
    await openConversationThroughUi(state.approvalConversationId, state.approvalProjectId);
    await sendPrompt(`Run this exact harmless shell command and show its output: echo ${MARKER}-15`);
    const approvalVisible = await page.locator(".card", { hasText: "Approval Requested" }).first().waitFor({ state: "visible", timeout: 90_000 }).then(() => true).catch(() => false);
    if (!approvalVisible) {
      skip("check15", "read-only approval controls", "no pending approval; project config tools.approvalMode=always-ask could not produce a dialog");
      return;
    }
    const minted = await api(page, `/api/conversations/${state.approvalConversationId}/link?access=view`, { method: "POST" });
    if (minted.status !== 200 || !minted.body?.data?.url) {
      skip("check15", "read-only access link", `POST link?access=view → ${minted.status} ${JSON.stringify(minted.body?.error ?? null)}`);
      return;
    }
    const link = minted.body.data.url;
    const fragment = new URL(link).hash.slice(1);
    if (!fragment) {
      skip("check15", "read-only access link", `view link has no browser fragment (${redactLink(link)})`);
      return;
    }
    const guest = await context.newPage();
    try {
      const guestUrl = new URL("/guest", BASE);
      guestUrl.hash = fragment;
      await guest.goto(guestUrl.href, { waitUntil: "domcontentloaded" });
      const composer = guest.locator("textarea").first();
      await composer.waitFor({ state: "visible", timeout: 60_000 });
      const disabled = await composer.isDisabled();
      const placeholder = await composer.getAttribute("placeholder");
      const chip = await guest.locator("text=read-only").count();
      const approvalControls = guest.locator(".sh-composer-ask button");
      const approvalCount = await approvalControls.count();
      const enabledApprovalCount = await approvalControls.evaluateAll((buttons) => buttons.filter((button) => !button.disabled).length);
      const evidence = `link=${redactLink(link)} disabled=${disabled} placeholder=${JSON.stringify(placeholder)} readOnlyChip=${chip} approvalControls=${approvalCount} enabledApprovalControls=${enabledApprovalCount}`;
      if (disabled && chip > 0 && enabledApprovalCount === 0) {
        pass("check15", "view-only guest cannot prompt or answer approval", evidence);
      } else {
        fail("check15", "view-only guest cannot prompt or answer approval", evidence);
      }
    } catch (error) {
      fail("check15", "view-only guest cannot prompt or answer approval", `guest page error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await guest.close().catch(() => {});
    }
  },
};

async function procIdentity(pid) {
  try {
    const rawStat = await readFile(`/proc/${pid}/stat`, "utf8");
    const tail = rawStat.slice(rawStat.lastIndexOf(") ") + 2).trim().split(" ");
    return { state: tail[0], startTicks: tail[19] };
  } catch {
    return null;
  }
}

async function stopRecordedOmpProcesses() {
  if (!existsSync(OMP_PID_LOG) || !realOmpBinary) return ["OMP child PID log: none"];
  const rows = (await readFile(OMP_PID_LOG, "utf8")).split(String.fromCharCode(10)).filter(Boolean);
  const identities = new Map();
  for (const row of rows) {
    try {
      const item = JSON.parse(row);
      if (Number.isSafeInteger(item.pid) && typeof item.startTicks === "string") identities.set(`${item.pid}:${item.startTicks}`, item);
    } catch {
      // Ignore only a torn trailing append.
    }
  }
  const proof = [];
  for (const { pid, startTicks } of identities.values()) {
    let identity = await procIdentity(pid);
    if (!identity || identity.state === "Z") {
      proof.push(`OMP pid ${pid} start=${startTicks} already exited`);
      continue;
    }
    if (identity.startTicks !== startTicks) {
      proof.push(`OMP pid ${pid} start=${startTicks} was reused; left untouched`);
      failed = true;
      continue;
    }
    try { process.kill(pid, "SIGTERM"); } catch { /* process exited between identity check and signal */ }
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (identity = await procIdentity(pid))?.startTicks === startTicks && identity.state !== "Z") await sleep(100);
    if (identity?.startTicks === startTicks && identity.state !== "Z") {
      try { process.kill(pid, "SIGKILL"); } catch { /* process exited */ }
      await sleep(200);
    }
    identity = await procIdentity(pid);
    const exited = !identity || identity.startTicks !== startTicks || identity.state === "Z";
    proof.push(`OMP pid ${pid} start=${startTicks} → ${exited ? "exited" : "STILL RUNNING"}`);
    if (!exited) failed = true;
  }
  return proof;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup() {
  section("CLEANUP");
  const proof = [];

  // TMP did not exist at preflight, so every session on these two scratch
  // sockets belongs to this run. Record each `$N` before killing it.
  for (const session of await tmuxSessions(TMUX_SOCKET)) createdTmuxPrivate.add(session.id);
  for (const session of await tmuxSessions(EXTERNAL_SOCKET)) createdTmuxExternal.add(session.id);
  for (const sessionId of createdTmuxPrivate) await tmuxPrivate(["kill-session", "-t", sessionId]).catch(() => {});
  for (const sessionId of createdTmuxExternal) await tmuxExternal(["kill-session", "-t", sessionId]).catch(() => {});
  await sleep(1_000);

  await tmux(TMUX_SOCKET, ["kill-server"], agentEnv()).catch(() => {});
  await tmux(EXTERNAL_SOCKET, ["kill-server"], agentEnv()).catch(() => {});
  const privateList = await tmuxPrivate(["list-sessions", "-F", "#{session_id}"]).then((out) => out || "none").catch(() => "no server running");
  const externalList = await tmuxExternal(["list-sessions", "-F", "#{session_id}"]).then((out) => out || "none").catch(() => "no server running");
  proof.push(`tmux -S ${TMUX_SOCKET} list-sessions → ${privateList}`);
  proof.push(`tmux -S ${EXTERNAL_SOCKET} list-sessions → ${externalList}`);
  proof.push("owner's default tmux server → never contacted");

  const stopped = await stopServer();
  proof.push(`server pid ${stopped.pid ?? "unknown"} → ${stopped.exited ? "exited" : "STILL RUNNING"}`);
  if (!stopped.exited) failed = true;
  const ompProof = await stopRecordedOmpProcesses();
  proof.push(...ompProof);
  const ownedProcessSurvived = !stopped.exited || ompProof.some((line) => line.includes("→ STILL RUNNING"));

  if (movedJournal) {
    await rename(movedJournal.aside, movedJournal.journal).catch(() => {});
    proof.push(`journal restored → ${movedJournal.journal}`);
    movedJournal = null;
  } else {
    proof.push("journal moved aside → none (nothing to restore)");
  }

  proof.push(`timestamped redacted server output log ${SERVER_LOG} → ${KEEP_TMP ? "kept (--keep-tmp)" : "removed with scratch directory"}`);
  if (!KEEP_TMP) {
    await rm(TMP, { recursive: true, force: true }).catch(() => {});
    proof.push(`scratch/state under ${TMP} → removed`);
  } else {
    proof.push(`scratch/state under ${TMP} → kept (--keep-tmp)`);
  }

  for (const line of proof) console.log(`   ${line}`);
  return proof;
}

// ── Main ────────────────────────────────────────────────────────────────────

const selected = Object.keys(checks).filter((name) => !ONLY || ONLY.includes(name));
if (selected.includes("check2") && !selected.includes("check1")) selected.unshift("check1");

async function main() {
  console.log(`acceptance run: marker=${MARKER} base=${BASE} tmp=${TMP} root=${ROOT}`);
  if (hasFlag("--bootstrap") && PASSWORD) throw new Error("--bootstrap and --password are mutually exclusive");
  if (BOOTSTRAP && !PASSWORD) console.log("no --password given: test fresh-state bootstrap flow; later checks SKIP because app has no password-setup UI");

  await assertPortFree(port);
  await assertPortFree(RELAY_PORT);
  await writeConfig();
  if (PASSWORD) await seedPassword();
  await prepareOmpIsolation();
  await startServer();

  try {
    browser = await chromium.launch({ channel: "chrome" });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    await context.addInitScript(`window.__cawExpectedPromptMarker = ${JSON.stringify(`${MARKER}-4`)};`);
    await context.addInitScript(() => {
      const marker = window.__cawExpectedPromptMarker;
      const messageContainsMarker = (message) => {
        if (message?.role !== "user") return false;
        const content = message.content;
        const text = typeof content === "string" ? content : Array.isArray(content)
          ? content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("")
          : "";
        return text.includes(marker);
      };
      try {
        const subtle = globalThis.crypto.subtle;
        const decrypt = subtle.decrypt.bind(subtle);
        Object.defineProperty(subtle, "decrypt", {
          configurable: true,
          value: async (...args) => {
            const plaintext = await decrypt(...args);
            try {
              const frame = JSON.parse(new TextDecoder().decode(plaintext));
              if (frame?.t === "welcome") {
                (window.__cawWelcomeReadOnly ??= []).push(frame.readOnly === true);
                window.__cawWelcomeAt ??= Date.now();
              }
              if (frame?.t === "error") {
                (window.__cawHostPromptErrors ??= []).push({
                  startup: /starting up|session transition completes/i.test(frame.message ?? ""),
                  message: frame.message ?? "",
                });
              }
              const frames = window.__cawReadinessFrames ??= [];
              if (frame?.t === "event" && frame.event?.type === "message_end" && ["custom", "assistant"].includes(frame.event.message?.role)) {
                const message = frame.event.message;
                const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
                  ? message.content.filter((part) => part?.type === "text").map((part) => part.text ?? "").join("")
                  : "";
                const safe = content.replace(/(?:sk|rk|pk|xox[baprs])-?[A-Za-z0-9_-]{12,}/gi, "[redacted]")
                  .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
                  .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
                (window.__cawAgentMessageSummaries ??= []).push({ role: message.role, text: safe.slice(0, 40) });
              }
              if (frame?.t === "event" && ["message_start", "turn_start", "agent_start", "message_end", "turn_end", "agent_end"].includes(frame.event?.type)) {
                frames.push({ t: frame.t, eventType: frame.event.type, role: frame.event.message?.role ?? null });
              } else if (frame?.t === "bus") {
                frames.push({ t: frame.t, channel: frame.channel });
              } else if (frame?.t === "event" && frame.event?.type === "notice") {
                frames.push({ t: frame.t, eventType: "notice", level: frame.event.level ?? null });
              }
              if (frame?.t === "transcript" && Number.isSafeInteger(frame.newSize)) {
                (window.__cawTranscriptReplies ??= []).push({ newSize: frame.newSize, textLength: typeof frame.text === "string" ? frame.text.length : 0 });
              }
            } catch {
              // Ignore every non-transcript frame; record no contents.
            }
            return plaintext;
          },
        });
        window.__cawTranscriptTap = true;
      } catch {
        window.__cawTranscriptTap = false;
      }
    });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("console", (message) => consoleLog.push(redactSecretOutput(`[console:${message.type()}] ${message.text().slice(0, 200)}`)));
    page.on("response", (response) => { if (/\/api\/conversations\/[^/]+\/link(?:\?|$)/.test(response.url())) collabLinkResponses.push((async () => { const body = await response.json().catch(() => null); let secretBytes = null; try { const outer = new URL(body.data.url); const relay = new URL(outer.hash.slice(1)); const match = /\.([A-Za-z0-9_-]+)$/.exec(relay.pathname); secretBytes = match ? Buffer.from(match[1], "base64url").length : 0; } catch {} return { status: response.status(), access: body?.data?.access ?? null, error: body?.error?.code ?? null, secretBytes }; })()); });
    page.on("pageerror", (error) => consoleLog.push(redactSecretOutput(`[pageerror] ${error.message.slice(0, 200)}`)));
    page.on("websocket", (socket) => {
      const entry = { role: "unknown", url: redactLink(socket.url()), framesSent: 0 };
      socketLog.push(entry);
      socket.on("framesent", () => { entry.framesSent += 1; });
    });

    const deadline = Date.now() + MAX_RUNTIME_MS;
    for (const [index, name] of selected.entries()) {
      if (!PASSWORD && name !== "check1") {
        skip(name, `${name} (needs --password)`, "bootstrap flow has no UI password setup; later checks cannot authenticate");
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining < 5_000) {
        for (const pending of selected.slice(index)) skip(pending, `${pending} (overall runtime budget)`, "14-minute run deadline reached");
        break;
      }
      const budget = Math.min(CHECK_TIMEOUT_MS, remaining);
      const started = Date.now();
      let timeoutHandle;
      let checkPromise;
      let result;
      try {
        checkPromise = Promise.resolve().then(() => checks[name]());
        result = await Promise.race([
          checkPromise,
          new Promise((resolveTimeout) => { timeoutHandle = setTimeout(() => resolveTimeout("__timeout__"), budget); }),
        ]);
      } catch (error) {
        fail(name, `${name} ran to completion`, error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timeoutHandle);
      }
      if (result === "__timeout__") {
        fail(name, `${name} completed within ${budget}ms`, "check exceeded its time budget; browser closed and cleanup started");
        await browser.close().catch(() => {});
        browser = null;
        page = null;
        await Promise.race([checkPromise.catch(() => {}), sleep(2_000)]);
        for (const pending of selected.slice(index + 1)) skip(pending, `${pending} (after timed-out check)`, "browser closed to enforce runtime budget");
        break;
      }
      console.log(`   (${name} took ${Math.round((Date.now() - started) / 1000)}s)`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

let proof = [];
try {
  await main();
} catch (error) {
  fail("runner", "acceptance driver startup and checks", error instanceof Error ? error.message : String(error));
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    proof = await cleanup();
  } catch (error) {
    fail("cleanup", "all owned processes and scratch files cleaned", error instanceof Error ? error.message : String(error));
    proof.push(`cleanup error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────

const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const result of results) counts[result.status] += 1;
console.log(`\n${counts.PASS} PASS / ${counts.FAIL} FAIL / ${counts.SKIP} SKIP (${results.length} checks)`);
if (consoleLog.length > 0) {
  console.log("\n--- browser console (last 10) ---");
  for (const line of consoleLog.slice(-10)) console.log(`   ${line}`);
}
console.log("\n--- RESULTS JSON ---");
console.log(JSON.stringify({ marker: MARKER, base: BASE, counts, checks: results, cleanup: proof }, null, 2));

process.exit(failed ? 1 : 0);
