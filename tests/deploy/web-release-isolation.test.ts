/**
 * The production-isolation contract for the web client.
 *
 * The defect these tests exist for: the server served whatever was in the build
 * directory, and `vite build`'s default outDir *is* that directory. So a normal
 * developer build replaced the assets a connected iPhone was being served, and
 * nothing in the system could tell the difference. Three times.
 *
 * What has to hold, proven by served bytes rather than by inspecting settings:
 *   - a build writes into staging and is invisible until it is published;
 *   - a release appears under `releases/` only complete and manifest-verified;
 *   - `current` is swapped atomically and read per request, so a publish takes
 *     effect on the next request with no restart;
 *   - an already-open tab's hashed assets keep resolving after a publish, but no
 *     HTML request ever silently renders an older release;
 *   - the ordinary `pnpm --filter @caw/web build` cannot touch what is served.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildRelease,
  layout,
  publishRelease,
  pruneReleases,
  readPointer,
  releaseStatus,
  rollbackRelease,
  swapPointer,
  verifyRelease,
} from "../../scripts/deploy-web.mjs";
import { buildApp } from "../../apps/server/src/app.js";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import type { ServerConfig } from "../../apps/server/src/config.js";
import { createMetadataStore } from "../../apps/server/src/store.js";
import { createStaticRootResolver } from "../../apps/server/src/static-roots.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A stand-in build: `index.html` that names exactly one script, that script
 * holding `marker`. Small on purpose — the real bundle is 486 kB and the
 * behaviour under test is the release mechanics, not vite's output.
 */
function fakeVite(marker: string) {
  return (outDir: string): { status: number } => {
    mkdirSync(path.join(outDir, "assets"), { recursive: true });
    writeFileSync(path.join(outDir, "index.html"), indexHtml(marker));
    writeFileSync(path.join(outDir, "assets", `app-${marker}.js`), assetBody(marker));
    return { status: 0 };
  };
}

/** One release's HTML: names exactly one asset, and says which release it is. */
function indexHtml(marker: string): string {
  return `<!doctype html><html><head><title>${marker}</title><script type="module" src="/assets/app-${marker}.js"></script></head><body>${marker}</body></html>`;
}

function assetBody(marker: string): string {
  return `console.log(${JSON.stringify(marker)});\n`;
}

/** A release directory written by hand, with a manifest that verifies. */
function writeRelease(releaseRoot: string, id: string, marker: string): string {
  const dir = path.join(releaseRoot, "releases", id);
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  const files = [
    ["index.html", indexHtml(marker)],
    [`assets/app-${marker}.js`, assetBody(marker)],
  ] as const;
  for (const [name, body] of files) writeFileSync(path.join(dir, ...name.split("/")), body);
  const manifest = {
    release: id,
    commit: null,
    dirty: false,
    builtAt: new Date().toISOString(),
    builtFrom: "test",
    files: files.map(([name, body]) => ({
      path: name,
      size: Buffer.byteLength(body),
      sha256: sha256(body),
    })),
  };
  writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/** Run the real `pnpm --filter @caw/web build` with the deploy root redirected. */
function runWebBuild(releaseRoot: string): Promise<number | null> {
  // Node 20 has no Promise.withResolvers; the explicit pair is the same shape.
  let settle: (code: number | null) => void = () => {};
  const promise = new Promise<number | null>((resolve) => { settle = resolve; });
  const child = execFile("pnpm", ["--filter", "@caw/web", "build"], {
    cwd: repoRoot,
    env: { ...process.env, CAW_WEB_RELEASE_ROOT: releaseRoot },
    shell: false,
  });
  child.on("error", () => settle(null));
  child.on("close", (code) => settle(code));
  return promise;
}

interface Served {
  status: number;
  body: string;
  hash: string;
}

/** The slice of a Fastify instance these tests need; no dependency on its types. */
interface Injectable {
  inject(options: { method: "GET"; url: string }): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
}

async function servedBytes(app: Injectable, url: string): Promise<Served> {
  const response = await app.inject({ method: "GET", url });
  const body = response.body;
  return { status: response.statusCode, body, hash: sha256(body) };
}

async function makeApp(options: { releaseRoot: string; distDir: string }) {
  const dir = scratch("caw-deploy-app-");
  const guestDir = path.join(dir, "guest-dist");
  mkdirSync(guestDir, { recursive: true });
  writeFileSync(path.join(guestDir, "index.html"), "<!doctype html><title>guest</title>");
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 8791,
    stateDir: dir,
    allowedRoots: [dir],
    relayPort: 8792,
    relayAllowedOrigins: [],
    webDistDir: options.distDir,
    webReleaseRoot: options.releaseRoot,
    guestDistDir: guestDir,
    maxActiveAgents: 3,
    authTokenTtlHours: 720,
    handoffEvidenceBudgetMs: 0,
    trustTailscaleOrigin: false,
    logLevel: "silent",
    insecureCookies: false,
  };
  const app = buildApp({
    config,
    auth,
    store: createMetadataStore(dir),
    canonicalProjectPath: async (value: string) => realpathSync(value),
  });
  return { app, config, dir };
}

