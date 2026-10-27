import { mkdir, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Conversation } from "@caw/contracts";
import { createSupervisor } from "@caw/runtime";
import type { ConversationRuntimeStore, RuntimeAdapters } from "@caw/runtime";
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
  it("settles stop after a recorded tmux session already disappeared", async (ctx) => {
    if (!tmuxAvailable) {
      ctx.skip();
      return;
    }
    const directory = path.join(homedir(), ".cache", `caw-tmux-stop-missing-${Date.now()}`);
    const socketPath = path.join(directory, "tmux.sock");
    await mkdir(directory, { recursive: true });
    const privateService = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    try {
      const session = await privateService.launch({ name: "stop-missing", cwd: directory, args: ["30"] });
      const sentinel = await privateService.launch({ name: "stop-sentinel", cwd: directory, args: ["30"] });
      expect(session.panePid).not.toBeNull();
      await execFileAsync("tmux", ["-S", socketPath, "kill-session", "-t", session.id]);

      const row: Conversation = {
        id: "c1", projectId: "p1", nativeSessionId: null, nativeSessionPath: null,
        title: "stopped session", model: null, ownership: "managed", state: "running",
        tmuxSessionId: session.id, tmuxSessionName: session.name,
        tmuxServerIdentity: session.serverIdentity, tmuxPanePid: session.panePid,
        hostInstanceId: null, hostGeneration: null, createdAt: "", updatedAt: "",
        lastActivityAt: null, statusDetail: null,
      };
      const rows = new Map([[row.id, row]]);
      const store: ConversationRuntimeStore = {
        getConversation: async (id) => rows.get(id) ?? null,
        listAllConversations: async () => [...rows.values()],
        updateConversation: async (id, patch) => {
          const current = rows.get(id);
          if (!current) return null;
          const next = { ...current, ...patch };
          rows.set(id, next);
          return next;
        },
        recordEvent: async () => null,
      };
      const adapters: RuntimeAdapters = {
        listHosts: async () => [],
        listManagedTmux: async () => (await privateService.listManaged()).map((item) => ({
          id: item.id, name: item.name, alive: item.alive, panePid: item.panePid, serverIdentity: item.serverIdentity,
        })),
        getTmux: async (id) => {
          const item = await privateService.getById(id);
          return { ok: true as const, session: item ? { id: item.id, name: item.name, alive: item.alive, panePid: item.panePid, serverIdentity: item.serverIdentity } : null };
        },
        isProcessDescendant: async () => false,
        tmuxServerIdentity: () => privateService.serverIdentity(),
        launch: async () => { throw new Error("not used"); },
        killTmux: (id, expectedIdentity) => privateService.kill(id, { expectedIdentity }),
        isSessionLive: async () => false,
        newestSessionFor: async () => null,
        sessionPathExists: async () => false,
        findBySessionId: async () => null,
      };
      const supervisor = createSupervisor({ store, adapters, maxActive: 1, stopTimeoutMs: 5_000 });

      const stopped = await supervisor.stop("c1");
      expect(stopped.state).toBe("stopped");
      expect(await privateService.getById(session.id)).toBeNull();
      expect((await privateService.getById(sentinel.id))?.alive).toBe(true);
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

it("proves ancestry from a real child process and fails closed for missing PIDs", async () => {
  const probe = new DefaultTmuxService();
  const child = spawn(process.execPath, ["-e", "process.stdin.resume()"]);
  try {
    if (child.pid === undefined) throw new Error("Child process did not receive a PID");
    expect(await probe.isProcessDescendant(child.pid, process.pid)).toBe(true);
    expect(await probe.isProcessDescendant(process.pid, child.pid)).toBe(false);
    expect(await probe.isProcessDescendant(2_000_000_000, process.pid)).toBe("unknown");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
});
