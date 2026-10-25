import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DefaultTmuxService } from "../../packages/omp-adapter/src/tmux.js";
const execFileAsync = promisify(execFile);

/**
 * The adapter's tri-state rule: "the tmux server is not there" is a *confirmed*
 * answer, while "I could not run the probe" is not. Conflating them is what let a
 * stopped agent be reported as stopped off a probe that never ran.
 */
describe("tmux probe tri-state", () => {
  const socketName = `cawtri-${Date.now()}`;
  let tmuxAvailable = false;

  afterAll(async () => {
    if (tmuxAvailable) {
      await execFileAsync("tmux", ["-L", socketName, "kill-server"]).catch(() => {});
    }
  });

  it("reports a missing server as absent, not as a failed probe", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
      tmuxAvailable = true;
    } catch {
      ctx.skip();
      return;
    }
    // An uncreated private socket is unreachable; this is not proof that any recorded server process exited.
    const service = new DefaultTmuxService({ socketName, ompBinary: "sleep" });
    await expect(service.serverIdentity()).resolves.toBeNull();
    await expect(service.listManaged()).resolves.toEqual([]);
    await expect(service.getById("$0")).resolves.toBeNull();
  });

  it("fails the probe when tmux itself cannot run, instead of claiming no server", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
      tmuxAvailable = true;
    } catch {
      ctx.skip();
      return;
    }
    const service = new DefaultTmuxService({
      tmuxBinary: "/nonexistent/tmux-binary",
      socketName,
      ompBinary: "sleep",
    });
    // A missing binary is a probe that could not run, never "no server running".
    await expect(service.serverIdentity()).rejects.toThrow(/tmux server identity/i);
    await expect(service.listManaged()).rejects.toThrow(/Could not list tmux sessions/i);
  });

  it("keeps permission-denied server and session probes as failures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "caw-tmux-denied-"));
    const wrapper = path.join(directory, "tmux-denied");
    await writeFile(wrapper, "#!/usr/bin/env node\nprocess.stderr.write('error connecting to /tmp/private.sock (Permission denied)\\n'); process.exitCode = 1;\n");
    await chmod(wrapper, 0o755);
    try {
      const service = new DefaultTmuxService({ tmuxBinary: wrapper, socketName: "unused", ompBinary: "sleep" });
      await expect(service.serverIdentity()).rejects.toThrow(/Could not read the tmux server identity/);
      await expect(service.listManaged()).rejects.toThrow(/Could not list tmux sessions/);
      await expect(service.getById("$0")).rejects.toThrow(/Could not list tmux sessions/);
      await expect(service.getByName("caw-agent")).rejects.toThrow(/Could not list tmux sessions/);
      await expect(service.kill("$0", { expectedIdentity: "private-socket:1:2" })).rejects.toThrow(/identity_probe_failed/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("treats an ENOENT socket diagnostic as unreachable rather than process absence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "caw-tmux-absent-"));
    const wrapper = path.join(directory, "tmux-absent");
    await writeFile(wrapper, "#!/usr/bin/env node\nprocess.stderr.write('error connecting to /tmp/private.sock (No such file or directory)\\n'); process.exitCode = 1;\n");
    await chmod(wrapper, 0o755);
    try {
      const service = new DefaultTmuxService({ tmuxBinary: wrapper, socketName: "unused", ompBinary: "sleep" });
      await expect(service.serverIdentity()).resolves.toBeNull();
      await expect(service.listManaged()).resolves.toEqual([]);
      await expect(service.getById("$0")).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refuses ownership enumeration without a configured private socket", async () => {
    await expect(new DefaultTmuxService({ ompBinary: "sleep" }).listManaged())
      .rejects.toThrow(/explicitly configured private tmux socket/i);
  });

  it("rejects a guarded kill command failure instead of claiming success", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "caw-tmux-kill-failed-"));
    const wrapper = path.join(directory, "tmux-kill-failed");
    await writeFile(wrapper, "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args.includes('display-message')) process.stdout.write('fake-socket:123:456\\n');\nelse if (args.includes('if-shell')) { process.stderr.write('kill permission denied\\n'); process.exitCode = 1; }\nelse if (args.includes('list-sessions')) process.stdout.write('$0\\tcaw-still-alive\\t123\\t42\\t0\\tfake-socket:123:456\\n');\n");
    await chmod(wrapper, 0o755);
    const diagnostics: Array<{ event: string; detail: Record<string, unknown> }> = [];
    try {
      const service = new DefaultTmuxService({
        tmuxBinary: wrapper,
        socketName: "unused",
        ompBinary: "sleep",
        onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
      });
      await expect(service.kill("$0", { expectedIdentity: "fake-socket:123:456" })).rejects.toThrow(/kill_failed/i);
      expect(diagnostics.map((entry) => entry.detail.blockedBy)).toEqual(["kill_failed: kill permission denied"]);
      await expect(service.getById("$0")).resolves.toMatchObject({ id: "$0", alive: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a failed guarded kill through the diagnostic hook", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
      tmuxAvailable = true;
    } catch {
      ctx.skip();
      return;
    }
    const diagnostics: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const service = new DefaultTmuxService({
      socketName,
      ompBinary: "sleep",
      onDiagnostic: (event, detail) => diagnostics.push({ event, detail }),
    });
    await service.launch({ name: "tri-kill", cwd: "/tmp", args: ["20"] });
    await expect(service.kill("$0", { expectedIdentity: "other-socket:1:2" })).rejects.toThrow(/identity_changed/);
    expect(diagnostics.map((entry) => entry.detail.blockedBy)).toEqual(["identity_changed"]);
  });
});