/** A release root with A published, plus a live server pointed at it. */
async function publishedA() {
  const root = scratch("caw-deploy-");
  const distDir = path.join(root, "dist");
  const releaseRoot = path.join(root, ".deploy");
  const releaseA = writeRelease(releaseRoot, "aaaa111", "A");
  await publishRelease(releaseRoot, "aaaa111");
  const { app } = await makeApp({ releaseRoot, distDir });
  return { root, distDir, releaseRoot, releaseA, app };
}

describe("12-point production isolation (served bytes, no browser)", () => {
  it("keeps the served release byte-identical across build, verify and publish failures", async () => {
    const { releaseRoot, app } = await publishedA();
    const a = await servedBytes(app, "/");
    expect(a.status).toBe(200);
    expect(a.body).toContain("A");
    expect(a.body).not.toContain("B");

    // 1. release A served
    expect(a.hash).toBe(sha256(readFileSync(path.join(releaseRoot, "releases/aaaa111/index.html"))));

    // 2. developer runs the ordinary build (a staging build of a candidate)
    const started = buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    expect(started).toBe("bbbb222");

    // 3. A still served — the candidate exists only under releases/, which
    //    nothing serves until a publish moves `current`.
    expect((await servedBytes(app, "/")).hash).toBe(a.hash);

    // 4. staging build completed and left no staging residue behind
    expect(readdirSync(path.join(releaseRoot, "staging"))).toEqual([]);
    // 5. A still served
    expect((await servedBytes(app, "/assets/app-A.js")).status).toBe(200);
    expect((await servedBytes(app, "/")).hash).toBe(a.hash);

    // 6. a candidate failing verification is never publishable
    const broken = path.join(releaseRoot, "releases", "cccc333");
    mkdirSync(broken, { recursive: true });
    writeFileSync(path.join(broken, "index.html"), "<!doctype html><title>C</title>");
    writeFileSync(
      path.join(broken, "manifest.json"),
      JSON.stringify({ release: "cccc333", files: [{ path: "index.html", size: 1, sha256: sha256("x") }] }),
    );
    await expect(publishRelease(releaseRoot, "cccc333")).rejects.toThrow(/refusing to publish cccc333/);
    // 7. A still served
    expect((await servedBytes(app, "/")).hash).toBe(a.hash);

    // 8. B passes verification
    expect(verifyRelease(path.join(releaseRoot, "releases/bbbb222"))).toMatchObject({ ok: true });

    // 9. publish switches to B
    await publishRelease(releaseRoot, "bbbb222");
    const b = await servedBytes(app, "/");
    expect(b.status).toBe(200);
    expect(b.body).toContain("B");
    expect(b.hash).not.toBe(a.hash);

    // 10. B served consistently across sequential requests, and its own asset
    //     resolves — never a body assembled from two releases.
    for (let i = 0; i < 10; i++) {
      expect((await servedBytes(app, "/")).hash).toBe(b.hash);
      const asset = await servedBytes(app, "/assets/app-B.js");
      expect(asset.status).toBe(200);
      expect(asset.body).toContain("B");
    }

    // 11. rollback returns A, and is itself reversible
    expect(rollbackRelease(releaseRoot)).toBe("aaaa111");
    expect((await servedBytes(app, "/")).hash).toBe(a.hash);
    expect(readlinkSync(path.join(releaseRoot, "previous"))).toBe(path.join("releases", "bbbb222"));

    // 12. no OMP/tmux interaction: the deploy module never launches an agent
    //     manager. Its only child processes are the build and read-only git.
    const source = readFileSync(path.join(repoRoot, "scripts/deploy-web.mjs"), "utf8");
    const spawned = [...source.matchAll(/spawn(?:Sync)?\(\s*(process\.execPath|"[^"]+")/gu)].map((match) => match[1]);
    expect(spawned.sort()).toEqual(["\"git\"", "process.execPath"]);
    expect(source).not.toMatch(/\btmux\b|\bomp\b/);

    await app.close();
  });
});

describe("per-request resolution", () => {
  it("serves the newly published release on the next request, with no restart", async () => {
    const { releaseRoot, app } = await publishedA();
    const before = await servedBytes(app, "/");
    expect(before.body).toContain("A");

    buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    // The running instance was never rebuilt, restarted or reloaded.
    await publishRelease(releaseRoot, "bbbb222");
    const after = await servedBytes(app, "/");
    expect(after.body).toContain("B");
    expect(after.hash).toBe(sha256(readFileSync(path.join(releaseRoot, "releases/bbbb222/index.html"))));

    // And the pointer is honoured in the other direction too.
    rollbackRelease(releaseRoot);
    expect((await servedBytes(app, "/")).hash).toBe(before.hash);
    await app.close();
  });

  it("falls back to the literal build directory only while nothing is published", async () => {
    const root = scratch("caw-deploy-literal-");
    const distDir = path.join(root, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>legacy</title>");
    const releaseRoot = path.join(root, ".deploy");
    const { app } = await makeApp({ releaseRoot, distDir });
    const literal = await servedBytes(app, "/");
    expect(literal.status).toBe(200);
    expect(literal.body).toContain("legacy");

    // Once a release exists, a *dead* pointer is a loud fault, not a silent
    // regression to the legacy directory: serving stale bytes while a
    // supposedly-live release is broken is the exact failure this phase bans.
    mkdirSync(releaseRoot, { recursive: true });
    symlinkSync(path.join("releases", "gone"), path.join(releaseRoot, "current"));
    const faulted = await servedBytes(app, "/");
    expect(faulted.status).toBe(404);
    expect(faulted.body).toContain("Web build missing");
    await app.close();
  });

  it("caches the resolved real path per link target and re-reads the pointer per request", () => {
    const root = scratch("caw-deploy-resolver-");
    const distDir = path.join(root, "dist");
    const releaseRoot = path.join(root, ".deploy");
    writeRelease(releaseRoot, "aaaa111", "A");
    writeRelease(releaseRoot, "bbbb222", "B");
    publishRelease(releaseRoot, "aaaa111");
    const resolver = createStaticRootResolver({ distDir, releaseRoot });
    const first = resolver.current();
    expect(first.root).toBe(realpathSync(path.join(releaseRoot, "releases/aaaa111")));
    expect(resolver.current().root).toBe(first.root);
    publishRelease(releaseRoot, "bbbb222");
    expect(resolver.current().root).toBe(realpathSync(path.join(releaseRoot, "releases/bbbb222")));
    expect(resolver.previous().root).toBe(realpathSync(path.join(releaseRoot, "releases/aaaa111")));
  });
});

describe("old-tab asset safety", () => {
  it("serves a superseded release's hashed asset but never its HTML", async () => {
    const { releaseRoot, app } = await publishedA();
    buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    await publishRelease(releaseRoot, "bbbb222");

    // A tab opened before the publish still holds A's HTML and asks for A's asset.
    const staleAsset = await servedBytes(app, "/assets/app-A.js");
    expect(staleAsset.status).toBe(200);
    expect(staleAsset.body).toContain("A");
    // It is cacheable as immutable, because a released asset never changes.
    const cached = await app.inject({ method: "GET", url: "/assets/app-A.js" });
    expect(cached.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    // HTML is never answered from the previous release: a navigation gets B.
    const navigation = await servedBytes(app, "/projects/whatever");
    expect(navigation.body).toContain("B");
    expect(navigation.body).not.toContain("/assets/app-A.js");

    // An asset from neither release is still an honest 404.
    expect((await servedBytes(app, "/assets/app-ffff999.js")).status).toBe(404);

    // After another publish the hop is still exactly one: B's asset remains
    // reachable while A's has aged out with the release that owned it.
    buildRelease({ releaseRoot, id: "dddd444", runner: fakeVite("D") });
    await publishRelease(releaseRoot, "dddd444");
    expect((await servedBytes(app, "/assets/app-B.js")).status).toBe(200);
    expect((await servedBytes(app, "/assets/app-A.js")).status).toBe(404);
    await app.close();
  });
});

describe("failure injection", () => {
  it("a failing build publishes nothing and leaves the served bytes untouched", async () => {
    const { releaseRoot, app } = await publishedA();
    const before = (await servedBytes(app, "/")).hash;
    expect(() => buildRelease({ releaseRoot, id: "bbbb222", runner: () => ({ status: 1 }) })).toThrow(/exited 1/);
    expect(existsSync(path.join(releaseRoot, "releases/bbbb222"))).toBe(false);
    expect((await servedBytes(app, "/")).hash).toBe(before);
    await app.close();
  });

  it("an interrupted build (killed mid-write) leaves a staging corpse, not a release", async () => {
    const { releaseRoot, app } = await publishedA();
    const before = (await servedBytes(app, "/")).hash;
    expect(() =>
      buildRelease({
        releaseRoot,
        id: "bbbb222",
        runner: (outDir: string) => {
          mkdirSync(path.join(outDir, "assets"), { recursive: true });
          writeFileSync(path.join(outDir, "assets", "half.js"), "partial");
          return { status: null, signal: "SIGKILL" };
        },
      }),
    ).toThrow(/on a signal/);
    expect(existsSync(path.join(releaseRoot, "releases/bbbb222"))).toBe(false);
    expect(readdirSync(path.join(releaseRoot, "staging")).length).toBe(1);
    // Staging is explicitly safe to delete, and pruning removes it.
    pruneReleases(releaseRoot, 1);
    expect(readdirSync(path.join(releaseRoot, "staging"))).toEqual([]);
    expect((await servedBytes(app, "/")).hash).toBe(before);
    await app.close();
  });

  it("rejects a release whose index.html names an asset it does not contain", async () => {
    const root = scratch("caw-deploy-missing-asset-");
    const releaseRoot = path.join(root, ".deploy");
    const dir = path.join(releaseRoot, "releases", "eeee555");
    mkdirSync(dir, { recursive: true });
    const index = '<!doctype html><script type="module" src="/assets/absent.js"></script>';
    writeFileSync(path.join(dir, "index.html"), index);
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ release: "eeee555", files: [{ path: "index.html", size: Buffer.byteLength(index), sha256: sha256(index) }] }),
    );
    expect(verifyRelease(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/references assets\/absent\.js/) });
    await expect(publishRelease(releaseRoot, "eeee555")).rejects.toThrow(/refusing to publish/);
    expect(readPointer(path.join(releaseRoot, "current"))).toBeNull();
  });

  it("rejects a tampered manifest (hash mismatch) and a file added after the build", async () => {
    const { releaseRoot } = await publishedA();
    const dir = path.join(releaseRoot, "releases", "bbbb222");
    buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    expect(verifyRelease(dir)).toMatchObject({ ok: true });
    const assetPath = path.join(dir, "assets", "app-B.js");
    writeFileSync(assetPath, readFileSync(assetPath, "utf8").replace("B", "X"));
    expect(verifyRelease(dir)).toMatchObject({ ok: false, reason: expect.stringMatching(/sha256 mismatch/) });
    await expect(publishRelease(releaseRoot, "bbbb222")).rejects.toThrow(/refusing to publish bbbb222/);
    rmSync(dir, { recursive: true, force: true });

    const extra = path.join(releaseRoot, "releases", "eeee555");
    buildRelease({ releaseRoot, id: "eeee555", runner: fakeVite("E") });
    writeFileSync(path.join(extra, "assets", "sneaked.js"), "x");
    expect(verifyRelease(extra)).toMatchObject({ ok: false, reason: expect.stringMatching(/not listed in manifest/) });
    await expect(publishRelease(releaseRoot, "eeee555")).rejects.toThrow(/refusing to publish eeee555/);
  });

  it("a publish that cannot write the pointer fails loudly and serves the old release", async () => {
    if (process.getuid?.() === 0) return; // root ignores the permission bits this case needs
    const { releaseRoot, app } = await publishedA();
    buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    const before = (await servedBytes(app, "/")).hash;
    const mode = statSync(releaseRoot).mode;
    chmodSync(releaseRoot, 0o500);
    try {
      await expect(publishRelease(releaseRoot, "bbbb222")).rejects.toThrow(/EACCES|EPERM|permission denied/);
    } finally {
      chmodSync(releaseRoot, mode);
    }
    expect(readlinkSync(path.join(releaseRoot, "current"))).toBe(path.join("releases", "aaaa111"));
    expect((await servedBytes(app, "/")).hash).toBe(before);
    await app.close();
  });

  it("recovers from an interrupted publish (leftover .current.new) instead of wedging", async () => {
    const { releaseRoot, app } = await publishedA();
    buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    // A publish killed between `symlink` and `rename` leaves this behind.
    mkdirSync(path.join(releaseRoot, "current.new", "debris"), { recursive: true });
    await publishRelease(releaseRoot, "bbbb222");
    expect(existsSync(path.join(releaseRoot, "current.new"))).toBe(false);
    expect((await servedBytes(app, "/")).body).toContain("B");
    await app.close();
  });

  it("rolls back when the post-publish health check fails", async () => {
    const { releaseRoot, app } = await publishedA();
    const before = (await servedBytes(app, "/")).hash;
    buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    const unhealthy = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("boom");
    });
    await new Promise<void>((resolve) => { unhealthy.listen(0, "127.0.0.1", resolve); });
    const port = (unhealthy.address() as AddressInfo).port;
    try {
      await expect(
        publishRelease(releaseRoot, "bbbb222", { healthUrl: `http://127.0.0.1:${port}/`, healthTimeoutMs: 150 }),
      ).rejects.toThrow(/health check|HTTP 500/);
    } finally {
      await new Promise<void>((resolve) => { unhealthy.close(() => resolve()); });
    }
    expect(readlinkSync(path.join(releaseRoot, "current"))).toBe(path.join("releases", "aaaa111"));
    expect((await servedBytes(app, "/")).hash).toBe(before);
    await app.close();
  });

  it("keeps rollback honest: no previous release means an error, not a guess", async () => {
    const releaseRoot = path.join(scratch("caw-deploy-rollback-"), ".deploy");
    writeRelease(releaseRoot, "aaaa111", "A");
    expect(() => rollbackRelease(releaseRoot)).toThrow(/no previous release/);
    await publishRelease(releaseRoot, "aaaa111");
    expect(() => rollbackRelease(releaseRoot)).toThrow(/no previous release/);
  });

  it("never prunes the current or previous release", async () => {
    const root = scratch("caw-deploy-prune-");
    const releaseRoot = path.join(root, ".deploy");
    for (const [id, marker] of [["r1", "1"], ["r2", "2"], ["r3", "3"], ["r4", "4"]] as const) writeRelease(releaseRoot, id, marker);
    await publishRelease(releaseRoot, "r1");
    await publishRelease(releaseRoot, "r2");
    pruneReleases(releaseRoot, 0);
    expect(readdirSync(path.join(releaseRoot, "releases")).sort()).toEqual(["r1", "r2"]);
    expect(releaseStatus(releaseRoot).current).toBe(path.join("releases", "r2"));
  });
});

