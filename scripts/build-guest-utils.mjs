import * as fs from "node:fs/promises";

import * as path from "node:path";


// Linux's default pid_max is 4194304; timestamp-named backups are intentionally not PID-swept.
const MAX_PLAUSIBLE_PID = 4_194_304;

// ponytail: timestamps are modern backup names; swap removes them on success, failures preserve them. Sweep only legacy PID names; timestamps accumulate for manual recovery.
export async function sweepStaleBackups(distDir, rm = fs.rm) {
  const prefix = `${path.basename(distDir)}.old-`;
  const parent = path.dirname(distDir);
  let entries;
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    const { name } = entry;
    if (!entry.isDirectory() || !name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) continue;
    const pid = Number(name.slice(prefix.length));
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > MAX_PLAUSIBLE_PID || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (err) {
      if (err?.code !== "ESRCH") continue;
    }
    try {
      await rm(path.join(parent, name), { recursive: true, force: true });
    } catch (err) {
      console.error(`[build-guest] could not remove stale backup ${name}:`, err);
    }
  }
}

export async function cleanupFailedBuild(stageDir, distDir, oldDir) {
  await fs.rm(stageDir, { recursive: true, force: true });
  const oldExists = await fs.stat(oldDir).then(() => true, () => false);
  // On failure, any oldDir present is the only known-good backup from dist; never delete it.
  // ponytail: preserve oldDir on failure unconditionally; disk accumulation capped by .gitignore and manual recovery.
  if (oldExists) {
    console.error(`[build-guest] build failed: preserved backup at ${oldDir}`);
  }
}

export async function swapStageToDist(stageDir, distDir, oldDir, rename = fs.rename) {
  let oldDirExists = false;
  try {
    await rename(distDir, oldDir);
    oldDirExists = true;
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  try {
    await rename(stageDir, distDir);
  } catch (err) {
    if (oldDirExists) {
      try {
        await rename(oldDir, distDir);
      } catch (rollbackErr) {
        console.error(`[build-guest] rollback failed to restore ${distDir}:`, rollbackErr);
      }
    }
    throw err;
  }
}

// Injection seam keeps post-publish cleanup failures deterministic in tests.
export async function finishPublishedBuild(oldDir, distDir, rm = fs.rm) {
  try {
    await rm(oldDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[build-guest] warning: could not remove backup ${oldDir}:`, err);
  }
  try {
    await sweepStaleBackups(distDir, rm);
  } catch (err) {
    console.error(`[build-guest] warning: could not sweep stale backups for ${distDir}:`, err);
  }
}
