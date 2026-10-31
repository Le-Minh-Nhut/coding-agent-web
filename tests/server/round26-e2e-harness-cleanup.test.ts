import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import { expect, it } from "vitest";

/**
 * E2E-01/E2E-02: the harness must leave nothing behind on the path Playwright
 * actually takes.
 *
 * Playwright stops its `webServer` with SIGTERM (`gracefulShutdown`), waits, then
 * SIGKILLs the process group — and the launcher deliberately stays alive for that
 * SIGKILL instead of exiting, so the *only* place that removes the temp tree and
 * the default fixture manifest is the child-exit handler. This drives the real
 * launcher (it starts `tsx apps/server/src/server.ts` for a second — no browser,
 * no tmux session) and asserts both are gone once it exits.
 *
 * Not asserted here, because it would mean spawning a real tmux server: the
 * launcher's reap is by explicit socket path — `tmux -S <stateDir>/tmux.sock
 * kill-server`, array argv with `shell: false` — and never targets a
 * default/named server (`tmux kill-server`, `-L`, `$TMUX`, `TMUX_TMPDIR`), so a
 * developer's own tmux server on `/tmp/tmux-*` is unreachable from it
 * (AGENTS.md rule 2).
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const LAUNCHER = join(repoRoot, "scripts", "e2e-server.mjs");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
/** The launcher's own default; must match `tests/e2e/fixture.ts`'s fallback. */
const DEFAULT_MANIFEST = join(tmpdir(), "caw-e2e-fixture.json");
/** Printed only after the manifest is written, so it is a readiness signal. */
const READY_LINE = "[e2e-server] listening";

/** Local copy of the repo's test helper; `Promise.withResolvers` needs ES2024. */
function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A port nothing is listening on right now. The launcher defaults to 4399, and
 * vitest runs several test files at once — a batch that also binds 4399 would
 * collide, so this test pins its own ports instead of racing the default.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  const { promise, resolve, reject } = withResolvers<number>();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (address === null || typeof address === "string") reject(new Error("probe did not bind a TCP port"));
    else resolve(address.port);
  });
  try {
    return await promise;
  } finally {
    probe.close();
  }
}

async function waitForLine(stream: Readable, needle: string): Promise<void> {
  for await (const chunk of stream) {
    if (String(chunk).includes(needle)) return;
  }
  throw new Error(`launcher exited before printing ${JSON.stringify(needle)}`);
}

it("removes its temp root and default manifest when stopped with SIGTERM", async () => {
  if (!existsSync(TSX)) throw new Error(`tsx devDependency missing at ${TSX}; run pnpm install`);

  // This tier spawns no build, so the launcher's asset precondition (and the
  // server's, which derives web assets from the same variable) is pointed at a
  // stub `apps/web/dist` instead of requiring `pnpm --filter @caw/web build` to
  // have run first. `CAW_WEB_DIST_DIR` is the server's own override, so this
  // checks the same path the server will serve.
  const webStub = mkdtempSync(join(tmpdir(), "caw-e2e-web-"));
  writeFileSync(join(webStub, "index.html"), "<!doctype html><title>stub</title>\n");

  // Start from the state a "nothing was left behind" run should end in.
  rmSync(DEFAULT_MANIFEST, { force: true });

  const env: NodeJS.ProcessEnv = { ...process.env, CAW_LOG_LEVEL: "error" };
  env.CAW_WEB_DIST_DIR = webStub;
  // The manifest default must be exercised, so the fixture variable stays unset;
  // the ports must not be, or this run races the default 4399 in a parallel batch.
  delete env.CAW_E2E_FIXTURE;
  const port = await freePort();
  let relayPort = await freePort();
  // The server refuses to start when the two listeners share a port.
  while (relayPort === port) relayPort = await freePort();
  env.CAW_E2E_PORT = String(port);
  env.CAW_RELAY_PORT = String(relayPort);

  const launcher = spawn(process.execPath, [LAUNCHER], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  launcher.stderr.resume(); // drained, never buffered: a full pipe would stall the server
  let tempRoot = "";
  try {
    await waitForLine(launcher.stdout, READY_LINE);

    const fixture = JSON.parse(readFileSync(DEFAULT_MANIFEST, "utf8")) as { tempRoot: string; stateDir: string };
    tempRoot = fixture.tempRoot;
    expect(tempRoot.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(existsSync(fixture.stateDir)).toBe(true);

    const exited = once(launcher, "exit");
    launcher.kill("SIGTERM"); // exactly what Playwright's teardown sends
    await exited;
    // Prove the launcher exited through its own cleanup path: a runtime still in
    // startup would have needed this test's SIGKILL fallback instead.
    expect(launcher.signalCode).toBeNull();

    expect(existsSync(tempRoot)).toBe(false);
    expect(existsSync(DEFAULT_MANIFEST)).toBe(false);
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    rmSync(DEFAULT_MANIFEST, { force: true });
    rmSync(webStub, { recursive: true, force: true });
  }
});
