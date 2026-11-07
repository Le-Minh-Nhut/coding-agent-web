/**
 * Hermetic port and process isolation for the E2E test harness.
 *
 * Prevents multiple test harness runs from clobbering each other's ports,
 * metadata stores, or fixture manifest files.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Check if a PID is alive without sending a terminating signal.
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && typeof err === "object" && "code" in err && err.code === "EPERM";
  }
}

/**
 * Atomically acquire an exclusive lock file. If the existing lock holder PID is dead,
 * reclaims the lock safely.
 */
export function tryAcquireLock(lockPath, payload) {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, JSON.stringify(payload), "utf8");
    closeSync(fd);
    return { acquired: true, lockPath, payload };
  } catch (err) {
    if (!err || typeof err !== "object" || err.code !== "EEXIST") throw err;

    try {
      const raw = readFileSync(lockPath, "utf8");
      const existing = JSON.parse(raw);
      if (typeof existing?.pid === "number" && !isPidAlive(existing.pid)) {
        // Stale lock holder is dead; reclaim slot
        try {
          unlinkSync(lockPath);
        } catch {
          /* raced another unlinker */
        }
        try {
          const fd = openSync(lockPath, "wx");
          writeFileSync(fd, JSON.stringify(payload), "utf8");
          closeSync(fd);
          return { acquired: true, lockPath, payload, reclaimedFrom: existing.pid };
        } catch {
          return { acquired: false, lockPath, holder: existing };
        }
      }
      return { acquired: false, lockPath, holder: existing };
    } catch {
      return { acquired: false, lockPath };
    }
  }
}

/**
 * Release a previously acquired lock file if owned by the current pid.
 */
export function releaseLock(lockPath, pid = process.pid) {
  try {
    if (existsSync(lockPath)) {
      const existing = JSON.parse(readFileSync(lockPath, "utf8"));
      if (existing.pid === pid) {
        unlinkSync(lockPath);
      }
    }
  } catch {
    /* lock already removed or unreadable */
  }
}

/**
 * Deterministically allocate a free harness port slot (0..maxSlots-1).
 * Slot s binds port (basePort + s * 10) and relay (port - 1).
 */
export function acquireSlotLock(basePort = 4399, maxSlots = 10) {
  const temp = tmpdir();
  for (let slot = 0; slot < maxSlots; slot++) {
    const port = basePort + slot * 10;
    const relayPort = port - 1;
    const lockPath = join(temp, `caw-e2e-slot-${slot}.lock`);
    const payload = {
      slot,
      port,
      relayPort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    const res = tryAcquireLock(lockPath, payload);
    if (res.acquired) {
      return {
        slot,
        port,
        relayPort,
        lockPath,
        fixtureFile: join(temp, `caw-e2e-fixture-${port}.json`),
      };
    }
  }
  return null;
}

/**
 * Acquire exclusive lock for an explicitly requested port (e.g. CAW_E2E_PORT=4399).
 */
export function acquirePortLock(port) {
  const numPort = Number(port);
  const temp = tmpdir();
  const lockPath = join(temp, `caw-e2e-port-${numPort}.lock`);
  const payload = {
    port: numPort,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const res = tryAcquireLock(lockPath, payload);
  if (res.acquired) {
    return {
      acquired: true,
      port: numPort,
      lockPath,
      fixtureFile: join(temp, `caw-e2e-fixture-${numPort}.json`),
    };
  }
  return {
    acquired: false,
    holder: res.holder,
    lockPath,
  };
}
