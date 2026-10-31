import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { swapStageToDist } from "../../scripts/build-guest-utils.mjs";

it("restores previous dist when stage rename fails", async () => {
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
