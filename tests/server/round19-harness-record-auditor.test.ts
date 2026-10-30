import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig, type ServerConfig } from "../../apps/server/src/config.js";
import { privateTmuxServiceOptions } from "../../apps/server/src/tmux-service.js";
import { DefaultTmuxService } from "../../packages/omp-adapter/src/tmux.js";

/**
 * K1 regression: the pinned `omp` binary must cover the LAUNCH path, not just the
 * registry read.
 *
 * The E2E harness starts a real server with a stub `omp`, and a create-chat then
 * reaches the real supervisor. If the launch path resolved `omp` from PATH — as it
 * did when `CAW_OMP_PATH` had no consumer — that stub would never run and the
 * owner's real OMP would start inside tmux, spending their credits.
 *
 * These cases build the launch options through `privateTmuxServiceOptions`, the
 * same function `apps/server/src/server.ts` uses, and run them against a tmux argv
 * recorder: no tmux server and no OMP are needed. The control case injects
 * `ompBinary` straight into the adapter, documenting that the adapter option
 * always worked — the gap was that nothing fed it.
 */

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fake `omp` on PATH, so a bare-name resolution lands on it instead of ENOENT. */
async function fakeOmpOnPath(dir: string): Promise<string> {
  const fake = join(dir, "omp");
  await writeFile(fake, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await chmod(fake, 0o755);
  return fake;
}

/**
 * tmux argv recorder. `DefaultTmuxService.launch` runs `tmux new-session … <omp>
 * --config=…`, so the last argv element is the agent command. The stub answers the
 * two shapes `launch` parses back without a real tmux server.
 */
async function recorderTmux(dir: string): Promise<string> {
  const log = join(dir, "tmux-argv.jsonl");
  const stub = join(dir, "tmux-recorder");
  await writeFile(
    stub,
    [
      `#!${process.execPath}`,
      'const { appendFileSync } = require("node:fs");',
      "const argv = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");`,
      'if (argv.includes("new-session")) process.stdout.write("$1\\tprivate:1:2\\n");',
      'else if (argv.includes("list-sessions")) process.stdout.write("$1\\tcaw-test\\t1\\t1000000000\\t0\\tprivate:1:2\\n");',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await chmod(stub, 0o755);
  return stub;
}

/**
 * The agent command in a recorded `new-session` argv. tmux args are
 * `new-session -d -P -F <fmt> -s <name> -c <cwd> [-e K=V …] <omp> [--config=…] …`,
 * so the agent binary is the first element after the cwd and any `-e` pairs.
 */
function agentArgument(argv: string[]): string {
  const cwdIndex = argv.lastIndexOf("-c");
  if (cwdIndex < 0) throw new Error(`no cwd in ${JSON.stringify(argv)}`);
  let index = cwdIndex + 2;
  while (argv[index] === "-e") index += 2;
  const value = argv[index];
  if (value === undefined) throw new Error(`no agent command in ${JSON.stringify(argv)}`);
  return value;
}

/** The `new-session` argv the tmux recorder saw, or a loud failure if there was none. */
async function recordedLaunch(dir: string): Promise<string[]> {
  const lines = (await readFile(join(dir, "tmux-argv.jsonl"), "utf8")).trim().split("\n");
  // `launch` follows up with a `list-sessions`; the launch argv is the other line.
  const launched = lines.map((line) => JSON.parse(line) as string[]).find((row) => row.includes("new-session"));
  if (!launched) throw new Error("the tmux recorder saw no new-session call");
  return launched;
}

/** Launch once through the real option builder and return the recorded agent command. */
async function launchedAgentArgument(dir: string, config: ServerConfig): Promise<string> {
  // Only the tmux executable is swapped for the recorder; the omp wiring under
  // test is exactly what the server passes.
  await new DefaultTmuxService({ ...privateTmuxServiceOptions(config), tmuxBinary: await recorderTmux(dir) })
    .launch({ name: "guard", cwd: dir, configPath: join(dir, "overlay.yml") });
  return agentArgument(await recordedLaunch(dir));
}

it("K1: CAW_OMP_BINARY_PATH pins the launched agent command, not just the registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-k1-pinned-"));
  dirs.push(dir);
  const pinned = join(dir, "no-agent-binary");
  await writeFile(pinned, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  // A real-looking `omp` sits on PATH precisely so a regression back to bare-name
  // resolution would be answered by this file rather than failing with ENOENT.
  const onPath = await fakeOmpOnPath(dir);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);

  const config = await loadConfig({ env: { CAW_OMP_BINARY_PATH: pinned } });
  expect(config.ompBinaryPath).toBe(pinned);
  const started = await launchedAgentArgument(dir, config);

  console.log("K1 launch pin", JSON.stringify({ configured: pinned, agentArgument: started, onPath, guarded: started === pinned }));
  expect(started).toBe(pinned);
  expect(started).not.toBe("omp");
}, 30_000);

it("K1: an unset binary keeps the real-workload default (bare `omp` from PATH)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-k1-default-"));
  dirs.push(dir);
  await fakeOmpOnPath(dir);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);

  const config = await loadConfig({ env: {} });
  expect(config.ompBinaryPath).toBeUndefined();
  const started = await launchedAgentArgument(dir, config);

  console.log("K1 launch default", JSON.stringify({ agentArgument: started }));
  expect(started).toBe("omp");
}, 30_000);

it("K1 control: an explicitly injected adapter binary reaches the launched command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-k1-control-"));
  dirs.push(dir);
  const explicit = join(dir, "explicit-omp");
  await writeFile(explicit, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await new DefaultTmuxService({ socketPath: join(dir, "tmux.sock"), tmuxBinary: await recorderTmux(dir), ompBinary: explicit })
    .launch({ name: "control", cwd: dir, configPath: join(dir, "overlay.yml") });

  const started = agentArgument(await recordedLaunch(dir));
  console.log("K1 launch control", JSON.stringify({ explicit, agentArgument: started }));
  expect(started).toBe(explicit);
}, 30_000);
