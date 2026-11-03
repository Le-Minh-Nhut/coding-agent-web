import { spawn, type ChildProcess } from "node:child_process";
import { createServer, createConnection, type AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const children: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function portReachable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

async function startServer(dir: string, port: number, relayPort: number) {
  const child = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "apps/server/src/server.ts")], {
    cwd: repoRoot,
    env: { ...process.env, CAW_CONFIG: join(dir, "config.json"), CAW_OMP_BINARY_PATH: join(dir, "omp-stub.mjs"), XDG_STATE_HOME: join(dir, "xdg"), TMPDIR: process.env.HOME ? join(process.env.HOME, ".cache") : tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  children.push(child);
  let output = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  // Readiness is the port accepting connections plus the app's own 401. The
  // child is a separate process on the platform clock, so this is one of the
  // integration cases a real wall-clock wait is needed for; the wait only ends
  // the test when the condition (port + 401) never arrives, and the deadline
  // names the hung child's captured output.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited before readiness: ${output}`);
    if (await portReachable(port)) {
      const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`).catch(() => null);
      if (me?.status === 401) return { child, output: () => output };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server never became ready: ${output}`);
}

async function stopServer(child: ChildProcess) {
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  await closed;
  expect(child.signalCode === "SIGTERM" || child.exitCode !== null).toBe(true);
}

async function completeSetup(port: number, token: string) {
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ password: token }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected setup session cookie");
  const body = await login.json() as { data: { csrfToken: string } };
  return fetch(`${origin}/api/auth/set-password`, {
    method: "POST", headers: { "content-type": "application/json", origin, cookie, "x-caw-csrf": body.data.csrfToken }, body: JSON.stringify({ password: "correct horse battery" }),
  });
}

it("recreates the setup token file on a real server restart after it was deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-setup-server-start-"));
  dirs.push(dir);
  const stateDir = join(dir, "state");
  const port = await freePort();
  const relayPort = await freePort();
  await writeFile(join(dir, "config.json"), JSON.stringify({ host: "127.0.0.1", port, relayPort, stateDir, allowedRoots: [dir], logLevel: "silent", insecureCookies: true }));
  await writeFile(join(dir, "omp-stub.mjs"), "#!/usr/bin/env node\nprocess.stdout.write('{\"hosts\":[]}');\n", { mode: 0o700 });

  const first = await startServer(dir, port, relayPort);
  const tokenPath = join(stateDir, "setup-token");
  const originalToken = await readFile(tokenPath, "utf8");
  expect(first.output()).toContain(`first-run setup token written to ${tokenPath}`);
  await stopServer(first.child);
  expect(await portReachable(port)).toBe(false);

  await rm(tokenPath);
  const second = await startServer(dir, port, relayPort);
  const repairedToken = await readFile(tokenPath, "utf8");
  expect(second.output()).toContain(`first-run setup token written to ${tokenPath}`);
  expect(repairedToken).not.toBe(originalToken);
  expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);

  expect((await completeSetup(port, repairedToken)).status).toBe(200);
  await expect(stat(tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
  await stopServer(second.child);

  const third = await startServer(dir, port, relayPort);
  await expect(stat(tokenPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(third.output()).not.toContain("first-run setup token written to");
  await stopServer(third.child);
}, 60_000);
