#!/usr/bin/env node
/**
 * Versioned, atomic releases for the web client.
 *
 * The product UI used to be built straight into the directory the server
 * served, so an ordinary `pnpm --filter @caw/web build` replaced the assets an
 * already-connected phone was being served — three separate times. Disciplined
 * `--outDir /tmp/...` was the only defence, and discipline is not a guarantee.
 *
 * Layout under the deploy root (`apps/web/.deploy` unless CAW_WEB_RELEASE_ROOT
 * says otherwise):
 *
 *   releases/<id>/     immutable; index.html + assets/ + manifest.json
 *   current   -> rel path to the release being served
 *   previous  -> rel path to the release it replaced (rollback + old-tab assets)
 *   staging/           in-progress build output; safe to delete
 *
 * Two operations are load-bearing:
 *   - a release directory only ever appears under releases/ by `rename(2)` of a
 *     complete, manifest-verified staging directory in the same filesystem;
 *   - `current` is only ever replaced by `rename(2)` of a symlink that was read
 *     back and compared first. rename(2) is atomic within one filesystem, so a
 *     reader sees the old target or the new one, never a missing or half-written
 *     pointer. Observed here on ext4 (the repo) and tmpfs (`/tmp`), where a
 *     symlink rename is a single atomic directory-entry replacement; the same
 *     holds for overlayfs.
 *
 * Nothing here signals, restarts or touches the running server: it resolves
 * `current` per request, so a publish takes effect on the next request, and no
 * release directory is ever deleted while a pointer names it.
 *
 * Commands: build | publish | rollback | status | prune --keep N
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const webDir = path.join(repoRoot, "apps", "web");
const MANIFEST = "manifest.json";

export function defaultReleaseRoot() {
  return process.env.CAW_WEB_RELEASE_ROOT
    ? path.resolve(process.env.CAW_WEB_RELEASE_ROOT)
    : path.join(webDir, ".deploy");
}

function info(message) {
  process.stdout.write(`[deploy-web] ${message}\n`);
}

export function layout(releaseRoot) {
  return {
    root: releaseRoot,
    releases: path.join(releaseRoot, "releases"),
    staging: path.join(releaseRoot, "staging"),
    current: path.join(releaseRoot, "current"),
    previous: path.join(releaseRoot, "previous"),
  };
}

function ensureLayout(releaseRoot) {
  const dirs = layout(releaseRoot);
  mkdirSync(dirs.releases, { recursive: true });
  mkdirSync(dirs.staging, { recursive: true });
  return dirs;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function walk(dir, base = dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, found);
    else if (entry.isFile()) found.push(path.relative(base, full).split(path.sep).join("/"));
    else throw new Error(`unexpected non-regular file in build output: ${full}`);
  }
  return found;
}

/** git facts, best-effort: a release built outside a checkout still gets an id. */
function gitFacts() {
  const run = (args) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", shell: false });
  const head = run(["rev-parse", "--short=12", "HEAD"]);
  const status = run(["status", "--porcelain", "--untracked-files=no"]);
  return {
    commit: head.status === 0 ? head.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

export function releaseId() {
  const { commit, dirty } = gitFacts();
  const base = commit ?? `nogit-${Date.now().toString(36)}`;
  return dirty ? `${base}-dirty` : base;
}

/** Resolve the vite CLI without relying on shell shims (array argv, shell: false). */
function viteEntry() {
  const require = createRequire(path.join(webDir, "package.json"));
  const pkgPath = require.resolve("vite/package.json");
  const bin = require(pkgPath).bin;
  const relative = typeof bin === "string" ? bin : bin?.vite;
  if (!relative) throw new Error(`cannot find the vite CLI in ${path.dirname(pkgPath)}`);
  return path.join(path.dirname(pkgPath), relative);
}

function readManifest(releaseDir) {
  const manifestPath = path.join(releaseDir, MANIFEST);
  let text;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (error) {
    return { ok: false, manifest: null, reason: `cannot read ${manifestPath}: ${error.code ?? error.message}` };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return { ok: false, manifest: null, reason: `${manifestPath} is not valid JSON` };
  }
  if (!Array.isArray(manifest.files) || typeof manifest.release !== "string") {
    return { ok: false, manifest: null, reason: `${manifestPath} is not a release manifest` };
  }
  return { ok: true, manifest, reason: null };
}

/**
 * Prove a release directory is exactly what its manifest says: every listed
 * file present with the recorded size and sha256, no unlisted file, and every
 * asset `index.html` references present. A release that fails this is never
 * publishable — the whole point is that a broken build cannot reach a phone.
 */
export function verifyRelease(releaseDir) {
  const read = readManifest(releaseDir);
  if (!read.ok) return { ok: false, reason: read.reason, manifest: null };
  const manifest = read.manifest;
  const onDisk = new Set(walk(releaseDir));
  onDisk.delete(MANIFEST);
  const listed = new Set();
  for (const file of manifest.files) {
    if (typeof file?.path !== "string" || typeof file?.sha256 !== "string" || typeof file?.size !== "number") {
      return { ok: false, reason: "manifest entry is malformed", manifest };
    }
    listed.add(file.path);
    const full = path.join(releaseDir, ...file.path.split("/"));
    let stats;
    try {
      stats = statSync(full);
    } catch {
      return { ok: false, reason: `missing file listed in manifest: ${file.path}`, manifest };
    }
    if (stats.size !== file.size) {
      return { ok: false, reason: `size mismatch for ${file.path}: manifest ${file.size}, disk ${stats.size}`, manifest };
    }
    const actual = sha256(full);
    if (actual !== file.sha256) {
      return { ok: false, reason: `sha256 mismatch for ${file.path}: manifest ${file.sha256}, disk ${actual}`, manifest };
    }
  }
  for (const extra of onDisk) {
    if (!listed.has(extra)) return { ok: false, reason: `file not listed in manifest: ${extra}`, manifest };
  }
  let index;
  try {
    index = readFileSync(path.join(releaseDir, "index.html"), "utf8");
  } catch {
    return { ok: false, reason: "release has no index.html", manifest };
  }
  // Every local asset the HTML asks for must exist in this very release: an
  // index that references a file the release lacks is exactly the mixed-bundle
  // state a phone must never be served.
  for (const match of index.matchAll(/\b(?:src|href)=["'](\/[^"'?#]+)["']/gu)) {
    const reference = match[1].slice(1);
    if (!listed.has(reference)) {
      return { ok: false, reason: `index.html references ${reference} but the release does not contain it`, manifest };
    }
  }
  return { ok: true, reason: null, manifest };
}

/** Default build step: run vite into `outDir`. Array argv, shell: false. */
export function runVite(outDir) {
  const result = spawnSync(
    process.execPath,
    // `--emptyOutDir` is explicit so vite cannot decide to reuse a directory it
    // did not create, and the outDir is always a fresh staging directory.
    [viteEntry(), "build", "--outDir", outDir, "--emptyOutDir"],
    { cwd: webDir, stdio: "inherit", shell: false, env: process.env },
  );
  return { status: result.status, signal: result.signal };
}

/**
 * Build one release.
 *
 * `runner(outDir)` performs the build and returns `{ status }`. It is a seam so
 * the failure modes (non-zero exit, a runner killed mid-write) have tests
 * without a real 1.5-second bundle build each time.
 */
export function buildRelease(options) {
  const { releaseRoot } = options;
  const id = options.id ?? releaseId();
  const runner = options.runner ?? runVite;
  const dirs = ensureLayout(releaseRoot);
  // Build beside the release, never into it: `rename` is what makes the release
  // appear, so a half-written or failing build is never visible as a release.
  const stagingDir = path.join(dirs.staging, `${id}.tmp-${process.pid}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  info(`building ${id} into ${stagingDir}`);
  const result = runner(stagingDir);
  if (result.status !== 0) {
    // Left in staging on purpose: a failed build's output is evidence, and
    // pruning is explicitly safe. It can never be reached through `current`.
    throw new Error(`build exited ${result.status ?? "on a signal"}; staging kept at ${stagingDir}`);
  }

  const { commit, dirty } = gitFacts();
  const files = walk(stagingDir).sort().map((file) => {
    const full = path.join(stagingDir, ...file.split("/"));
    return { path: file, size: statSync(full).size, sha256: sha256(full) };
  });
  const manifest = {
    release: id,
    commit,
    dirty,
    builtAt: new Date().toISOString(),
    builtFrom: webDir,
    files,
  };
  writeFileSync(path.join(stagingDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  const verified = verifyRelease(stagingDir);
  if (!verified.ok) throw new Error(`built release failed verification: ${verified.reason}`);

  const finalDir = path.join(dirs.releases, id);
  if (statOrNull(finalDir)) {
    // Releases are immutable, and a developer rebuilding the same commit must not
    // be pushed into `rm -rf` on a release directory. Identical output is the
    // same release; anything else is a real conflict and a loud failure.
    const prior = verifyRelease(finalDir);
    const sameFiles = prior.ok && JSON.stringify(prior.manifest.files) === JSON.stringify(manifest.files);
    rmSync(stagingDir, { recursive: true, force: true });
    if (sameFiles) {
      info(`release ${id} already built with identical contents at ${finalDir}`);
      if (readPointer(dirs.current) !== path.join("releases", id)) {
        info(`publish it with: node scripts/deploy-web.mjs publish ${id}`);
      }
      return id;
    }
    throw new Error(
      `release ${id} already exists at ${finalDir} with different contents${prior.ok ? "" : ` (and it does not verify: ${prior.reason})`}; releases are immutable. Remove it deliberately (rm -rf ${finalDir}) or add a commit, then build again.`,
    );
  }
  renameSync(stagingDir, finalDir);
  info(`release ${id} ready (${files.length} files) at ${finalDir}`);
  info(`not served yet — publish it with: node scripts/deploy-web.mjs publish ${id}`);
  return id;
}

function statOrNull(candidate) {
  try {
    return statSync(candidate);
  } catch {
    return null;
  }
}

export function readPointer(linkPath) {
  try {
    return readlinkSync(linkPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Replace `linkPath` with a symlink to `target`, atomically.
 *
 * write `.name.new` → read it back and compare → rename(2) over the pointer.
 * rename(2) of a symlink replaces the directory entry in one step, so a
 * concurrent reader gets the old target or the new one. The read-back is not
 * ceremony: it proves we are about to swap in the target we intended before
 * anything becomes visible.
 */
export function swapPointer(linkPath, target) {
  const staged = `${linkPath}.new`;
  // A publish killed between symlink and rename can leave a file *or* (from an
  // older tool) a directory here. Clear either; this name is ours to manage.
  rmSync(staged, { recursive: true, force: true });
  symlinkSync(target, staged);
  const readBack = readlinkSync(staged);
  if (readBack !== target) {
    rmSync(staged, { force: true });
    throw new Error(`symlink read-back mismatch for ${staged}: wrote ${target}, read ${readBack}`);
  }
  renameSync(staged, linkPath);
}

function releaseRecency(releaseRoot) {
  const dirs = layout(releaseRoot);
  if (!statOrNull(dirs.releases)) return [];
  return readdirSync(dirs.releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(dirs.releases, entry.name);
      const { manifest } = readManifest(dir);
      return { id: entry.name, dir, builtAt: manifest?.builtAt ?? "1970-01-01T00:00:00.000Z" };
    })
    .sort((a, b) => (a.builtAt < b.builtAt ? 1 : a.builtAt > b.builtAt ? -1 : a.id < b.id ? 1 : -1));
}

function resolveCandidate(releaseRoot, requested) {
  const dirs = layout(releaseRoot);
  if (requested) {
    const id = path.basename(requested);
    const dir = path.join(dirs.releases, id);
    if (!statOrNull(dir)) throw new Error(`no such release: ${id}`);
    return { id, dir };
  }
  const currentTarget = readPointer(dirs.current);
  const newest = releaseRecency(releaseRoot).find((release) => currentTarget !== path.join("releases", release.id));
  if (!newest) throw new Error(`no unpublished release under ${dirs.releases}; run "node scripts/deploy-web.mjs build" first`);
  return { id: newest.id, dir: newest.dir };
}

async function healthCheck(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "no attempt";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 400) return { ok: true, reason: null };
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: false, reason: `health check ${url} failed within ${timeoutMs}ms: ${last}` };
}

export async function publishRelease(releaseRoot, requested, options = {}) {
  const dirs = ensureLayout(releaseRoot);
  const candidate = resolveCandidate(releaseRoot, requested);
  const verified = verifyRelease(candidate.dir);
  if (!verified.ok) throw new Error(`refusing to publish ${candidate.id}: ${verified.reason}`);

  const target = path.join("releases", candidate.id);
  const previousTarget = readPointer(dirs.current);
  // Point `previous` at what we are replacing first: an already-open tab that
  // still holds the old HTML keeps fetching that release's hashed assets, and a
  // rollback needs the same pointer. If the swap below fails, `current` is still
  // the old release and `previous` is merely one stale pointer.
  if (previousTarget !== null && previousTarget !== target) swapPointer(dirs.previous, previousTarget);
  swapPointer(dirs.current, target);
  info(`current -> ${target}`);

  if (options.healthUrl) {
    const health = await healthCheck(options.healthUrl, options.healthTimeoutMs ?? 5000);
    if (!health.ok) {
      const rollbackTarget = readPointer(dirs.previous);
      if (rollbackTarget !== null && rollbackTarget !== target) {
        swapPointer(dirs.current, rollbackTarget);
        info(`rolled current back to ${rollbackTarget}`);
      }
      throw new Error(`${health.reason}; release ${candidate.id} is not being served`);
    }
    info(`health check passed: ${options.healthUrl}`);
  }
  return candidate.id;
}

export function rollbackRelease(releaseRoot) {
  const dirs = ensureLayout(releaseRoot);
  const previous = readPointer(dirs.previous);
  if (previous === null) throw new Error(`no previous release to roll back to (${dirs.previous} does not exist)`);
  const previousDir = path.resolve(releaseRoot, previous);
  if (!statOrNull(previousDir)) throw new Error(`previous pointer ${previous} resolves to no directory`);
  const verified = verifyRelease(previousDir);
  if (!verified.ok) throw new Error(`refusing to roll back to ${previous}: ${verified.reason}`);
  const current = readPointer(dirs.current);
  swapPointer(dirs.current, previous);
  // Swap rather than just repoint, so a rollback is itself reversible.
  if (current !== null && current !== previous) swapPointer(dirs.previous, current);
  info(`current -> ${previous} (rolled back)`);
  return path.basename(previous);
}

export function releaseStatus(releaseRoot) {
  const dirs = layout(releaseRoot);
  const current = readPointer(dirs.current);
  const previous = readPointer(dirs.previous);
  const releases = releaseRecency(releaseRoot).map((release) => {
    const verified = verifyRelease(release.dir);
    const pointers = [
      current === path.join("releases", release.id) ? "current" : null,
      previous === path.join("releases", release.id) ? "previous" : null,
    ].filter(Boolean);
    return { ...release, verified: verified.ok, reason: verified.reason, pointers };
  });
  const staging = statOrNull(dirs.staging) ? readdirSync(dirs.staging) : [];
  info(`deploy root: ${releaseRoot}`);
  info(`current: ${current ?? "(none)"}`);
  info(`previous: ${previous ?? "(none)"}`);
  if (releases.length === 0) info("releases: none");
  for (const release of releases) {
    info(`  ${release.id} ${release.verified ? "verified" : `BROKEN (${release.reason})`} ${release.builtAt}${release.pointers.length > 0 ? ` [${release.pointers.join(",")}]` : ""}`);
  }
  info(`staging: ${staging.length === 0 ? "empty" : staging.join(", ")}`);
  return { current, previous, releases, staging };
}

export function pruneReleases(releaseRoot, keep) {
  const dirs = ensureLayout(releaseRoot);
  const referenced = new Set([readPointer(dirs.current), readPointer(dirs.previous)].filter((value) => value !== null));
  const releases = releaseRecency(releaseRoot);
  const kept = new Set();
  // Never the served release, never the rollback target, then the newest `keep`.
  for (const release of releases) {
    const relative = path.join("releases", release.id);
    if (referenced.has(relative) || kept.size < keep) kept.add(release.id);
    else {
      rmSync(release.dir, { recursive: true, force: true });
      info(`pruned ${release.id}`);
    }
  }
  for (const entry of readdirSync(dirs.staging)) {
    rmSync(path.join(dirs.staging, entry), { recursive: true, force: true });
    info(`pruned staging/${entry}`);
  }
  info(`kept ${kept.size} release(s)`);
  return [...kept];
}

function parseCount(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer, got ${value}`);
  return parsed;
}

export function parseOptions(argv) {
  const result = { positionals: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") result.flags.keep = parseCount(argv[++i], "--keep");
    else if (arg === "--health-url") result.flags.healthUrl = argv[++i];
    else if (arg === "--health-timeout-ms") result.flags.healthTimeoutMs = parseCount(argv[++i], "--health-timeout-ms");
    else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else result.positionals.push(arg);
  }
  return result;
}

export async function main(argv, releaseRoot = defaultReleaseRoot()) {
  const [command, ...rest] = argv;
  const parsed = parseOptions(rest);
  switch (command) {
    case "build":
      return buildRelease({ releaseRoot, id: parsed.positionals[0] });
    case "publish":
      return publishRelease(releaseRoot, parsed.positionals[0], {
        healthUrl: parsed.flags.healthUrl,
        healthTimeoutMs: parsed.flags.healthTimeoutMs,
      });
    case "rollback":
      return rollbackRelease(releaseRoot);
    case "status":
      releaseStatus(releaseRoot);
      return;
    case "prune":
      return pruneReleases(releaseRoot, parsed.flags.keep ?? 2);
    default:
      throw new Error(`unknown command ${JSON.stringify(command ?? "")}. Use build | publish | rollback | status | prune --keep N`);
  }
}

// Only run when executed, so tests can import the operations directly.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[deploy-web] FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
