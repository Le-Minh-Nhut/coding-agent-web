import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
const blockers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
  await Promise.all(blockers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (server.listening) server.close(() => resolve());
    else resolve();
  })));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function listening(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.setTimeout(250, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function expectStartupFailure(busy: "app" | "relay") {
  const dir = await mkdtemp(join(tmpdir(), "caw-r39-startup-"));
  dirs.push(dir);
  const blocker = createServer();
  blockers.push(blocker);
  const busyPort = await listen(blocker);
  const available = createServer();
  const otherPort = await listen(available);
  await new Promise<void>((resolve) => available.close(() => resolve()));
  const port = busy === "app" ? busyPort : otherPort;
  const relayPort = busy === "relay" ? busyPort : otherPort;
  const configPath = join(dir, "config.json");
  const stubPath = join(dir, "omp-stub.mjs");
  await writeFile(configPath, JSON.stringify({ host: "127.0.0.1", port, relayPort, stateDir: join(dir, "state"), allowedRoots: [dir], logLevel: "info" }));
  await writeFile(stubPath, "#!/usr/bin/env node\nprocess.stdout.write('{\"hosts\":[]}');\n", { mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "apps/server/src/server.ts")], {
    cwd: repoRoot,
    env: { ...process.env, HOME: dir, CAW_CONFIG: configPath, CAW_STATE_DIR: join(dir, "state"), CAW_OMP_BINARY_PATH: stubPath, XDG_STATE_HOME: join(dir, "xdg"), TMPDIR: process.env.HOME ? join(process.env.HOME, ".cache") : tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 10_000); // Real child-process deadline; fail-safe kills a hung server.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });
  expect(result.timedOut).toBe(false);
  expect(result.code).not.toBe(0);
  expect(result.signal).toBeNull();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(`${stdout}${stderr}`).toContain("EADDRINUSE");
  expect(`${stdout}${stderr}`).toContain(`address already in use 127.0.0.1:${busyPort}`);
  expect(`${stdout}${stderr}`).toContain("server failed to start");
  await new Promise<void>((resolve) => blocker.close(() => resolve()));
  expect(await listening(port)).toBe(false);
  expect(await listening(relayPort)).toBe(false);
}

it("exits for the busy app port and releases both listeners", async () => expectStartupFailure("app"));
it("exits for the busy relay port and releases both listeners", async () => expectStartupFailure("relay"));
