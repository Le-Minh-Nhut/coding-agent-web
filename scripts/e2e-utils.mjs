import { readFileSync, readdirSync } from "node:fs";

export function matchesServerWriterEnviron(environ, stateDir) {
  return environ.split("\0").includes(`CAW_STATE_DIR=${stateDir}`);
}

export function reapServerWriters(stateDir, excludedPid, signal = "SIGKILL") {
  if (process.platform !== "linux") return;
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (pid === process.pid || pid === excludedPid) continue;
      try {
        if (matchesServerWriterEnviron(readFileSync(`/proc/${pid}/environ`, "utf8"), stateDir)) {
          process.kill(pid, signal);
        }
      } catch {
        /* process already exited or permission denied */
      }
    }
  } catch {
    /* /proc unreadable */
  }
}
