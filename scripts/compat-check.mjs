#!/usr/bin/env node
/**
 * Compatibility probe for the machine this product runs on.
 *
 * Answers one question: "is the OMP surface we depend on actually present and
 * shaped the way we assume?" It launches nothing and spawns no agent, so it is
 * free to run in CI and safe to run while agents are working.
 *
 * Usage: node scripts/compat-check.mjs [--json]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const run = promisify(execFile);
const asJson = process.argv.includes("--json");

async function capture(cmd, args, timeout = 15_000) {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout, maxBuffer: 4 << 20 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error?.stderr ?? error?.message ?? error) };
  }
}

const checks = [];
function check(name, status, detail) {
  checks.push({ name, status, detail });
}

// ── OMP binary and version ──────────────────────────────────────────────────
const ompVersion = await capture("omp", ["--version"]);
check(
  "omp binary",
  ompVersion.ok ? "ok" : "missing",
  ompVersion.ok ? ompVersion.stdout : ompVersion.stderr.split("\n")[0],
);
const parsedVersion = /^omp\/(\S+)/.exec(ompVersion.stdout)?.[1] ?? null;
check("omp version parsed", parsedVersion ? "ok" : "warn", parsedVersion ?? "unrecognised --version output");

const ompHelp = await capture("omp", ["--help"]);
for (const flag of ["--resume", "--restore", "--config=", "--session-dir="]) {
  check(
    `omp --help exposes ${flag}`,
    ompHelp.stdout.includes(flag) ? "ok" : "fail",
    flag,
  );
}

// ── Collab CLI surface ──────────────────────────────────────────────────────
const collabHelp = await capture("omp", ["collab", "--help"]);
check(
  "omp collab list|link present",
  collabHelp.stdout.includes("list") && collabHelp.stdout.includes("link") ? "ok" : "fail",
  collabHelp.ok ? "help rendered" : collabHelp.stderr.split("\n")[0],
);

export function evaluateCollabList(parsed) {
  const required = [
    "instanceId",
    "generation",
    "pid",
    "sessionId",
    "cwd",
    "relayConnected",
    "inputRequired",
    "busy",
    "access",
  ];
  if (parsed?.version !== 1) {
    return {
      status: "fail",
      detail: `version=${parsed?.version ?? "unknown"} (expected 1)`,
    };
  }
  const hosts = Array.isArray(parsed?.hosts) ? parsed.hosts : [];
  if (hosts.length === 0) {
    return {
      status: "warn",
      detail: `version=${parsed.version} hosts=0 — no collab hosts running; per-host shape unverifiable without a live host`,
    };
  }
  const host = hosts[0];
  const missing = required.filter((key) => !(key in host));
  if (missing.length > 0) {
    return {
      status: "fail",
      detail: `version=${parsed.version} hosts=${hosts.length} missing=${missing.join(",")}`,
    };
  }
  return {
    status: "ok",
    detail: `version=${parsed.version} hosts=${hosts.length}`,
  };
}

export function selfCheck() {
  const validHost = {
    instanceId: "inst-1",
    generation: 1,
    pid: 1234,
    sessionId: "sess-1",
    cwd: "/tmp",
    relayConnected: true,
    inputRequired: false,
    busy: false,
    access: "full",
  };

  // 1. Empty hosts => warn (not fail)
  const emptyRes = evaluateCollabList({ version: 1, hosts: [] });
  assert.equal(emptyRes.status, "warn");
  assert.match(emptyRes.detail, /no collab hosts running/);

  // 2. Malformed host row => fail
  const malformedRes = evaluateCollabList({ version: 1, hosts: [{ instanceId: "inst-1" }] });
  assert.equal(malformedRes.status, "fail");
  assert.match(malformedRes.detail, /missing=/);

  // 3. Valid host row => ok
  const validRes = evaluateCollabList({ version: 1, hosts: [validHost] });
  assert.equal(validRes.status, "ok");

  // 4. Non-version 1 => fail regardless of hosts
  const wrongVerEmpty = evaluateCollabList({ version: 2, hosts: [] });
  assert.equal(wrongVerEmpty.status, "fail");
  const wrongVerValid = evaluateCollabList({ version: 2, hosts: [validHost] });
  assert.equal(wrongVerValid.status, "fail");
}

if (process.argv.includes("--self-check")) {
  selfCheck();
  console.log("self-check passed: empty hosts => warn, malformed row => fail, wrong version => fail");
  process.exit(0);
}
selfCheck();

const collabList = await capture("omp", ["collab", "list", "--json"]);
if (collabList.ok) {
  try {
    const parsed = JSON.parse(collabList.stdout);
    const result = evaluateCollabList(parsed);
    check("collab list --json shape", result.status, result.detail);
  } catch (error) {
    check("collab list --json parses", "fail", String(error.message));
  }
} else {
  check("collab list --json runs", "fail", collabList.stderr.split("\n")[0]);
}

// ── tmux ────────────────────────────────────────────────────────────────────
const tmuxVersion = await capture("tmux", ["-V"]);
check("tmux binary", tmuxVersion.ok ? "ok" : "missing", tmuxVersion.stdout || tmuxVersion.stderr.split("\n")[0]);

if (tmuxVersion.ok) {
  // Display formats we depend on for durable identity.
  const fmt = await capture("tmux", ["list-sessions", "-F", "#{session_id}\t#{session_name}\t#{session_created}"]);
  check(
    "tmux session_id format available",
    fmt.ok || /no server running/i.test(fmt.stderr) ? "ok" : "fail",
    fmt.ok ? `${fmt.stdout.split("\n").length} session(s)` : fmt.stderr.split("\n")[0],
  );
}

// ── Session store ───────────────────────────────────────────────────────────
const sessionsRoot = path.join(homedir(), ".omp", "agent", "sessions");
try {
  await access(sessionsRoot);
  check("session store present", "ok", sessionsRoot);
} catch {
  check("session store present", "warn", `${sessionsRoot} (no sessions yet)`);
}

const ownersDir = path.join(homedir(), ".omp", "run", "session-owners");
try {
  await access(path.join(homedir(), ".omp", "run"));
  check("run dir present", "ok", path.join(homedir(), ".omp", "run"));
} catch {
  check("run dir present", "warn", "owner leases are created lazily on first lock; absence is normal");
}
void ownersDir;

// Linux abstract-socket leases are how we detect a live writer.
if (process.platform === "linux") {
  try {
    const unix = await readFile("/proc/net/unix", "utf8");
    const locks = unix.split("\n").filter((line) => line.includes("@omp-file-lock-")).length;
    check("writer-lease visibility", "ok", `/proc/net/unix exposes ${locks} omp lock socket(s)`);
  } catch (error) {
    check("writer-lease visibility", "fail", `cannot read /proc/net/unix: ${error.message}`);
  }
} else {
  check("writer-lease visibility", "warn", `platform ${process.platform}: abstract sockets unavailable`);
}

// ── Collab config surface ───────────────────────────────────────────────────
const configList = await capture("omp", ["config", "list"]);
for (const key of ["collab.relayUrl", "collab.autoStart", "collab.webUrl"]) {
  check(`config key ${key}`, configList.stdout.includes(key) ? "ok" : "fail", key);
}

// ── Runtime environment ─────────────────────────────────────────────────────
check("node version", sanitizeNode(process.versions.node), process.versions.node);
check("temp dir writable basis", "ok", tmpdir());

function sanitizeNode(version) {
  const major = Number(version.split(".")[0]);
  return major >= 20 ? "ok" : "fail";
}

// ── Report ──────────────────────────────────────────────────────────────────
const summary = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  ompVersion: parsedVersion,
  checks,
  failures: checks.filter((c) => c.status === "fail"),
  warnings: checks.filter((c) => c.status === "warn"),
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`omp compatibility probe — omp ${parsedVersion ?? "unknown"}`);
  console.log(`platform: ${summary.platform}\n`);
  for (const c of checks) {
    const mark = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
    console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  console.log(`\n${checks.length - summary.failures.length - summary.warnings.length} ok, ${summary.warnings.length} warn, ${summary.failures.length} fail`);
}

// Non-zero only for hard failures: a warning is information, not a broken build.
process.exit(summary.failures.length > 0 ? 1 : 0);
