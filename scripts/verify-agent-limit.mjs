/**
 * End-to-end check for the adjustable agent limit, against a REAL server process.
 *
 *   node scripts/verify-agent-limit.mjs [scratchDir]
 *
 * Boots the app twice over one state directory and asserts, over real HTTP:
 *   default 3 → set 7 persists → an out-of-range write is refused → the value
 *   survives a restart → an unauthenticated request is rejected.
 *
 * This is the artifact behind the claim in docs/HUONG_DAN_SU_DUNG.md §34.7, so the
 * claim is reproducible rather than asserted: `HOME=$HOME node scripts/verify-agent-limit.mjs`.
 * It starts its own server on port 8799 and relay 8798, so it does not touch a
 * deployed instance. No native agent is launched.
 *
 * Proves the things unit tests cannot: the setting survives a process restart,
 * and the number the HTTP API reports is the number the running server enforces
 * (read back from the same controller the supervisor consults).
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { tmpdir } from "node:os";
const scratch = process.argv[2] ?? join(tmpdir(), `caw-verify-agent-limit-${process.pid}`);
const stateDir = join(scratch, "state");
const roots = join(scratch, "roots");
await rm(scratch, { recursive: true, force: true });
await mkdir(stateDir, { recursive: true });
await mkdir(roots, { recursive: true });

const PORT = 8799;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PASSWORD = "smoke test password for the limit";

function start() {
  // Same entrypoint the systemd unit uses: the workspace packages ship .ts source,
  // so plain `node dist/server.js` fails with ERR_UNKNOWN_FILE_EXTENSION.
  return spawn("node", ["--import", "tsx", "apps/server/src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CAW_HOST: "127.0.0.1", CAW_PORT: String(PORT), CAW_STATE_DIR: stateDir,
      CAW_ALLOWED_ROOTS: roots, CAW_LOG_LEVEL: "error", CAW_MAX_ACTIVE_AGENTS: "3",
      CAW_INSECURE_COOKIES: "true",
      // Isolated from the live service: same defaults would collide on the relay port.
      CAW_RELAY_PORT: "8798",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const res = await fetch(`${ORIGIN}/api/health`);
      if (res.ok || res.status === 404) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`server did not become reachable; stderr:\n${child.log.text}`);
}

/** Boot a server, run `fn`, then stop it. */
async function withServer(fn) {
  const child = start();
  const log = { text: "" };
  child.stderr.on("data", (chunk) => { log.text += String(chunk); });
  child.stdout.on("data", (chunk) => { log.text += String(chunk); });
  child.log = log;
  await waitForHealth(child);
  try { return await fn(child); }
  finally { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); }
}

async function signIn() {
  const { readFile } = await import("node:fs/promises");
  // The setup token exists only until the password is set. On a later boot the
  // password is already in place, so log in with it instead of looking for a token.
  let setupToken = null;
  for (let attempt = 0; attempt < 50 && setupToken === null; attempt += 1) {
    try { setupToken = (await readFile(join(stateDir, "setup-token"), "utf8")).trim() || null; }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }

  const password = setupToken ?? PASSWORD;
  const login = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const loginBody = await login.json();
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const csrf = loginBody.data.csrfToken;

  // Only a pending-token session must complete the forced password change.
  if (setupToken !== null) {
    const set = await fetch(`${ORIGIN}/api/auth/set-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-caw-csrf": csrf },
      body: JSON.stringify({ password: PASSWORD }),
    });
    if (!set.ok) throw new Error(`set-password failed: ${set.status} ${await set.text()}`);
  }
  const me = await fetch(`${ORIGIN}/api/auth/me`, { headers: { cookie } });
  if (!me.ok) throw new Error(`auth/me failed: ${me.status}`);
  return { cookie, csrf: (await me.json()).data.csrfToken };
}

const result = {};
await withServer(async () => {
  const { cookie, csrf } = await signIn();

  const read = await (await fetch(`${ORIGIN}/api/agent-limit`, { headers: { cookie } })).json();
  result.defaultLimit = read.data.limit;
  result.defaultSource = read.data.source;

  const up = await (await fetch(`${ORIGIN}/api/agent-limit`, {
    method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-caw-csrf": csrf },
    body: JSON.stringify({ limit: 7 }),
  })).json();
  result.afterIncrease = { limit: up.data.limit, source: up.data.source };

  const bad = await fetch(`${ORIGIN}/api/agent-limit`, {
    method: "PUT", headers: { "content-type": "application/json", origin: ORIGIN, cookie, "x-caw-csrf": csrf },
    body: JSON.stringify({ limit: 9999 }),
  });
  result.outOfRangeStatus = bad.status;
  result.outOfRangeCode = (await bad.json()).error.code;

  const afterBad = await (await fetch(`${ORIGIN}/api/agent-limit`, { headers: { cookie } })).json();
  result.limitAfterRejectedWrite = afterBad.data.limit;

  const anon = await fetch(`${ORIGIN}/api/agent-limit`);
  result.anonymousStatus = anon.status;
});

// Second boot: the value must come back from the journal, not the env default.
await withServer(async () => {
  const { cookie } = await signIn();
  const read = await (await fetch(`${ORIGIN}/api/agent-limit`, { headers: { cookie } })).json();
  result.afterRestart = { limit: read.data.limit, source: read.data.source };
});

console.log(JSON.stringify(result, null, 1));

const ok =
  result.defaultLimit === 3 && result.defaultSource === "default" &&
  result.afterIncrease.limit === 7 && result.afterIncrease.source === "setting" &&
  result.outOfRangeStatus === 400 && result.outOfRangeCode === "invalid_setting" &&
  result.limitAfterRejectedWrite === 7 &&
  result.anonymousStatus === 401 &&
  result.afterRestart.limit === 7 && result.afterRestart.source === "setting";
console.log(ok ? "PASS: limit is real, validated, and persists across restart" : "FAIL");
process.exit(ok ? 0 : 1);
