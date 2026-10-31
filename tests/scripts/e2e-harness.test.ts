import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { matchesServerWriterEnviron, reapServerWriters } from "../../scripts/e2e-utils.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

it("matches only an exact NUL-delimited CAW_STATE_DIR entry", () => {
  const stateDir = "/tmp/caw-state";
  expect(matchesServerWriterEnviron(`PATH=/bin\0CAW_STATE_DIR=${stateDir}\0`, stateDir)).toBe(true);
  expect(matchesServerWriterEnviron(`CAW_STATE_DIR=${stateDir}-extra\0`, stateDir)).toBe(false);
  expect(matchesServerWriterEnviron(`NOT_CAW_STATE_DIR=${stateDir}\0`, stateDir)).toBe(false);
  expect(matchesServerWriterEnviron("PATH=/bin\0", stateDir)).toBe(false);
});
it.skipIf(process.platform !== "linux")("kills exact state-dir writer and preserves collisions and unrelated processes", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-reaper-"));
  const stateDir = join(temp, "state");
  const children = [stateDir, `${stateDir}-extra`, undefined, undefined].map((value, index) =>
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: value === undefined
        ? (index === 2 ? { ...process.env, NOT_CAW_STATE_DIR: stateDir } : process.env)
        : { ...process.env, CAW_STATE_DIR: value },
      shell: false,
      stdio: "ignore",
    }),
  );
  try {
    const exactChild = children[0];
    if (!exactChild) throw new Error("exact-match child was not spawned");
    const exited = once(exactChild, "exit");
    reapServerWriters(stateDir, -1);
    await exited;
    expect(exactChild.signalCode).toBe("SIGKILL");
    expect(children.slice(1).every((child) => child.exitCode === null)).toBe(true);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(temp, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== "linux")("ignores an already-exited pid during reaping", () => {
  expect(() => reapServerWriters("/tmp/caw-no-such-state", 999999999)).not.toThrow();
});

it("reports unexpected child signal death as a launcher failure", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-harness-signal-"));
  const web = join(temp, "web");
  const crash = join(temp, "crash.mjs");
  const manifest = join(temp, "fixture.json");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<title>test</title>");
  writeFileSync(crash, `#!${process.execPath}\nprocess.kill(process.pid, "SIGKILL");\n`, { mode: 0o755 });
  chmodSync(crash, 0o755);
  const launcher = spawn(process.execPath, [join(repoRoot, "scripts/e2e-server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAW_WEB_DIST_DIR: web,
      CAW_E2E_TSX: crash,
      CAW_E2E_FIXTURE: manifest,
      CAW_E2E_PORT: "0",
      CAW_RELAY_PORT: "0",
    },
    shell: false,
    stdio: "ignore",
  });
  try {
    const [code] = await once(launcher, "exit");
    expect(code).not.toBe(0);
    expect(launcher.signalCode).toBeNull();
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    rmSync(temp, { recursive: true, force: true });
  }
});
it("cleans manifest and temp state when child spawn fails", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-harness-spawn-error-"));
  const web = join(temp, "web");
  const manifest = join(temp, "fixture.json");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<title>test</title>");
  const launcher = spawn(process.execPath, [join(repoRoot, "scripts/e2e-server.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CAW_WEB_DIST_DIR: web,
      CAW_E2E_TSX: join(temp, "missing-executable"),
      CAW_E2E_FIXTURE: manifest,
    },
    shell: false,
    stdio: "ignore",
  });
  try {
    const [code] = await once(launcher, "exit");
    expect(code).not.toBe(0);
    expect(existsSync(manifest)).toBe(false);
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    rmSync(temp, { recursive: true, force: true });
  }
});
