import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DefaultTmuxService } from "../../packages/omp-adapter/src/tmux.js";

const execFileAsync = promisify(execFile);

describe("tmux", () => {
  let tmuxAvailable = false;
  const socketName = `cawtest-${Date.now()}`;
  let service: DefaultTmuxService;

  beforeAll(async () => {
    try {
      await execFileAsync("tmux", ["-V"]);
      tmuxAvailable = true;
      service = new DefaultTmuxService({
        socketName,
        ompBinary: "sleep",
      });
    } catch {
      tmuxAvailable = false;
    }
  });

  afterAll(async () => {
    if (tmuxAvailable) {
      try {
        await execFileAsync("tmux", ["-L", socketName, "kill-server"]);
      } catch {
        // already stopped
      }
    }
  });

  it("spins up isolated session, lists, captures, and terminates", async (ctx) => {
    if (!tmuxAvailable) {
      ctx.skip();
      return;
    }

    // 1. Launch a managed session
    const session = await service.launch({
      name: "task-runner",
      cwd: "/tmp",
      args: ["15"],
    });

    expect(session.id).toMatch(/^\$\d+$/);
    expect(session.name).toBe("caw-task-runner");
    expect(session.alive).toBe(true);

    // 2. serverUp
    expect(await service.serverUp()).toBe(true);

    // 3. listManaged
    const managed = await service.listManaged();
    expect(managed.some((s) => s.id === session.id)).toBe(true);

    // 4. getById and getByName
    const byId = await service.getById(session.id);
    expect(byId?.name).toBe("caw-task-runner");

    const byName = await service.getByName("caw-task-runner");
    expect(byName?.id).toBe(session.id);

    // 5. sendKeys and capture
    await service.sendKeys(session.id, "date\n");
    const output = await service.capture(session.id, 10);
    expect(typeof output).toBe("string");

    // 6. kill with recorded identity and verify no session remains.
    await service.kill(session.id, { expectedIdentity: session.serverIdentity });
    const afterKill = await service.getById(session.id);
    expect(afterKill).toBeNull();
  });

  it("changes identity after restart on its private socket", async (ctx) => {
    if (!tmuxAvailable) {
      ctx.skip();
      return;
    }
    const first = await service.launch({ name: "identity-one", cwd: "/tmp", args: ["30"] });
    const firstIdentity = await service.serverIdentity();
    expect(first.serverIdentity).toBe(firstIdentity);
    await execFileAsync("tmux", ["-L", socketName, "kill-server"]);
    await execFileAsync("tmux", ["-L", socketName, "new-session", "-d", "-s", "caw-identity-stranger", "sleep", "30"]);
    const secondIdentity = await service.serverIdentity();
    expect(secondIdentity).not.toBeNull();
    expect(secondIdentity).not.toBe(firstIdentity);
    const stranger = await service.listManaged();
    expect(stranger[0]?.id).toBe(first.id);
    expect(stranger[0]?.serverIdentity).toBe(secondIdentity);
    await expect(service.kill(stranger[0]!.id, { expectedIdentity: first.serverIdentity })).rejects.toThrow(/identity_changed/);
    expect((await service.getById(stranger[0]!.id))?.alive).toBe(true);
  });

  it("keeps an unclaimed live process visible after adapter restart", async (ctx) => {
    if (!tmuxAvailable) {
      ctx.skip();
      return;
    }
    const directory = path.join(homedir(), ".cache", `caw-tmux-restart-${Date.now()}`);
    const socketPath = path.join(directory, "tmux.sock");
    await mkdir(directory, { recursive: true });
    const firstService = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    try {
      const session = await firstService.launch({ name: "restart-orphan", cwd: "/", args: ["30"] });
      const secondService = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
      const recovered = await secondService.listManaged();
      expect(recovered).toContainEqual(expect.objectContaining({
        id: session.id,
        serverIdentity: session.serverIdentity,
        alive: true,
        name: "caw-restart-orphan",
      }));
      await secondService.kill(session.id, { expectedIdentity: session.serverIdentity });
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("lists sessions after their display names leave the managed prefix", async (ctx) => {
    if (!tmuxAvailable) {
      ctx.skip();
      return;
    }
    const directory = path.join(homedir(), ".cache", `caw-tmux-rename-${Date.now()}`);
    const socketPath = path.join(directory, "tmux.sock");
    await mkdir(directory, { recursive: true });
    const privateService = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    try {
      const first = await privateService.launch({ name: "rename-visible", cwd: directory, args: ["30"] });
      const second = await privateService.launch({ name: "rename-other", cwd: directory, args: ["30"] });
      await execFileAsync("tmux", ["-S", socketPath, "rename-session", "-t", first.id, "renamed-away-from-prefix"]);

      await expect(privateService.listManaged()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.id, name: "renamed-away-from-prefix", alive: true }),
        expect.objectContaining({ id: second.id, name: second.name, alive: true }),
      ]));
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
});