describe("concurrency: a publish racing live requests", () => {
  it("answers every one of 10 concurrent requests with a complete, self-consistent release", async () => {
    const { releaseRoot, app } = await publishedA();
    const indexA = sha256(readFileSync(path.join(releaseRoot, "releases/aaaa111/index.html")));
    buildRelease({ releaseRoot, id: "bbbb222", runner: fakeVite("B") });
    const indexB = sha256(readFileSync(path.join(releaseRoot, "releases/bbbb222/index.html")));

    // Fire the requests first, then flip the pointer while they are in flight.
    const requests = Array.from({ length: 10 }, () => servedBytes(app, "/"));
    const publishing = publishRelease(releaseRoot, "bbbb222");
    const responses = await Promise.all(requests);
    await publishing;

    const seen = new Set<string>();
    for (const response of responses) {
      expect(response.status).toBe(200);
      // Exactly one of the two complete indexes — never truncated, never mixed.
      expect([indexA, indexB]).toContain(response.hash);
      expect(response.body.match(/<html>/gu) ?? []).toHaveLength(1);
      expect(response.body).toMatch(/<\/html>$/u);
      seen.add(response.hash);
    }
    // The point of the atomic swap: no third state was ever observable.
    expect(seen.size).toBe(1);
    // After the race settles, the new release is what is served.
    expect((await servedBytes(app, "/")).hash).toBe(indexB);
    await app.close();
  });
});

