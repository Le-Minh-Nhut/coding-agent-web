import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repoRoot, "scripts/build-guest.mjs");

function runBuild(dist: string, publicDir: string) {
  return spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, CAW_GUEST_DIST_DIR: dist, CAW_GUEST_PUBLIC_DIR: publicDir },
    shell: false,
  });
}

it("allows a missing public directory and builds into isolated destination", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-guest-"));
  try {
    const dist = join(temp, "dist");
    const result = runBuild(dist, join(temp, "missing-public"));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dist, "index.html"), "utf8")).not.toContain("./src/main.tsx");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("fails on non-ENOENT public copy errors without replacing existing dist", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-guest-"));
  try {
    const dist = join(temp, "dist");
    mkdirSync(dist);
    writeFileSync(join(dist, "previous.txt"), "previous build");
    const result = runBuild(dist, "/proc/1/mem");
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(dist, "previous.txt"), "utf8")).toBe("previous build");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("preserves last good backup across two independent build invocations after rollback failure (R30-01)", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-cross-inv-"));
  try {
    const dist = join(temp, "dist");
    const deadOld = `${dist}.old-2147483647`;
    mkdirSync(deadOld, { recursive: true });
    writeFileSync(join(deadOld, "golden.txt"), "GOLDEN_BACKUP");

    // Invocation 2: Build B runs when dist has no valid build and fails before publishing
    const result = runBuild(dist, "/proc/1/mem");
    expect(result.status).not.toBe(0);
    expect(existsSync(deadOld)).toBe(true);
    expect(readFileSync(join(deadOld, "golden.txt"), "utf8")).toBe("GOLDEN_BACKUP");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});


it("failing build never sweeps backups even when dist looks built", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-fail-sweep-"));
  try {
    const dist = join(temp, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), '<html><script type="module" src="./assets/app.js"></script>');
    writeFileSync(join(dist, "assets", "unrelated.js"), "unrelated");
    const deadOld = `${dist}.old-2147483647`;
    mkdirSync(join(deadOld, "assets"), { recursive: true });
    writeFileSync(join(deadOld, "index.html"), "recovery index");
    writeFileSync(join(deadOld, "assets", "app.js"), "recovery bundle");

    const result = runBuild(dist, "/proc/1/mem");
    expect(result.status).not.toBe(0);
    expect(existsSync(deadOld)).toBe(true);
    expect(readFileSync(join(deadOld, "assets", "app.js"), "utf8")).toBe("recovery bundle");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("successful publish prunes dead-PID backups immediately", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-cross-succ-"));
  try {
    const dist = join(temp, "dist");
    const deadOld = `${dist}.old-4194303`;
    mkdirSync(deadOld, { recursive: true });
    writeFileSync(join(deadOld, "golden.txt"), "GOLDEN_BACKUP");

    const result = runBuild(dist, join(temp, "missing-public"));
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(existsSync(deadOld)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("builds successfully when dist parent directory does not exist (R30-02)", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-noparent-"));
  try {
    const dist = join(temp, "nested-missing", "dist");
    const result = runBuild(dist, join(temp, "missing-public"));
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dist, "index.html"))).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("cleans stale staging directory preventing asset leakage (R30-05)", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-stale-stage-"));
  try {
    const dist = join(temp, "dist");
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       import path from "node:path";
       import { pathToFileURL } from "node:url";
       const dist = process.env.CAW_GUEST_DIST_DIR;
       const stage = dist + ".tmp-" + process.pid;
       fs.mkdirSync(path.join(stage, "assets"), { recursive: true });
       fs.writeFileSync(path.join(stage, "assets", "stale-leak.txt"), "STALE_DATA");
       // Exception: child process harness simulating pre-existing stageDir
       await import(pathToFileURL(process.argv[1]).href);
      `,
      script,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CAW_GUEST_DIST_DIR: dist, CAW_GUEST_PUBLIC_DIR: join(temp, "missing-public") },
      shell: false,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dist, "assets", "stale-leak.txt"))).toBe(false);
    expect(existsSync(join(dist, "index.html"))).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("cleans staging directory safely when staging path is a symlink (R30-05)", () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-symlink-stage-"));
  try {
    const dist = join(temp, "dist");
    const outsideDir = join(temp, "outside-decoy");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.txt"), "DO_NOT_CORRUPT");

    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       import path from "node:path";
       import { pathToFileURL } from "node:url";
       const dist = process.env.CAW_GUEST_DIST_DIR;
       const stage = dist + ".tmp-" + process.pid;
       fs.symlinkSync(process.argv[2], stage, "dir");
       // Exception: child process harness simulating pre-existing symlinked stageDir
       await import(pathToFileURL(process.argv[1]).href);
      `,
      script,
      outsideDir,
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, CAW_GUEST_DIST_DIR: dist, CAW_GUEST_PUBLIC_DIR: join(temp, "missing-public") },
      shell: false,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(outsideDir, "secret.txt"), "utf8")).toBe("DO_NOT_CORRUPT");
    expect(existsSync(join(outsideDir, "index.html"))).toBe(false);
    expect(existsSync(join(dist, "index.html"))).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
