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

it("isolates two concurrent harness invocations to separate ports and manifests", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-harness-isolation-"));
  const web = join(temp, "web");
  const stubServer = join(temp, "stub-server.mjs");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<title>test</title>");
  writeFileSync(stubServer, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  chmodSync(stubServer, 0o755);

  const envBase = {
    ...process.env,
    CAW_WEB_DIST_DIR: web,
    CAW_E2E_TSX: stubServer,
  };
  // Remove explicit ports so slot allocation is used
  delete envBase.CAW_E2E_PORT;
  delete envBase.CAW_E2E_RELAY_PORT;
  delete envBase.CAW_E2E_FIXTURE;

  const launcher1 = spawn(process.execPath, [join(repoRoot, "scripts/e2e-server.mjs")], {
    cwd: repoRoot,
    env: envBase,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let launcher2 = null;
  try {
    // Wait for launcher1 to output listening line
    const out1 = await new Promise((resolve) => {
      launcher1.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("[e2e-server] listening")) resolve(text);
      });
    });
    expect(out1).toContain("[e2e-server] listening on http://127.0.0.1:");
    const port1Match = out1.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    expect(port1Match).not.toBeNull();
    const port1 = Number(port1Match[1]);

    // Now launch launcher2 concurrently
    launcher2 = spawn(process.execPath, [join(repoRoot, "scripts/e2e-server.mjs")], {
      cwd: repoRoot,
      env: envBase,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out2 = await new Promise((resolve) => {
      launcher2.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("[e2e-server] listening")) resolve(text);
      });
    });
    expect(out2).toContain("[e2e-server] listening on http://127.0.0.1:");
    const port2Match = out2.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    expect(port2Match).not.toBeNull();
    const port2 = Number(port2Match[1]);

    // Ports and manifests must be completely distinct
    expect(port1).not.toBe(port2);
    expect(launcher1.exitCode).toBeNull();
    expect(launcher2.exitCode).toBeNull();
  } finally {
    if (launcher1.exitCode === null) {
      launcher1.kill("SIGTERM");
      await once(launcher1, "exit").catch(() => {});
    }
    if (launcher2 && launcher2.exitCode === null) {
      launcher2.kill("SIGTERM");
      await once(launcher2, "exit").catch(() => {});
    }
    rmSync(temp, { recursive: true, force: true });
  }
});

it("rejects second invocation on the same port with clear diagnostic without destroying the first", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-harness-collision-"));
  const web = join(temp, "web");
  const stubServer = join(temp, "stub-server.mjs");
  const testPort = "4799";
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<title>test</title>");
  writeFileSync(stubServer, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  chmodSync(stubServer, 0o755);

  const envBase = {
    ...process.env,
    CAW_WEB_DIST_DIR: web,
    CAW_E2E_TSX: stubServer,
    CAW_E2E_PORT: testPort,
  };
  delete envBase.CAW_E2E_FIXTURE;

  const launcher1 = spawn(process.execPath, [join(repoRoot, "scripts/e2e-server.mjs")], {
    cwd: repoRoot,
    env: envBase,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr2 = "";
  try {
    // Wait for launcher1 to start
    await new Promise((resolve) => {
      launcher1.stdout.on("data", (chunk) => {
        if (chunk.toString("utf8").includes("[e2e-server] listening")) resolve(true);
      });
    });

    const expectedManifest = join(tmpdir(), "caw-e2e-fixture.json");
    expect(existsSync(expectedManifest)).toBe(true);

    // Spawn launcher2 on the exact same port
    const launcher2 = spawn(process.execPath, [join(repoRoot, "scripts/e2e-server.mjs")], {
      cwd: repoRoot,
      env: envBase,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    launcher2.stderr.on("data", (chunk) => {
      stderr2 += chunk.toString("utf8");
    });

    const [code2] = await once(launcher2, "exit");
    // Launcher 2 must be rejected with error code
    expect(code2).toBe(1);
    expect(stderr2).toContain(`port ${testPort} is locked by pid ${launcher1.pid}`);

    // Crucial: Launcher 1 must still be alive and its manifest intact
    expect(launcher1.exitCode).toBeNull();
    expect(existsSync(expectedManifest)).toBe(true);
  } finally {
    if (launcher1.exitCode === null) {
      launcher1.kill("SIGTERM");
      await once(launcher1, "exit").catch(() => {});
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
