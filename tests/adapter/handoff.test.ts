import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DefaultTmuxService } from "../../packages/omp-adapter/src/tmux.js";

/**
 * `/handoff` is a keystroke into a running TUI, so the questions that matter are
 * all "did we refuse, and why", plus "what exactly reached the pane". A fake tmux
 * on the socket path answers both: it records every argv it was invoked with and
 * every byte handed to it on stdin, so the assertions are about observable
 * process calls, not about the adapter's internal state.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A stand-in for the pane process. The adapter corroborates the pane pid against
 * `/proc` and requires its argv[0] to be the agent binary, so the pid must belong
 * to a real process whose cmdline says `omp`. `argv0` overrides cmdline[0]
 * without exec'ing anything the tests must not run.
 */
const paneChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { argv0: "omp", stdio: "ignore" });
const panePid = paneChild.pid!;
afterAll(() => { paneChild.kill("SIGKILL"); });

interface FakePane {
  sessionId?: string;
  paneId?: string;
  panePid?: number;
  command?: string;
  dead?: string;
  attached?: string;
}

/** A tmux that answers the handoff probes from a config file and logs its argv. */
async function fakeTmux(options: { panes?: FakePane[]; identity?: string; listPanesFails?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "caw-handoff-"));
  dirs.push(dir);
  const configPath = path.join(dir, "config.json");
  const logPath = path.join(dir, "argv.jsonl");
  const stdinPath = path.join(dir, "stdin.txt");
  await writeFile(configPath, JSON.stringify({
    identity: options.identity ?? "fake.sock:111:222",
    panes: options.panes ?? [{ panePid }],
    listPanesFails: options.listPanesFails ?? null,
  }));
  await writeFile(logPath, "");
  const binary = path.join(dir, "tmux");
  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_TMUX_CONFIG, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + "\\n");
