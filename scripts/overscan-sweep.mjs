#!/usr/bin/env node
/**
 * Choose the overscan by measurement, not by taste.
 *
 * Each configuration is a real production bundle: the constant is patched, the web
 * app is rebuilt, and `SCROLL-02` is driven at 4× CPU throttle on the requested
 * engines. No benchmark knob is added to the shipped code, so the number the sweep
 * measures is the number the app actually runs.
 *
 * Usage: node scripts/overscan-sweep.mjs <chromium|webkit> [overscan...]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "apps/web/src/transcript-window.ts");
const original = readFileSync(source, "utf8");
const project = process.argv[2] ?? "chromium";
const configs = process.argv.slice(3).map(Number);
const overscans = configs.length > 0 ? configs : [400, 800, 1600];

const run = (command, args, env = {}) => {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: process.env.HOME, TMPDIR: `${process.env.HOME}/.cache`, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 1_200_000,
    });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
};

const results = [];
try {
  for (const overscan of overscans) {
    writeFileSync(source, original.replace(
      /export const DEFAULT_OVERSCAN_PX = \d+;/,
      `export const DEFAULT_OVERSCAN_PX = ${String(overscan)};`,
    ));
    const build = run("pnpm", ["--filter", "@caw/web", "build"]);
    if (!build.includes("built in")) {
      console.error(`build failed for overscan ${String(overscan)}:\n${build.slice(-800)}`);
      continue;
    }
    run("pkill", ["-f", "e2e-server.mjs"]);
    const output = run("npx", [
      "playwright", "test", "tests/e2e/perf-scroll.spec.ts",
      "--project", project, "-g", "SCROLL-02", "--reporter=line", "--retries=0",
    ], project === "webkit" ? { PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1" } : {});
    const line = output.split("\n").find((entry) => entry.startsWith("PERF_JSON"));
    const passed = /\d+ passed/.test(output);
    if (line === undefined) {
      console.error(`no PERF_JSON for overscan ${String(overscan)} on ${project}; tail:\n${output.slice(-900)}`);
      results.push({ overscan, project, error: true, passed });
      continue;
    }
    const parsed = JSON.parse(line.slice("PERF_JSON ".length));
    results.push({ overscan, project, passed, ...parsed });
  }
} finally {
  writeFileSync(source, original);
  run("pnpm", ["--filter", "@caw/web", "build"]);
  console.log("restored source and rebuilt");
}

for (const result of results) {
  console.log(JSON.stringify(result));
}
