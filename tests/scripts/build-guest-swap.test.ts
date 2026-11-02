import { finishPublishedBuild, swapStageToDist } from "../../scripts/build-guest-utils.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { cleanupFailedBuild, swapStageToDist, sweepStaleBackups } from "../../scripts/build-guest-utils.mjs";

const buildScript = fileURLToPath(new URL("../../scripts/build-guest.mjs", import.meta.url));
it("restores previous dist when stage rename fails (Matrix 2)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-swap-"));
  const dist = join(temp, "dist");
  const stage = join(temp, "missing-stage");
  const old = join(temp, "old");
  try {
    mkdirSync(dist);
    writeFileSync(join(dist, "previous.txt"), "previous build");
    await expect(swapStageToDist(stage, dist, old)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readFileSync(join(dist, "previous.txt"), "utf8")).toBe("previous build");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("preserves oldDir backup when rollback rename fails (Matrix 3)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-swap-m3-"));
  const dist = join(temp, "dist");
  const stage = join(temp, "missing-stage");
  const old = join(temp, "old");
  try {
    mkdirSync(dist);
    writeFileSync(join(dist, "golden-bundle.txt"), "GOLDEN_BACKUP");

    // Move dist to old (simulating first swap step)
    await fs.rename(dist, old);

    // Recreate dist with a non-empty blocker directory to force rollback rename(old, dist) to fail with ENOTEMPTY
    mkdirSync(dist);
    writeFileSync(join(dist, "blocker.txt"), "BLOCKER");

    // Matrix 3 fault injection:
    // dist was moved to oldDir, but dist is blocked by an unremovable/corrupt directory.
    // When rollback rename(old, dist) fails, swapStageToDist catches it and stage error propagates.
    // If swapStageToDist is invoked where dist is blocked:
    // Step 1: fs.rename(dist, old) -> dist is old
    // Step 2: fs.rename(stage, dist) fails (stage does not exist)
    // Step 3: rollback fs.rename(old, dist) fails because dist exists as blocker
    // Top-level build().catch() calls cleanupFailedBuild(stage, dist, old).
    // NO manual rmSync of dist! Blocker remains in dist.
    await cleanupFailedBuild(stage, dist, old);
    expect(existsSync(old)).toBe(true);
    expect(readFileSync(join(old, "golden-bundle.txt"), "utf8")).toBe("GOLDEN_BACKUP");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
it("propagates publish error and preserves backup when rollback fails", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-rollback-fail-"));
  const dist = join(temp, "dist");
  const stage = join(temp, "stage");
  const old = join(temp, "dist.old-123");
  mkdirSync(dist);
  mkdirSync(stage);
  writeFileSync(join(dist, "index.html"), "OLD");
  writeFileSync(join(stage, "index.html"), "NEW");
  const publishError = Object.assign(new Error("publish failed"), { code: "EIO" });
  const rollbackError = Object.assign(new Error("rollback failed"), { code: "EACCES" });
  let calls = 0;
  const rename = vi.fn(async (from: string, to: string) => {
    calls++;
    if (calls === 1) return fs.rename(from, to);
    if (calls === 2) throw publishError;
    throw rollbackError;
  });
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(swapStageToDist(stage, dist, old, rename)).rejects.toBe(publishError);
    expect(readFileSync(join(old, "index.html"), "utf8")).toBe("OLD");
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("rollback failed to restore"), rollbackError);
  } finally {
    errorLog.mockRestore();
    rmSync(temp, { recursive: true, force: true });
  }
});

it("keeps published dist when injected backup removal fails", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-cleanup-fail-"));
  const dist = join(temp, "dist");
  const stage = join(temp, "stage");
  const old = join(temp, "dist.old-123");
  const publishError = Object.assign(new Error("cleanup failed"), { code: "EACCES" });
  try {
    mkdirSync(dist);
    mkdirSync(stage);
    writeFileSync(join(dist, "index.html"), "OLD");
    writeFileSync(join(stage, "index.html"), "NEW");
    await swapStageToDist(stage, dist, old);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const rm = vi.fn(async () => { throw publishError; });
    try {
      await expect(finishPublishedBuild(old, dist, rm)).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(`warning: could not remove backup ${old}`), publishError);
      expect(readFileSync(join(dist, "index.html"), "utf8")).toBe("NEW");
    } finally {
      errorLog.mockRestore();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("keeps the first failed attempt's timestamp backup through a second failed build", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-two-failures-"));
  const dist = join(temp, "dist");
  const stage = join(temp, "stage");
  const backup = `${dist}.old-${Date.now()}`;
  mkdirSync(dist);
  mkdirSync(stage);
  writeFileSync(join(dist, "index.html"), "LAST_GOOD");
  writeFileSync(join(stage, "index.html"), "NEW");
  const publishError = Object.assign(new Error("publish failed"), { code: "EIO" });
  let calls = 0;
  const rename = async (from: string, to: string) => {
    calls++;
    if (calls === 1) return fs.rename(from, to);
    if (calls === 2) throw publishError;
    throw new Error("rollback failed");
  };
  try {
    await expect(swapStageToDist(stage, dist, backup, rename)).rejects.toBe(publishError);
    const second = spawnSync(process.execPath, [buildScript], {
      encoding: "utf8",
      env: { ...process.env, CAW_GUEST_DIST_DIR: dist, CAW_GUEST_PUBLIC_DIR: "/proc/1/mem" },
      shell: false,
    });
    expect(second.status).not.toBe(0);
    expect(readFileSync(join(backup, "index.html"), "utf8")).toBe("LAST_GOOD");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("sweeps dead-PID backup directories when dist is valid", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-sweep-"));
  const dist = join(temp, "dist");
  const dead = `${dist}.old-4194303`;
  const current = `${dist}.old-${process.pid}`;
  const live = `${dist}.old-1`;
  const malformed = `${dist}.old-not-a-pid`;
  try {
    mkdirSync(dist);
    writeFileSync(join(dist, "index.html"), "valid dist");
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "app.js"), "valid bundle");
    mkdirSync(dead);
    mkdirSync(current);
    mkdirSync(live);
    mkdirSync(malformed);
    await sweepStaleBackups(dist);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("preserves timestamp-named backups outside plausible PID range", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-timestamp-backup-"));
  const dist = join(temp, "dist");
  const timestampBackup = `${dist}.old-1750000000000`;
  try {
    mkdirSync(timestampBackup);
    writeFileSync(join(timestampBackup, "sentinel.txt"), "KEEP");
    await sweepStaleBackups(dist);
    expect(existsSync(timestampBackup)).toBe(true);
    expect(readFileSync(join(timestampBackup, "sentinel.txt"), "utf8")).toBe("KEEP");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});


it("ignores missing parent directory without throwing (R30-02)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-noparent-"));
  const dist = join(temp, "nonexistent-parent", "dist");
  try {
    await expect(sweepStaleBackups(dist)).resolves.toBeUndefined();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Root bypasses POSIX permission bits, so skip EACCES induction under root.
it.skipIf(process.getuid?.() === 0)("rethrows real fs errors like EACCES from sweepStaleBackups (R30-02)", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-eacces-"));
  const restrictedParent = join(temp, "restricted");
  const dist = join(restrictedParent, "dist");
  try {
    mkdirSync(restrictedParent);
    chmodSync(restrictedParent, 0);
    await expect(sweepStaleBackups(dist)).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    chmodSync(restrictedParent, 0o755);
    rmSync(temp, { recursive: true, force: true });
  }
});