if (args.includes("display-message")) { process.stdout.write(cfg.identity + "\\n"); process.exit(0); }
if (args.includes("list-panes")) {
  if (cfg.listPanesFails) { process.stderr.write(cfg.listPanesFails + "\\n"); process.exit(1); }
  const rows = cfg.panes.map((p) => [
    p.sessionId ?? "$0", p.paneId ?? "%0", String(p.panePid ?? 0), p.command ?? "omp", p.dead ?? "0", p.attached ?? "0",
  ].join("\\t"));
  process.stdout.write(rows.join("\\n") + "\\n");
  process.exit(0);
}
if (args.includes("load-buffer")) {
  let data = "";
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => { fs.appendFileSync(process.env.FAKE_TMUX_STDIN, data); process.exit(0); });
  process.stdin.resume();
  return;
}
process.exit(0);
`);
  await chmod(binary, 0o755);
  const previous = { FAKE_TMUX_CONFIG: process.env.FAKE_TMUX_CONFIG, FAKE_TMUX_LOG: process.env.FAKE_TMUX_LOG, FAKE_TMUX_STDIN: process.env.FAKE_TMUX_STDIN };
  process.env.FAKE_TMUX_CONFIG = configPath;
  process.env.FAKE_TMUX_LOG = logPath;
  process.env.FAKE_TMUX_STDIN = stdinPath;
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  // The fake passes these through the real environment, so a per-test service sees them.
  return {
    service: () => new DefaultTmuxService({ tmuxBinary: binary, socketName: "unused", ompBinary: "omp" }),
    restore,
    argv: async () => (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]),
    stdin: async () => { try { return await readFile(stdinPath, "utf8"); } catch { return ""; } },
    dir,
  };
}

const identity = "fake.sock:111:222";

describe("sendHandoff", () => {
  it("pastes the constant /handoff and presses Enter as a separate command", async () => {
    const fake = await fakeTmux();
    try {
      const result = await fake.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true });
      expect(result).toEqual({ delivered: true, sessionId: "$0", paneId: "%0", panePid });

      const argv = await fake.argv();
      const paste = argv.findIndex((row) => row.includes("paste-buffer"));
      const enter = argv.findIndex((row) => row.includes("send-keys"));
      expect(paste).toBeGreaterThanOrEqual(0);
      expect(enter).toBeGreaterThan(paste);
      expect(argv[paste]).toEqual(["-L", "unused", "paste-buffer", "-p", "-b", `caw-handoff-${panePid}`, "-t", "%0"]);
      expect(argv[enter]).toEqual(["-L", "unused", "send-keys", "-t", "%0", "Enter"]);
      // The command text travels on stdin, never on a command line any same-uid
      // process could read out of /proc.
      expect(await fake.stdin()).toBe("/handoff");
      expect(argv.flat().some((arg) => arg.includes("/handoff"))).toBe(false);
    } finally {
      fake.restore();
    }
  });

  it("refuses when a terminal is attached, because a paste splices into a human draft", async () => {
    const fake = await fakeTmux({ panes: [{ panePid, attached: "1" }] });
    try {
      const result = await fake.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true });
      expect(result).toMatchObject({ delivered: false, refusal: "terminal_attached" });
      // Nothing was staged or pasted: the refusal happens before any keystroke.
      expect((await fake.argv()).some((row) => row.includes("paste-buffer") || row.includes("load-buffer"))).toBe(false);
    } finally {
      fake.restore();
    }
  });

  it("refuses when the caller cannot prove idleness", async () => {
    const fake = await fakeTmux();
    try {
      const absent = await fake.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid });
      expect(absent).toMatchObject({ delivered: false, refusal: "not_idle" });
      const throwing = await fake.service().sendHandoff("$0", {
        expectedIdentity: identity, expectedPanePid: panePid,
        assertIdle: async () => { throw new Error("registry unreadable"); },
      });
      expect(throwing).toMatchObject({ delivered: false, refusal: "not_idle" });
    } finally {
      fake.restore();
    }
  });

  it("refuses when the pane pid, command or session id no longer match the record", async () => {
    const cases: Array<[string, FakePane]> = [
      ["pane_changed", { panePid: panePid + 1 }],
      ["command_changed", { panePid, command: "bash" }],
      ["identity_changed", { panePid, sessionId: "$9" }],
    ];
    for (const [refusal, pane] of cases) {
      const fake = await fakeTmux({ panes: [pane] });
      try {
        const result = await fake.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true });
        expect(result).toMatchObject({ delivered: false, refusal });
      } finally {
        fake.restore();
      }
    }
  });

  it("refuses a changed server identity and a missing session", async () => {
    const changed = await fakeTmux({ identity: "other.sock:1:2" });
    try {
      expect(await changed.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true }))
        .toMatchObject({ delivered: false, refusal: "identity_changed" });
    } finally {
      changed.restore();
    }
    const missing = await fakeTmux({ listPanesFails: "can't find session: $0" });
    try {
      expect(await missing.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true }))
        .toMatchObject({ delivered: false, refusal: "session_missing" });
    } finally {
      missing.restore();
    }
  });

  it("refuses an ambiguous multi-pane session and a dead pane", async () => {
    const ambiguous = await fakeTmux({ panes: [{ panePid }, { panePid, paneId: "%1" }] });
    try {
      expect(await ambiguous.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true }))
        .toMatchObject({ delivered: false, refusal: "pane_ambiguous" });
    } finally {
      ambiguous.restore();
    }
    const dead = await fakeTmux({ panes: [{ panePid, dead: "1" }] });
    try {
      expect(await dead.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true }))
        .toMatchObject({ delivered: false, refusal: "session_missing" });
    } finally {
      dead.restore();
    }
  });

  it("refuses a pid that is gone or belongs to a stranger, not trusting the number tmux reported", async () => {
    const gone = await fakeTmux({ panes: [{ panePid: 2_000_000_000 }] });
    try {
      // tmux reports the pid we asked for, but /proc proves nothing lives there.
      const result = await gone.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: 2_000_000_000, assertIdle: async () => true });
      expect(result).toMatchObject({ delivered: false, refusal: "process_changed" });
    } finally {
      gone.restore();
    }
    // A live process whose argv[0] is not the agent binary: the pid exists, so
    // mere existence is not identity.
    const strangerPid = process.pid;
    const stranger = await fakeTmux({ panes: [{ panePid: strangerPid }] });
    try {
      const result = await stranger.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: strangerPid, assertIdle: async () => true });
      expect(result).toMatchObject({ delivered: false, refusal: "process_changed" });
    } finally {
      stranger.restore();
    }
  });

  it("never lets a hostile tmux's stdin handling crash the process", async () => {
    // A stand-in that closes the read end of stdin. The window is real but narrow:
    // the 8-byte constant usually fits the pipe buffer before the close, so this
    // case is a regression guard for the survival property, not a reproduction of
    // the EPIPE itself. The pathological write is measured separately (a payload
    // past the 64 KiB pipe buffer emits an unhandled `write EPIPE` without the
    // handler and none with it).
    const dir = await mkdtemp(path.join(tmpdir(), "caw-handoff-epipe-"));
    dirs.push(dir);
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ identity, panes: [{ panePid }], listPanesFails: null }));
    const binary = path.join(dir, "tmux");
    await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_TMUX_CONFIG, "utf8"));
const args = process.argv.slice(2);
if (args.includes("display-message")) { process.stdout.write(cfg.identity + "\\n"); process.exit(0); }
if (args.includes("list-panes")) {
  process.stdout.write(cfg.panes.map((p) => [
    p.sessionId ?? "$0", p.paneId ?? "%0", String(p.panePid ?? 0), p.command ?? "omp", p.dead ?? "0", p.attached ?? "0",
  ].join("\\t")) + "\\n");
  process.exit(0);
}
// load-buffer: close the read end of stdin, then linger so a write that is not
// buffered in time would hit a pipe with no reader.
fs.closeSync(0);
setTimeout(() => process.exit(0), 1500);
`);
    await chmod(binary, 0o755);
    const previous = process.env.FAKE_TMUX_CONFIG;
    process.env.FAKE_TMUX_CONFIG = configPath;
    const uncaught: string[] = [];
    const onUncaught = (error: Error) => { uncaught.push(error.message); };
    process.on("uncaughtException", onUncaught);
    try {
      const service = new DefaultTmuxService({ tmuxBinary: binary, socketName: "unused", ompBinary: "omp" });
      // The call settles either way; what must never happen is an uncaught stream
      // error taking the process down.
      await service.sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: panePid, assertIdle: async () => true }).catch(() => undefined);
      // The unhandled-error window is asynchronous; give it a turn to surface.
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
      if (previous === undefined) delete process.env.FAKE_TMUX_CONFIG;
      else process.env.FAKE_TMUX_CONFIG = previous;
    }
  });

  it("rejects a malformed session id and a malformed expected identity", async () => {
    const fake = await fakeTmux();
    try {
      await expect(fake.service().sendHandoff("caw-agent", { expectedIdentity: identity, expectedPanePid: panePid })).rejects.toThrow(/Invalid tmux session id/);
      await expect(fake.service().sendHandoff("$0", { expectedIdentity: "not-an-identity", expectedPanePid: panePid })).rejects.toThrow(/Invalid expected tmux server identity/);
      await expect(fake.service().sendHandoff("$0", { expectedIdentity: identity, expectedPanePid: 0 })).rejects.toThrow(/recorded pane process id/);
    } finally {
      fake.restore();
    }
  });
});
