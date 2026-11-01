import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupFailedBuild, swapStageToDist, sweepStaleBackups } from "../../scripts/build-guest-utils.mjs";

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
it("sweeps only dead-PID backup directories", async () => {
  const temp = mkdtempSync(join(tmpdir(), "caw-build-sweep-"));
  const dist = join(temp, "dist");
  const dead = `${dist}.old-2147483647`;
  const current = `${dist}.old-${process.pid}`;
  const live = `${dist}.old-1`;
  const malformed = `${dist}.old-not-a-pid`;
  try {
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
