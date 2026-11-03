import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("exits non-zero when the app port is busy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r39-startup-"));
  dirs.push(dir);
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as AddressInfo).port;
  const configPath = join(dir, "config.json");
  const stubPath = join(dir, "omp-stub.mjs");
  await writeFile(configPath, JSON.stringify({ host: "127.0.0.1", port, relayPort: port + 1, stateDir: join(dir, "state"), allowedRoots: [dir], logLevel: "info" }));
  await writeFile(stubPath, "#!/usr/bin/env node\nprocess.stdout.write('{\"hosts\":[]}');\n", { mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "apps/server/src/server.ts")], {
    cwd: repoRoot,
    env: { ...process.env, CAW_CONFIG: configPath, CAW_STATE_DIR: join(dir, "state"), CAW_OMP_BINARY_PATH: stubPath, XDG_STATE_HOME: join(dir, "xdg"), TMPDIR: process.env.HOME ? join(process.env.HOME, ".cache") : tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL", timedOut: true });
    }, 10_000); // Real child-process exit deadline is the behavior under test.
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
  });
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  expect(result.timedOut).toBe(false);
  expect(result.code).not.toBe(0);
});
