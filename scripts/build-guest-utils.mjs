import * as fs from "node:fs/promises";

import * as path from "node:path";

// ponytail: dead-PID sweep is sufficient; PID reuse only keeps stale backup alive, never deletes live one.
export async function sweepStaleBackups(distDir) {
  const prefix = `${path.basename(distDir)}.old-`;
  const parent = path.dirname(distDir);
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const { name } = entry;
    if (!entry.isDirectory() || !name.startsWith(prefix) || !/^\d+$/.test(name.slice(prefix.length))) continue;
    const pid = Number(name.slice(prefix.length));
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue;
    } catch (err) {
      if (err?.code !== "ESRCH") continue;
    }
    try {
      await fs.rm(path.join(parent, name), { recursive: true, force: true });
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

export async function swapStageToDist(stageDir, distDir, oldDir) {
  let oldDirExists = false;
  try {
    await fs.rename(distDir, oldDir);
    oldDirExists = true;
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  try {
    await fs.rename(stageDir, distDir);
  } catch (err) {
    if (oldDirExists) {
      try {
        await fs.rename(oldDir, distDir);
      } catch (rollbackErr) {
        console.error(`[build-guest] rollback failed to restore ${distDir}:`, rollbackErr);
      }
    }
    throw err;
  }
  if (oldDirExists) await fs.rm(oldDir, { recursive: true, force: true });
}