describe("ordinary-build safety", () => {
  it("pnpm --filter @caw/web build cannot change what the server serves", async () => {
    const root = scratch("caw-deploy-pnpm-");
    const releaseRoot = path.join(root, ".deploy");
    const built = await runWebBuild(releaseRoot);
    if (built === null) return; // pnpm unavailable in this environment
    expect(built).toBe(0);

    const releases = readdirSync(path.join(releaseRoot, "releases"));
    expect(releases.length).toBe(1);
    await publishRelease(releaseRoot, releases[0]!);
    const { app } = await makeApp({ releaseRoot, distDir: path.join(root, "dist") });
    const servedBefore = await servedBytes(app, "/");

    expect(await runWebBuild(releaseRoot)).toBe(0);

    // Byte-identical: the served release directory was not touched, and the
    // server still serves exactly the bytes it served before the rebuild.
    const servedAfter = await servedBytes(app, "/");
    expect(servedAfter.hash).toBe(servedBefore.hash);
    expect(readlinkSync(path.join(releaseRoot, "current"))).toBe(path.join("releases", releases[0]!));
    expect(verifyRelease(path.join(releaseRoot, "releases", releases[0]!))).toMatchObject({ ok: true });
    await app.close();
  });
});

describe("release status and reverting a swap", () => {
  it("reports broken releases by name, with the reason, instead of only a count", async () => {
    const releaseRoot = path.join(scratch("caw-deploy-status-"), ".deploy");
    writeRelease(releaseRoot, "aaaa111", "A");
    await publishRelease(releaseRoot, "aaaa111");
    const dir = path.join(releaseRoot, "releases", "aaaa111");
    // Same byte length, different content: the size check cannot catch this,
    // only the recorded hash can.
    const original = readFileSync(path.join(dir, "index.html"), "utf8");
    writeFileSync(path.join(dir, "index.html"), original.replace("<title>A</title>", "<title>X</title>"));
    const status = releaseStatus(releaseRoot);
    expect(status.current).toBe(path.join("releases", "aaaa111"));
    expect(status.releases[0]).toMatchObject({ id: "aaaa111", verified: false, pointers: ["current"] });
    expect(status.releases[0]!.reason).toMatch(/sha256 mismatch/);
    // …and publishing it again is refused rather than served.
    await expect(publishRelease(releaseRoot, "aaaa111")).rejects.toThrow(/refusing to publish/);
  });

  it("swapPointer replaces the pointer without ever leaving it absent", async () => {
    const root = scratch("caw-deploy-swap-");
    for (const id of ["one", "two"]) mkdirSync(path.join(root, "releases", id), { recursive: true });
    const pointer = path.join(root, "current");
    symlinkSync(path.join("releases", "one"), pointer);
    swapPointer(pointer, path.join("releases", "two"));
    expect(readlinkSync(pointer)).toBe(path.join("releases", "two"));
    expect(existsSync(pointer)).toBe(true);
    // A read-back mismatch aborts before anything visible changes.
    expect(() => swapPointer(pointer, "")).toThrow();
    expect(readlinkSync(pointer)).toBe(path.join("releases", "two"));
  });

  it("names the deploy layout it operates on", () => {
    expect(layout("/x")).toEqual({
      root: "/x",
      releases: "/x/releases",
      staging: "/x/staging",
      current: "/x/current",
      previous: "/x/previous",
    });
  });
});

