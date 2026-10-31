import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
