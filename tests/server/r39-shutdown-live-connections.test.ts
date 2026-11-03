import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RELAY_CLOSE } from "@caw/relay";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const DEADLINE_MS = 5_000;
const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(200, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function waitFor<T>(promise: Promise<T>, label: string, timeout = DEADLINE_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeout}ms deadline`)), timeout);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

async function launch() {
  const dir = await mkdtemp(join(tmpdir(), "caw-r39-shutdown-"));
  dirs.push(dir);
  const appPort = await freePort();
  let relayPort = await freePort();
  while (relayPort === appPort) relayPort = await freePort();
  const stateDir = join(dir, "state");
  const configPath = join(dir, "config.json");
  const stubPath = join(dir, "omp-stub.mjs");
  const invocationsPath = join(dir, "omp-invocations.jsonl");
  await writeFile(configPath, JSON.stringify({ host: "127.0.0.1", port: appPort, relayPort, stateDir, allowedRoots: [dir], logLevel: "info" }));
  await writeFile(invocationsPath, "");
  await writeFile(stubPath, `#!/usr/bin/env node\nconst fs = await import('node:fs');\nfs.appendFileSync(process.env.OMP_INVOCATIONS, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write('{"hosts":[]}');\n`, { mode: 0o700 });
  const child = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "apps/server/src/server.ts")], {
    cwd: repoRoot,
    env: { ...process.env, CAW_CONFIG: configPath, CAW_STATE_DIR: stateDir, CAW_OMP_BINARY_PATH: stubPath, OMP_INVOCATIONS: invocationsPath, XDG_STATE_HOME: join(dir, "xdg"), TMPDIR: process.env.HOME ? join(process.env.HOME, ".cache") : tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  return { child, dir, stateDir, appPort, relayPort, invocationsPath, output: () => stdout + stderr, stderr: () => stderr };
}

async function waitForListening(run: Awaited<ReturnType<typeof launch>>): Promise<void> {
  await waitFor((async () => {
    while (!await listening(run.appPort) || !await listening(run.relayPort)) {
      if (run.child.exitCode !== null || run.child.signalCode !== null) throw new Error(`server exited before listening: ${run.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })(), "server listeners");
}

function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  return waitFor(new Promise<WebSocket>((resolve, reject) => {
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  }), "websocket open");
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string; controls: string[] }> {
  const controls: string[] = [];
  socket.on("message", (data, binary) => { if (!binary) controls.push(data.toString()); });
  return waitFor(new Promise((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString(), controls }))), "websocket close");
}

async function livePeers(run: Awaited<ReturnType<typeof launch>>) {
  const base = `ws://127.0.0.1:${run.relayPort}/r/room-abcdefghijkl`;
  const host = await openSocket(`${base}?role=host`);
  const guest = await openSocket(`${base}?role=guest`);
  return { host, guest, hostClosed: closed(host), guestClosed: closed(guest) };
}

async function stop(run: Awaited<ReturnType<typeof launch>>, signals: NodeJS.Signals[], startup = false): Promise<void> {
  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    run.child.once("close", (code, signal) => resolve({ code, signal }));
  });
  for (const signal of signals) run.child.kill(signal);
  const result = await waitFor(resultPromise, "server shutdown");
  expect(startup ? result.code === 0 || result.signal === "SIGTERM" : result.code === 0).toBe(true);
  expect(run.stderr()).not.toMatch(/(?:Error:|\bERR_[A-Z0-9_]+\b|\bFATAL\b)/);
  expect(await listening(run.appPort)).toBe(false);
  expect(await listening(run.relayPort)).toBe(false);
}
async function assertOwnership(run: Awaited<ReturnType<typeof launch>>): Promise<void> {
  const files = await readdir(run.stateDir);
  expect(files).toEqual(expect.arrayContaining(["auth-password.json", "overlays"]));
  expect((await readFile(join(run.stateDir, "auth-password.json"), "utf8")).length).toBeGreaterThan(0);
  const rows = (await readFile(run.invocationsPath, "utf8")).trim().split("\n").filter(Boolean).map((row) => JSON.parse(row) as string[]);
  expect(rows.flat().join(" ")).not.toMatch(/\b(kill|delete|remove|destroy|rm)\b/i);
}


it.each(["SIGTERM", "SIGINT"] as const)("closes live host and guest on %s", async (signal) => {
  const run = await launch();
  await waitForListening(run);
  const peers = await livePeers(run);
  await stop(run, [signal]);
  const [host, guest] = await Promise.all([peers.hostClosed, peers.guestClosed]);
  expect(host.controls).toContain(JSON.stringify({ t: "relay-shutdown" }));
  expect([1001, RELAY_CLOSE.roomClosed]).toContain(host.code);
  expect(guest.controls).toContain(JSON.stringify({ t: "room-closed" }));
  expect(guest.code).toBe(RELAY_CLOSE.roomClosed);
  await assertOwnership(run);
});

it("keeps repeated SIGTERM and SIGINT cleanup idempotent", async () => {
  const run = await launch();
  await waitForListening(run);
  await livePeers(run);
  await stop(run, ["SIGTERM", "SIGTERM", "SIGINT"]);
});

it.each(["guest", "host"] as const)("shuts down after abrupt %s death", async (role) => {
  const run = await launch();
  await waitForListening(run);
  const peers = await livePeers(run);
  (role === "guest" ? peers.guest : peers.host).terminate();
  await stop(run, ["SIGTERM"]);
});

it("exits when SIGTERM arrives during startup, across jitter points", async () => {
  for (const delay of [0, 5, 20, 60]) {
    const run = await launch();
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    await stop(run, ["SIGTERM"], true);
  }
});
