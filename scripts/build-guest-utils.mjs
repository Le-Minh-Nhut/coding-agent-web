import * as fs from "node:fs/promises";

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
    if (oldDirExists) await fs.rename(oldDir, distDir);
    throw err;
  }
  if (oldDirExists) await fs.rm(oldDir, { recursive: true, force: true });
}