describe("configuration and unit template", () => {
  it("puts the release root beside the build directory, so no new env var is required", async () => {
    const { loadConfig } = await import("../../apps/server/src/config.js");
    const repo = scratch("caw-deploy-config-");
    const defaults = await loadConfig({ env: {}, repoRoot: repo });
    expect(defaults.webDistDir).toBe(path.join(repo, "apps/web/dist"));
    expect(defaults.webReleaseRoot).toBe(path.join(repo, "apps/web/.deploy"));

    // A relocated build directory gets its own layout instead of reading the
    // repo's real releases: pointing the E2E harness at /tmp must not make it
    // serve the owner's published bundle.
    const moved = await loadConfig({ env: { CAW_WEB_DIST_DIR: "/tmp/caw-e2e-dist" }, repoRoot: repo });
    expect(moved.webReleaseRoot).toBe("/tmp/.deploy");
    const explicit = await loadConfig({
      env: { CAW_WEB_DIST_DIR: "/tmp/caw-e2e-dist", CAW_WEB_RELEASE_ROOT: "/tmp/caw-e2e-releases" },
      repoRoot: repo,
    });
    expect(explicit.webReleaseRoot).toBe("/tmp/caw-e2e-releases");
  });

  it("never both sets and unsets the same variable in the systemd template", () => {
    const template = readFileSync(path.join(repoRoot, "deploy/systemd/coding-agent-web.service"), "utf8");
    const directives = (prefix: string): string[] =>
      template
        .split("\n")
        .filter((line) => line.startsWith(prefix))
        .flatMap((line) => line.slice(prefix.length).trim().split(/\s+/u))
        .filter((value) => value.length > 0);
    const set = new Set(directives("Environment=").map((assignment) => assignment.split("=")[0] ?? assignment));
    const unset = new Set(directives("UnsetEnvironment="));
    // An `UnsetEnvironment=` entry silently beats an `Environment=` line for the
    // same key, so any overlap is a deployed-but-never-takes-effect bug.
    expect([...set].filter((key) => unset.has(key))).toEqual([]);
    // The release override is an ambient-shell escape hatch, so production
    // must strip it exactly like the dist-dir override it sits beside.
    expect(unset.has("CAW_WEB_RELEASE_ROOT")).toBe(true);
    expect(set.has("CAW_WEB_RELEASE_ROOT")).toBe(false);
    expect([...unset].filter((key) => key === "CAW_CONFIG" || key === "CAW_STATE_DIR")).toEqual([]);
  });
});
