#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const result = spawnSync("npx", ["playwright", "test", "tests/e2e/screens.spec.ts"], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});

// A launch failure (`npx` missing, ENOENT) leaves `status` null; without this
// guard that silently reports success for a run that never happened.
if (result.error) {
  console.error(`capture-screens: could not launch playwright: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
