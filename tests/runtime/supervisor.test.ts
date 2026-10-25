import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Conversation } from "@caw/contracts";
import { createSupervisor } from "@caw/runtime";
import type {
  ConversationRuntimeStore,
  RuntimeAdapters,
  RuntimeHost,
  RuntimeLaunchSpec,
  RuntimeTmuxSession,
} from "@caw/runtime";
import { DefaultTmuxService } from "../../packages/omp-adapter/src/tmux.js";
import type { TmuxSession } from "../../packages/omp-adapter/src/types.js";

const execFileAsync = promisify(execFile);

function runtimeSession(session: TmuxSession): RuntimeTmuxSession {
  return {
    id: session.id,
    name: session.name,
    alive: session.alive,
    panePid: session.panePid,
    serverIdentity: session.serverIdentity,
  };
}

/** A controllable world: tmux sessions, rooms, leases, and a journal of events. */
function makeWorld() {
  const tmuxSessions: RuntimeTmuxSession[] = [];
  const hosts: RuntimeHost[] = [];
  let lease: boolean | "unknown" = false;
  let registryThrows = false;
  let tmuxListThrows = false;
  let probeFails = false;
  let storeWriteThrows = false;
  let killThrows = false;
  let nextId = 1;
  let tmuxServerIdentity: string | null = "private-socket:1";

  const events: Array<{ conversationId: string; type: string; payload: unknown }> = [];
  const launches: RuntimeLaunchSpec[] = [];
  const kills: string[] = [];

  const adapters: RuntimeAdapters = {
    async listHosts() {
      if (registryThrows) throw new Error("registry unreadable");
      return hosts;
    },
    async listManagedTmux() {
      if (tmuxListThrows) throw new Error("tmux enumeration failed");
      return tmuxSessions;
    },
    async getTmux(id) {
      if (probeFails) return { ok: false as const, reason: "tmux probe could not run" };
      return { ok: true as const, session: tmuxSessions.find((session) => session.id === id) ?? null };
    },
    async tmuxServerIdentity() {
      return tmuxServerIdentity;
    },
    async launch(spec) {
      launches.push(spec);
      const session: RuntimeTmuxSession = {
        id: `$${nextId++}`,
        name: spec.name,
        alive: true,
        panePid: 1000 + nextId,
        serverIdentity: tmuxServerIdentity ?? "private-socket:1",
      };
      tmuxSessions.push(session);
      return session;
    },
    async killTmux(id, expectedIdentity) {
      expect(expectedIdentity).toBe(tmuxServerIdentity);
      kills.push(id);
      if (killThrows) throw new Error("injected guarded kill failure");
      const index = tmuxSessions.findIndex((session) => session.id === id);
      if (index >= 0) tmuxSessions.splice(index, 1);
    },
    async isSessionLive() {
      return lease;
    },
    async newestSessionFor() {
      return null;
    },
    async sessionPathExists() {
      return true;
    },
    async findBySessionId() {
      return "/tmp/sessions/journal.jsonl";
    },
  };

  const conversations = new Map<string, Conversation>();
  const store: ConversationRuntimeStore = {
    async getConversation(id) {
      return conversations.get(id) ?? null;
    },
    async listAllConversations() {
      return [...conversations.values()];
    },
    async updateConversation(id, patch) {
      const current = conversations.get(id);
      if (!current) return null;
      if (storeWriteThrows) throw new Error("simulated store write failure after tmux launch");
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      conversations.set(id, next);
      return next;
    },
    async recordEvent(conversationId, type, payload) {
      events.push({ conversationId, type, payload });
      return { conversationId, type, payload };
    },
  };

  function seed(over: Partial<Conversation> = {}): Conversation {
    const conversation: Conversation = {
      id: over.id ?? "c1",
      projectId: "p1",
      nativeSessionId: null,
      nativeSessionPath: null,
      title: "conversation",
      model: null,
      ownership: "managed",
      state: "starting",
      tmuxSessionId: null,
      tmuxSessionName: null,
      tmuxServerIdentity: null, tmuxPanePid: null,
      hostInstanceId: null,
      hostGeneration: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: null,
      statusDetail: null,
      ...over,
    };
    conversations.set(conversation.id, conversation);
    return conversation;
  }

  return {
    adapters,
    store,
    seed,
    tmuxSessions,
    hosts,
    events,
    launches,
    kills,
    setLease: (value: boolean | "unknown") => {
      lease = value;
    },
    breakRegistry: (value: boolean) => {
      registryThrows = value;
    },
    breakTmuxList: (value: boolean) => {
      tmuxListThrows = value;
    },
    breakTmuxProbe: (value: boolean) => {
      probeFails = value;
    },
    breakStoreWrites: (value: boolean) => {
      storeWriteThrows = value;
    },
    breakKills: (value: boolean) => {
      killThrows = value;
    },
    setServerIdentity: (value: string | null) => {
      tmuxServerIdentity = value;
    },
  };
}

const instantClock = {
  now: () => Date.now(),
  sleep: async () => {},
};

/**
 * A clock whose sleeps return immediately but whose time still advances past any
 * deadline. `now()` is derived from the number of sleeps, so a loop bounded by a
 * deadline cannot spin: it either exits on the first poll or runs out of time.
 * `BOUNDED_POLL_MS` keeps any deadline from being reached before the first poll,
 * so the branch under test is always entered exactly once.
 */
const BOUNDED_POLL_MS = 1_000_000;
function boundedClock(): { now: () => number; sleep: () => Promise<void> } {
  let t = 0;
  return {
    now: () => (t += BOUNDED_POLL_MS),
    sleep: async () => {},
  };
}

describe("supervisor.start", () => {
  it("allows only one concurrent writer for conversations sharing a native session", async () => {
    const world = makeWorld();
    const sessionId = "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e";
    world.seed({ id: "c1", nativeSessionId: sessionId });
    world.seed({ id: "c2", nativeSessionId: sessionId });
    // Hold the lease probe open so both requests are in flight together, exactly
    // as two taps would be. The probe now runs inside the serialized section, so
    // the *test* must release the gate rather than expecting two probes.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    world.adapters.isSessionLive = async () => {
      await gate;
      return false;
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: boundedClock(), maxActive: 3, publishTimeoutMs: BOUNDED_POLL_MS });
    const first = supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
    const second = supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" });
    openGate();
    const results = await Promise.allSettled([first, second]);
    expect(world.launches).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(["conflict_owner"]);
  });

  it("refuses a second writer when one conversation has no id and the other names the same journal", async () => {
    // The audit's §1 reproduction: row `c2` names the session, row `c1` does not
    // (its id was never resolved) but resumes the same journal. Keyed by stored
    // id — or by conversation id when there is none — those two launches had two
    // different keys and both wrote one session.
    const world = makeWorld();
    const nativeSessionId = "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e";
    world.seed({ id: "c1", nativeSessionId: null, nativeSessionPath: "/tmp/sessions/journal.jsonl" });
    world.seed({ id: "c2", nativeSessionId, nativeSessionPath: "/tmp/sessions/journal.jsonl" });
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    world.adapters.isSessionLive = async () => {
      await gate;
      return false;
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: boundedClock(), maxActive: 3, publishTimeoutMs: BOUNDED_POLL_MS });
    const first = supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project", resumeSessionPath: "/tmp/sessions/journal.jsonl" });
    const second = supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project", resumeSessionPath: "/tmp/sessions/journal.jsonl" });
    openGate();
    const results = await Promise.allSettled([first, second]);
    expect(world.launches).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(["conflict_owner"]);
  });

  it("retains failed launch ownership when injected guarded kill leaves process alive", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e" });
    world.seed({ id: "c2", state: "stopped" });
    world.seed({ id: "c3", state: "stopped" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: boundedClock(), maxActive: 2, publishTimeoutMs: 0 });
    world.breakStoreWrites(true);
    world.breakKills(true);
    await expect(
      supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project", resumeSessionPath: "/tmp/journal.jsonl" }),
    ).rejects.toThrow(/simulated store write failure/);
    expect(world.tmuxSessions).toHaveLength(1);
    expect((await world.store.getConversation("c1"))?.state).not.toBe("stopped");

    world.breakStoreWrites(false);
    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1-retry", cwd: "/tmp/project", resumeSessionPath: "/tmp/journal.jsonl" }))
      .rejects.toMatchObject({ code: "conflict_owner" });

    // Every later launch is refused while an unaccounted-for session exists, not
    // just a retry of this conversation. That is deliberate: a live process we
    // cannot attribute is exactly the state that lets a cap be exceeded, and the
    // only safe reading is "stop launching until a human accounts for it". An
    // unrelated conversation is therefore refused too, and with the same code, so
    // the reason in the message is what distinguishes them.
    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_owner",
    });
    await expect(supervisor.start("c3", { conversationId: "c3", name: "caw-c3", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_owner",
    });

    // The invariant that matters: the surviving process was never duplicated.
    expect(world.tmuxSessions).toHaveLength(1);
    expect(world.launches).toHaveLength(1);
  });
  // Before restart-aware orphan detection, a new supervisor lost the reservation and launched retry plus c2, exceeding maxActive 2.

  it("counts renamed sessions against maxActive and refuses another launch", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-runtime-renamed-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.seed({ id: "c2", state: "stopped" });
    world.seed({ id: "c3", state: "stopped" });
    world.adapters.listManagedTmux = async () => (await tmux.listManaged()).map(runtimeSession);
    world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      return runtimeSession(await tmux.launch({ name: spec.name, cwd: spec.cwd, args: ["30"] }));
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 2, publishTimeoutMs: 0 });

    try {
      const first = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: directory });
      await supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: directory });
      await execFileAsync("tmux", ["-S", socketPath, "rename-session", "-t", first.tmuxSessionId!, "renamed-out-of-prefix"]);

      await expect(supervisor.activeCount()).resolves.toMatchObject({ count: 2, known: true });
      await expect(supervisor.start("c3", { conversationId: "c3", name: "caw-c3", cwd: directory }))
        .rejects.toMatchObject({ code: "conflict_limit" });
      expect(await tmux.listManaged()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first.tmuxSessionId, name: "renamed-out-of-prefix", alive: true }),
      ]));
      expect(world.launches).toHaveLength(2);
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refuses launch after an untracked private-socket session becomes unreachable while a recorded pane lives", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-runtime-unlinked-launch-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.seed({ id: "c2", state: "stopped" });
    world.adapters.listManagedTmux = async () => (await tmux.listManaged()).map(runtimeSession);
    world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      return runtimeSession(await tmux.launch({ name: spec.name, cwd: spec.cwd, args: ["30"] }));
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1, publishTimeoutMs: 0 });
    let oldServerPid: number | null = null;
    let oldPanePid: number | null = null;
    let untrackedPanePid: number | null = null;
    try {
      const owned = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: directory });
      oldServerPid = Number(owned.tmuxServerIdentity!.split(":").at(-1));
      oldPanePid = owned.tmuxPanePid;
      const untracked = await tmux.launch({ name: "direct-untracked", cwd: directory, args: ["30"] });
      untrackedPanePid = untracked.panePid;
      expect(untrackedPanePid).not.toBeNull();
      expect(() => process.kill(untrackedPanePid!, 0)).not.toThrow();
      expect(await tmux.listManaged()).toHaveLength(2);

      await unlink(socketPath);
      expect(() => process.kill(untrackedPanePid!, 0)).not.toThrow();
      await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: directory }))
        .rejects.toMatchObject({ code: "conflict_owner", message: expect.stringMatching(/pane process .*still alive/i) });
      expect(oldServerPid).not.toBeNull();
      expect(oldPanePid).not.toBeNull();
      expect(() => process.kill(oldPanePid!, 0)).not.toThrow();
      expect(() => process.kill(oldServerPid!, 0)).not.toThrow();
      await expect(supervisor.activeCount()).resolves.toMatchObject({ count: 1, known: false, reason: expect.stringMatching(/untracked sessions on that unreachable server/i) });
      expect(world.launches).toHaveLength(1);
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      for (const pid of [untrackedPanePid, oldPanePid, oldServerPid]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The old server may already have reaped its pane process.
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows launch when the unseen recorded pane PID is ESRCH", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$9", tmuxServerIdentity: "old-private:1:9", tmuxPanePid: 1_000_000_000 });
    world.seed({ id: "c2", state: "stopped" });
    world.adapters.tmuxServerIdentity = async () => "new-private:2:10";
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1, publishTimeoutMs: 0 });

    const started = await supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" });

    expect(started.tmuxSessionId).toBeTruthy();
    expect(world.launches).toHaveLength(1);
  });

  it("fails closed when an unseen legacy row has no recorded pane PID", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$9", tmuxServerIdentity: "old-private:1:9", tmuxPanePid: null });
    world.seed({ id: "c2", state: "stopped" });
    world.adapters.tmuxServerIdentity = async () => "new-private:2:10";
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1 });

    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" }))
      .rejects.toMatchObject({ code: "conflict_owner", message: expect.stringMatching(/cannot be verified/i) });
    await expect(supervisor.activeCount()).resolves.toMatchObject({ known: false, reason: expect.stringMatching(/cannot be verified/i) });
    expect(world.launches).toHaveLength(0);
  });
  it("keeps normal launch-stop-launch lifecycle working with a private tmux socket", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-runtime-happy-lifecycle-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.adapters.listManagedTmux = async () => (await tmux.listManaged()).map(runtimeSession);
    world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
    world.adapters.killTmux = async (id, identity) => tmux.kill(id, { expectedIdentity: identity });
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      return runtimeSession(await tmux.launch({ name: spec.name, cwd: spec.cwd, args: ["30"] }));
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1, publishTimeoutMs: 0 });

    try {
      const first = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1-first", cwd: directory });
      expect(first.tmuxSessionId).toBeTruthy();
      expect(await supervisor.stop("c1")).toMatchObject({ state: "stopped" });
      const second = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1-second", cwd: directory });
      expect(second.tmuxSessionId).toBeTruthy();
      expect(world.launches).toHaveLength(2);
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("blocks cap overrun after backend restart with a surviving private-tmux process", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-runtime-restart-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e" });
    world.seed({ id: "c2", state: "stopped" });
    world.seed({ id: "c3", state: "stopped" });
    world.adapters.listManagedTmux = async () => (await tmux.listManaged()).map(runtimeSession);
    world.adapters.getTmux = async (id) => {
      try {
        const session = await tmux.getById(id);
        return { ok: true, session: session ? runtimeSession(session) : null };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    };
    world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      return runtimeSession(await tmux.launch({ name: spec.name, cwd: spec.cwd, args: ["30"] }));
    };
    world.adapters.killTmux = async () => { throw new Error("injected guarded kill failure"); };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: boundedClock(), maxActive: 2, publishTimeoutMs: 0 });

    try {
      world.breakStoreWrites(true);
      await expect(
        supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: directory, resumeSessionPath: "/tmp/journal.jsonl" }),
      ).rejects.toThrow(/simulated store write failure/);
      const survivors = await tmux.listManaged();
      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.alive).toBe(true);

      // New supervisor and store object model backend restart; tmux and metadata survive.
      world.breakStoreWrites(false);
      const restartedStore: ConversationRuntimeStore = { ...world.store };
      const restarted = createSupervisor({ store: restartedStore, adapters: world.adapters, clock: instantClock, maxActive: 2, publishTimeoutMs: 0 });
      await expect(restarted.start("c1", { conversationId: "c1", name: "caw-c1-retry", cwd: directory, resumeSessionPath: "/tmp/journal.jsonl" }))
        .rejects.toMatchObject({ code: "conflict_owner" });
      await expect(restarted.start("c2", { conversationId: "c2", name: "caw-c2", cwd: directory }))
        .rejects.toMatchObject({ code: "conflict_owner" });
      await expect(restarted.start("c3", { conversationId: "c3", name: "caw-c3", cwd: directory }))
        .rejects.toMatchObject({ code: "conflict_owner" });
      await expect(restarted.activeCount()).resolves.toMatchObject({ count: 1, known: true });
      expect(await tmux.listManaged()).toHaveLength(1);
      expect(world.launches).toHaveLength(1);
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores a resume path after publish timeout to block a sequential alias", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.seed({ id: "c2" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
    const resumeSessionPath = "/tmp/journal.jsonl";
    const first = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project", resumeSessionPath });
    expect(first.nativeSessionPath).toBe(resumeSessionPath);
    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project", resumeSessionPath }))
      .rejects.toMatchObject({ code: "conflict_owner" });
    expect(world.launches).toHaveLength(1);
    expect(world.tmuxSessions).toHaveLength(1);
  });
  it("keeps a timed-out unpublished writer's journal claimed after the reservation ends", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.seed({ id: "c2" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
    const journal = "/tmp/journal.jsonl";
    await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project", resumeSessionPath: journal });
    expect(world.hosts).toHaveLength(0);
    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project", resumeSessionPath: journal }))
      .rejects.toMatchObject({ code: "conflict_owner" });
    expect(world.launches).toHaveLength(1);
    expect(world.tmuxSessions).toHaveLength(1);
  });

  it("reserves maxActive slot for concurrent launches of different sessions", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "stopped", nativeSessionId: "session-1" });
    world.seed({ id: "c2", state: "stopped", nativeSessionId: "session-2" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1, publishTimeoutMs: 0 });
    const results = await Promise.allSettled([
      supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" }),
      supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" }),
    ]);
    expect(world.launches).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toEqual(["conflict_limit"]);
  });
  it("launches, then records the room the agent published", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishPollMs: 0 });

    // The launch is what publishes the room in the real system; emulate that.
    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      world.hosts.push({
        instanceId: "inst-1",
        generation: 1,
        pid: session.panePid ?? 1,
        sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
        cwd: spec.cwd,
        model: "provider/model",
        participants: 1,
        relayConnected: true,
        inputRequired: false,
        busy: true,
        access: "control",
      });
      return session;
    };

    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });

    expect(result.tmuxSessionId).toBe("$1");
    expect(result.hostInstanceId).toBe("inst-1");
    expect(result.nativeSessionId).toBe("01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e");
    expect(result.state).toBe("running");
    expect(world.launches).toHaveLength(1);
    expect(world.events.map((e) => e.type)).toEqual(["agent.launched", "agent.hosted"]);
    expect(result.tmuxServerIdentity).toBe("private-socket:1");
  });

  it("does not invent a room generation when the listing omits it", async () => {
    // The mint guard compares a link's generation against the listing's. If an
    // omitted field became `1`, that comparison would pass by construction and a
    // rotated room could be handed out as the conversation the user opened.
    // A previously recorded generation is what an omission must not erase.
    const world = makeWorld();
    world.seed({ id: "c1", hostInstanceId: "inst-1", hostGeneration: 5 });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishPollMs: 0 });

    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      world.hosts.push({
        instanceId: "inst-1",
        generation: null,
        pid: session.panePid ?? 1,
        sessionId: "sess-1",
        cwd: spec.cwd,
        model: null,
        participants: null,
        relayConnected: null,
        inputRequired: null,
        busy: true,
        access: "control",
      });
      return session;
    };

    await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });

    const conversation = await world.store.getConversation("c1");
    // Never `1`: an unreported generation must not become a value the mint guard
    // could compare against, and it must not erase the one already recorded.
    expect(conversation?.hostGeneration).not.toBe(1);
    expect(conversation?.hostGeneration).toBe(5);
    expect(conversation?.hostInstanceId).toBe("inst-1");
  });

  it("refuses to launch when the registry reports a room for the session, and starts nothing", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e" });
    world.hosts.push({
      instanceId: "inst-x",
      generation: 1,
      pid: 999,
      sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
      cwd: "/tmp/project",
      model: null,
      participants: 1,
      relayConnected: true,
      inputRequired: false,
      busy: false,
      access: "control",
    });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_owner",
    });
    expect(world.launches).toHaveLength(0);
    expect(world.events.map((e) => e.type)).toEqual(["launch.refused"]);
  });

  it("refuses to launch when the writer lease is held, so history cannot be forked", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e" });
    world.setLease(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_owner",
    });
    expect(world.launches).toHaveLength(0);
  });

  it("refuses to launch when the lease cannot be determined", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "01a16ed6" });
    world.setLease("unknown");
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_owner",
    });
  });

  it("refuses past the concurrency cap without launching", async () => {
    const world = makeWorld();
    // Slots are counted from live processes, so the occupying conversations must
    // actually have one — a stored state alone is not evidence of a running agent.
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.seed({ id: "c2", state: "idle", tmuxSessionId: "$2", tmuxSessionName: "caw-c2", tmuxServerIdentity: "private-socket:1" });
    world.seed({ id: "c3", state: "stopped" });
    world.tmuxSessions.push(
      { id: "$1", name: "caw-c1", alive: true, panePid: 11, serverIdentity: "private-socket:1" },
      { id: "$2", name: "caw-c2", alive: true, panePid: 12, serverIdentity: "private-socket:1" },
    );
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 2 });

    // Two agents already run and the cap is two, so a third conversation is refused.
    await expect(supervisor.start("c3", { conversationId: "c3", name: "caw-c3", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_limit",
    });
    expect(world.launches).toHaveLength(0);
  });

  it("counts a live process even when its stored state is unknown", async () => {
    // The audit's §9 reproduction: the occupying row said `unknown`, so it was
    // skipped by the state filter and the cap admitted a second agent.
    const world = makeWorld();
    world.seed({ id: "c1", state: "unknown", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.seed({ id: "c2", state: "stopped" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 11, serverIdentity: "private-socket:1" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1 });

    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_limit",
    });
    expect(world.launches).toHaveLength(0);
  });

  it("refuses launch and reports unknown count when permission-denied enumeration masks a live session", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "stopped" });
    world.seed({ id: "c2", state: "stopped" });
    world.tmuxSessions.push({ id: "$0", name: "caw-existing", alive: true, panePid: 41, serverIdentity: "private-socket:1" });
    world.adapters.listManagedTmux = async () => { throw new Error("error connecting to /tmp/private.sock (Permission denied)"); };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1 });
    await expect(supervisor.activeCount()).resolves.toMatchObject({ known: false, reason: expect.stringMatching(/could not be enumerated/i) });
    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "conflict_limit",
      message: expect.stringMatching(/could not be enumerated/i),
    });
    expect(world.launches).toHaveLength(0);
    expect(world.tmuxSessions).toHaveLength(1);
  });

  it("frees a slot when the recorded process is gone, instead of blocking forever", async () => {
    // A stored `running` state goes stale the moment the process exits, and nothing
    // polls in the background. If the cap trusted that state, every later launch
    // would be refused with conflict_limit and the app would be permanently wedged.
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$9", tmuxSessionName: "caw-dead", tmuxServerIdentity: "private-socket:1", tmuxPanePid: 1_000_000_000 });
    world.seed({ id: "c2", state: "stopped" });
    // `$9` is absent from the tmux list; ESRCH proves the recorded pane process is gone.
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 1, publishTimeoutMs: 0 });

    const started = await supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" });
    expect(started.tmuxSessionId).toBeTruthy();
    expect(world.launches).toHaveLength(1);
  });

  it("refuses to launch when the registry is unreadable rather than assuming it is safe", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "01a16ed6" });
    world.breakRegistry(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" })).rejects.toMatchObject({
      code: "registry_unreadable",
    });
    expect(world.launches).toHaveLength(0);
  });

  it("reports an agent that exits during startup as an error, not as idle", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      // The process dies before it ever hosts a room.
      world.tmuxSessions.splice(0, world.tmuxSessions.length);
      return session;
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishPollMs: 0 });
    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
    expect(result.state).toBe("error");
    expect(world.events.map((e) => e.type)).toContain("agent.exited");
  });

  it("adopts only the room it launched, never a stranger's room in the same directory", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });

    // An unrelated agent is already hosting in the very directory we are about to
    // use. Adopting it would point this conversation at somebody else's session.
    world.hosts.push({
      instanceId: "stranger",
      generation: 1,
      pid: 111,
      sessionId: "01a1ffff-0000-0000-0000-000000000000",
      cwd: "/tmp/project",
      model: null,
      participants: 1,
      relayConnected: true,
      inputRequired: false,
      busy: false,
      access: "control",
    });

    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      world.hosts.push({
        instanceId: "ours",
        generation: 1,
        pid: session.panePid ?? 2,
        sessionId: "01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e",
        cwd: spec.cwd,
        model: null,
        participants: 1,
        relayConnected: true,
        inputRequired: false,
        busy: false,
        access: "control",
      });
      return session;
    };

    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishPollMs: 0 });
    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });

    expect(result.hostInstanceId).toBe("ours");
    expect(result.nativeSessionId).toBe("01a16ed6-2ebb-7609-a2a2-e76d0d8dd06e");
    expect(result.hostInstanceId).not.toBe("stranger");
  });

  it("reports unknown rather than idle when publish registry polling fails", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      world.breakRegistry(true);
      return session;
    };
    let now = 0;
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => (now += 100), sleep: async () => {} },
      maxActive: 3,
      publishTimeoutMs: 200,
      publishPollMs: 0,
    });
    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
    expect(result.state).toBe("unknown");
    expect(result.statusDetail).toMatch(/registry could not be read/i);
  });
  it("keeps startup publication unknown when host busy signal is absent", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      world.hosts.push({
        instanceId: "inst-unknown",
        generation: 1,
        pid: session.panePid ?? 1,
        sessionId: "session-unknown",
        cwd: spec.cwd,
        model: null,
        participants: 1,
        relayConnected: true,
        inputRequired: false,
        busy: null,
        access: "control",
      });
      return session;
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishPollMs: 0 });
    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
    expect(result.state).toBe("unknown");
    expect(result.statusDetail).toMatch(/does not report turn state/i);
  });
  it("reports a publish timeout honestly instead of claiming success or failure", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    // A clock that runs out immediately: the deadline is already passed on entry.
    let t = 0;
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => (t += 100_000), sleep: async () => {} },
      maxActive: 3,
      publishTimeoutMs: 1_000,
      publishPollMs: 0,
    });

    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
    expect(result.state).toBe("idle");
    expect(result.statusDetail).toMatch(/has not shared its session/i);
    expect(world.events.map((e) => e.type)).toContain("agent.publish_timeout");
  });
});

describe("supervisor.stop", () => {
  it("kills by recorded tmux id and settles to stopped", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxPanePid: process.pid, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$4", name: "caw-c1", alive: true, panePid: 321, serverIdentity: "private-socket:1" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const result = await supervisor.stop("c1");
    expect(world.kills).toEqual(["$4"]);
    expect(result.state).toBe("stopped");
  });
  it("refuses stop when recorded tmux server identity differs", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "old-socket:1:10" });
    world.tmuxSessions.push({ id: "$0", name: "caw-stranger", alive: true, panePid: 900, serverIdentity: "private-socket:2:20" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    await expect(supervisor.stop("c1")).rejects.toMatchObject({ code: "agent_not_running" });
    expect(world.kills).toHaveLength(0);
    expect(world.tmuxSessions[0]?.name).toBe("caw-stranger");
  });

  it("does not confirm stop after real private-tmux restart between identity and session probes", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-stop-restart-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    let restarted = false;
    try {
      const ours = await tmux.launch({ name: "stop-ours", cwd: directory, args: ["30"] });
      const world = makeWorld();
      world.seed({ id: "c1", state: "running", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity });
      world.adapters.killTmux = async () => {};
      world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
      world.adapters.getTmux = async (id) => {
        if (!restarted) {
          restarted = true;
          await execFileAsync("tmux", ["-S", socketPath, "kill-server"]);
          const { stdout } = await execFileAsync("tmux", ["-S", socketPath, "new-session", "-d", "-P", "-F", "#{session_id}", "-s", "caw-stop-stranger", "-c", directory, "sleep", "30"]);
          const strangerId = stdout.trim();
          await execFileAsync("tmux", ["-S", socketPath, "set-window-option", "-t", strangerId, "remain-on-exit", "on"]);
          await execFileAsync("tmux", ["-S", socketPath, "send-keys", "-t", strangerId, "C-c"]);
        }
        try {
          const session = await tmux.getById(id);
          return { ok: true, session: session ? runtimeSession(session) : null };
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      };
      let t = 0;
      const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: { now: () => t, sleep: async () => { t += 250; } }, maxActive: 3 });
      const result = await supervisor.stop("c1", 1_000);
      const stranger = (await tmux.listManaged()).find((session) => session.id === ours.id);
      expect(restarted).toBe(true);
      expect(stranger).toMatchObject({ alive: false, serverIdentity: expect.not.stringMatching(ours.serverIdentity) });
      expect(result.state).toBe("stopping");
      expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not report stopped when tmux restarts between identity and session reads", async () => {
    // Before the identity bracket and returned-row check, dead replacement-server `$0` passed the !alive test and was reported stopped.
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxPanePid: null, tmuxServerIdentity: "old-socket:1:10" });
    world.adapters.killTmux = async () => {};
    const stranger: RuntimeTmuxSession = { id: "$0", name: "caw-stranger", alive: false, panePid: 901, serverIdentity: "new-socket:2:20" };
    let restartedBetweenReads = false;
    world.adapters.tmuxServerIdentity = async () => restartedBetweenReads ? "new-socket:2:20" : "old-socket:1:10";
    world.adapters.getTmux = async () => {
      // First poll identity was old. Restart immediately before getTmux and reissue `$0`.
      restartedBetweenReads = true;
      world.tmuxSessions.splice(0, world.tmuxSessions.length, stranger);
      return { ok: true, session: stranger };
    };
    let t = 0;
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => t, sleep: async () => { t += 250; } },
      maxActive: 3,
    });
    const result = await supervisor.stop("c1", 1_000);
    expect(restartedBetweenReads).toBe(true);
    expect(result.state).toBe("stopping");
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
    expect(world.tmuxSessions[0]).toMatchObject({ id: "$0", alive: false, serverIdentity: "new-socket:2:20" });
  });

  it("refuses stop when the recorded server is live but its socket pathname was unlinked", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-stop-unlinked-precheck-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    let serverPid: number | null = null;
    let panePid: number | null = null;
    try {
      const ours = await tmux.launch({ name: "stop-unlinked-precheck", cwd: directory, args: ["30"] });
      serverPid = Number(ours.serverIdentity.split(":").at(-1));
      panePid = ours.panePid;
      const world = makeWorld();
      world.seed({ id: "c1", state: "running", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
      const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
      await unlink(socketPath);

      const result = await supervisor.stop("c1");
      expect(result.state).toBe("stopping");
      expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
      expect(() => process.kill(serverPid!, 0)).not.toThrow();
      expect(panePid).not.toBeNull();
      expect(() => process.kill(panePid!, 0)).not.toThrow();
    } finally {
      for (const pid of [panePid, serverPid]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The tmux server may already have reaped its pane process.
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not stop a live tmux server when its socket pathname disappears during polling", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-stop-unlinked-poll-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    let serverPid: number | null = null;
    let panePid: number | null = null;
    try {
      const ours = await tmux.launch({ name: "stop-unlinked-poll", cwd: directory, args: ["30"] });
      serverPid = Number(ours.serverIdentity.split(":").at(-1));
      panePid = ours.panePid;
      const world = makeWorld();
      world.seed({ id: "c1", state: "running", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
      world.adapters.killTmux = async () => { await unlink(socketPath); };
      let t = 0;
      const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: {
        now: () => t,
        sleep: async (ms) => { t += ms; },
      }, maxActive: 3 });

      const result = await supervisor.stop("c1", 500);
      expect(result.state).toBe("stopping");
      expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
      expect(() => process.kill(serverPid!, 0)).not.toThrow();
      expect(panePid).not.toBeNull();
      expect(() => process.kill(panePid!, 0)).not.toThrow();
    } finally {
      for (const pid of [panePid, serverPid]) {
        if (!pid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // The tmux server may already have reaped its pane process.
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops after the recorded private tmux server process exits", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-stop-gone-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    try {
      const ours = await tmux.launch({ name: "stop-gone", cwd: directory, args: ["30"] });
      const serverPid = Number(ours.serverIdentity.split(":").at(-1));
      const world = makeWorld();
      world.seed({ id: "c1", state: "running", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
      world.adapters.killTmux = async (id, identity) => tmux.kill(id, { expectedIdentity: identity });
      const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: {
        now: () => Date.now(),
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      }, maxActive: 3 });
      const result = await supervisor.stop("c1", 5_000);
      expect(result.state).toBe("stopped");
      expect(() => process.kill(serverPid, 0)).toThrow();
      expect(world.events.map((event) => event.type)).toContain("agent.stopped");
    } finally {
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("settles stop when the real pane PID exits and the tmux server vanishes", async (ctx) => {
    try {
      await execFileAsync("tmux", ["-V"]);
    } catch {
      ctx.skip();
      return;
    }
    const directory = await mkdtemp(path.join(homedir(), ".cache", "caw-stop-pre-gone-"));
    const socketPath = path.join(directory, "tmux.sock");
    const tmux = new DefaultTmuxService({ socketPath, ompBinary: "sleep" });
    let panePid: number | null = null;
    try {
      const ours = await tmux.launch({ name: "stop-pre-gone", cwd: directory, args: ["30"] });
      panePid = ours.panePid;
      const world = makeWorld();
      world.seed({ id: "c1", state: "running", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]);
      if (panePid !== null) await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const result = await createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 }).stop("c1");
      expect(result.state).toBe("stopped");
      expect(world.events.map((event) => event.type)).toContain("agent.stopped");
    } finally {
      if (panePid) {
        try {
          process.kill(panePid, "SIGTERM");
        } catch {
          // The server shutdown may already have reaped the pane process.
        }
      }
      await execFileAsync("tmux", ["-S", socketPath, "kill-server"]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps stop pending when the socket is unreachable but pane process lives", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxPanePid: process.pid, tmuxServerIdentity: `private-socket:1:${process.pid}` });
    world.adapters.tmuxServerIdentity = async () => null;
    let t = 0;
    const result = await createSupervisor({ store: world.store, adapters: world.adapters, clock: { now: () => t, sleep: async () => { t += 250; } }, maxActive: 3 }).stop("c1", 500);
    expect(result.state).toBe("stopping");
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
  });

  it("keeps legacy rows without a pane PID pending when the socket is unreachable", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxServerIdentity: "private-socket:1", tmuxPanePid: null });
    world.adapters.tmuxServerIdentity = async () => null;
    let t = 0;
    const result = await createSupervisor({ store: world.store, adapters: world.adapters, clock: { now: () => t, sleep: async () => { t += 250; } }, maxActive: 3 }).stop("c1", 500);
    expect(result.state).toBe("stopping");
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
  });

  it("settles stopped when recorded pane PID has exited and socket is unreachable", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxServerIdentity: "private-socket:1", tmuxPanePid: 1_000_000_000 });
    world.adapters.tmuxServerIdentity = async () => null;
    const result = await createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 }).stop("c1");
    expect(result.state).toBe("stopped");
    expect(world.events.map((event) => event.type)).toContain("agent.stopped");
  });

  it("treats confirmed absence on the same server identity as stopped", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.adapters.killTmux = async () => {};
    world.adapters.getTmux = async () => ({ ok: true, session: null });
    let t = 0;
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: { now: () => t, sleep: async () => { t += 250; } }, maxActive: 3 });
    const result = await supervisor.stop("c1", 1_000);
    expect(result.state).toBe("stopped");
  });


  it("keeps waiting when server identity probe fails", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$4", name: "caw-c1", alive: true, panePid: 321, serverIdentity: "private-socket:1" });
    world.adapters.killTmux = async () => {};
    let identityReads = 0;
    world.adapters.tmuxServerIdentity = async () => ++identityReads === 1 ? "private-socket:1" : (() => { throw new Error("EACCES"); })();
    let t = 0;
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => t, sleep: async () => { t += 250; } },
      maxActive: 3,
    });

    const result = await supervisor.stop("c1", 1_000);
    expect(result.state).toBe("stopping");
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
  });
  it("does not confirm stop when the session probe could not run", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.adapters.killTmux = async () => {};
    world.breakTmuxProbe(true);
    let t = 0;
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => t, sleep: async () => { t += 250; } },
      maxActive: 3,
    });

    const result = await supervisor.stop("c1", 1_000);
    expect(result.state).toBe("stopping");
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
  });

  it("refuses to stop an agent it does not own", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", ownership: "external", tmuxSessionId: "$9", tmuxServerIdentity: "private-socket:1" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.stop("c1")).rejects.toMatchObject({ code: "agent_not_running" });
    expect(world.kills).toHaveLength(0);
  });

  it("refuses to stop a conversation with no managed process", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "stopped" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.stop("c1")).rejects.toMatchObject({ code: "agent_not_running" });
  });

  it("reports a stop that does not complete as still stopping, and says so", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$5", tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$5", name: "caw-c1", alive: true, panePid: 900, serverIdentity: "private-socket:1" });
    // A kill that does not actually remove the session, plus an instant deadline.
    world.adapters.killTmux = async () => {};
    let t = 0;
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => (t += 100_000), sleep: async () => {} },
      maxActive: 3,
    });

    const result = await supervisor.stop("c1", 1_000);
    expect(result.state).toBe("stopping");
    expect(result.statusDetail).toMatch(/has not exited/i);
    expect(world.events.map((e) => e.type)).toContain("agent.stop_timeout");
  });
});

describe("supervisor.reconcile", () => {
  it("adopts a live managed process with its room", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "starting", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1", nativeSessionId: "sess-1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 42, serverIdentity: "private-socket:1" });
    world.hosts.push({
      instanceId: "inst-1",
      generation: 2,
      pid: 42,
      sessionId: "sess-1",
      cwd: "/tmp/project",
      model: "provider/model",
      participants: 1,
      relayConnected: true,
      inputRequired: false,
      busy: false,
      access: "control",
    });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const report = await supervisor.reconcile();
    expect(report.adopted).toBe(1);
    expect(report.registered).toBe(1);
    const conversation = await world.store.getConversation("c1");
    expect(conversation?.hostInstanceId).toBe("inst-1");
    expect(conversation?.hostGeneration).toBe(2);
    expect(conversation?.state).toBe("idle");
  });

  it("marks a room we never launched as external so we never try to stop it", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "sess-9" });
    world.hosts.push({
      instanceId: "inst-9",
      generation: 1,
      pid: 77,
      sessionId: "sess-9",
      cwd: "/tmp/project",
      model: null,
      participants: 1,
      relayConnected: true,
      inputRequired: false,
      busy: true,
      access: "control",
    });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const report = await supervisor.reconcile();
    expect(report.external).toBe(1);
    const conversation = await world.store.getConversation("c1");
    expect(conversation?.ownership).toBe("external");
    expect(conversation?.state).toBe("running");
  });

  it("does not invent the generation of an external room whose listing omits it", async () => {
    // The same rule as the start path: a room admitted as external keeps the
    // generation we already recorded rather than gaining an unobserved one.
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "sess-9", hostGeneration: 4 });
    world.hosts.push({
      instanceId: "inst-9",
      generation: null,
      pid: 77,
      sessionId: "sess-9",
      cwd: "/tmp/project",
      model: null,
      participants: 1,
      relayConnected: true,
      inputRequired: false,
      busy: true,
      access: "control",
    });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await supervisor.reconcile();

    const conversation = await world.store.getConversation("c1");
    expect(conversation?.hostGeneration).not.toBe(1);
    expect(conversation?.hostGeneration).toBe(4);
    expect(conversation?.hostInstanceId).toBe("inst-9");
  });

  it("does not mark anything stopped when the registry is unreadable", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 42, serverIdentity: "private-socket:1" });
    world.breakRegistry(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await supervisor.reconcile();
    const conversation = await world.store.getConversation("c1");
    // A live process is a live process: a registry failure must not erase that.
    expect(conversation?.state).not.toBe("stopped");
  });

  it("does not adopt a reused tmux id from a restarted server", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-owned", tmuxPanePid: process.pid, tmuxServerIdentity: "old-socket:1:10" });
    world.tmuxSessions.push({ id: "$0", name: "caw-stranger", alive: true, panePid: 900, serverIdentity: "private-socket:2:20" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    const report = await supervisor.reconcile();
    expect(report.unknown).toBe(1);
    expect(report.adopted).toBe(0);
    expect((await world.store.getConversation("c1"))?.state).toBe("unknown");
    expect((await world.store.getConversation("c1"))?.statusDetail).toMatch(/pane process .* is still alive/i);
    expect(world.tmuxSessions[0]?.name).toBe("caw-stranger");
    await expect(supervisor.stop("c1")).rejects.toMatchObject({ code: "agent_not_running" });
    expect(world.kills).toHaveLength(0);
  });

  it("flags a session written by a foreign process as unknown", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "sess-2" });
    world.setLease(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    const report = await supervisor.reconcile();
    expect(report.unknown).toBe(1);
    const conversation = await world.store.getConversation("c1");
    expect(conversation?.state).toBe("unknown");
  });

  it("reports a dead process with surviving history as stopped", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$8", tmuxSessionName: "caw-gone", tmuxServerIdentity: "private-socket:1", tmuxPanePid: 1_000_000_000 });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const report = await supervisor.reconcile();
    expect(report.stopped).toBe(1);
    const conversation = await world.store.getConversation("c1");
    expect(conversation?.state).toBe("stopped");
    expect(world.kills).toHaveLength(0);
  });

  it("does not mark anything stopped when the tmux enumeration fails", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 42, serverIdentity: "private-socket:1" });
    world.breakTmuxList(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const report = await supervisor.reconcile();
    expect(report.stopped).toBe(0);
    expect(report.unknown).toBe(1);
    const conversation = await world.store.getConversation("c1");
    expect(conversation?.state).toBe("unknown");
    expect(conversation?.statusDetail).toMatch(/tmux session list could not be read/i);
  });
});

describe("supervisor.activeCount", () => {
  it("counts a confirmed-live process whatever label its row carries", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "unknown", tmuxSessionId: "$1", tmuxServerIdentity: "private-socket:1" });
    world.seed({ id: "c2", state: "running", tmuxSessionId: "$2", tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push(
      { id: "$1", name: "caw-c1", alive: true, panePid: 11, serverIdentity: "private-socket:1" },
      { id: "$2", name: "caw-c2", alive: false, panePid: 12, serverIdentity: "private-socket:1" },
    );
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.activeCount()).resolves.toEqual({ count: 1, known: true, reason: null });
  });

  it("reports the count as unknown when the enumeration fails", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$1", tmuxServerIdentity: "private-socket:1" });
    world.breakTmuxList(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const snapshot = await supervisor.activeCount();
    expect(snapshot.known).toBe(false);
    expect(snapshot.reason).toMatch(/could not be enumerated/i);
  });
});

describe("supervisor.refresh", () => {
  it("does not append events for an unchanged state, so polling cannot flood the log", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "stopped", tmuxSessionId: "$8", tmuxServerIdentity: "private-socket:1" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await supervisor.refresh("c1");
    const first = await world.store.getConversation("c1");
    await supervisor.refresh("c1");
    const second = await world.store.getConversation("c1");

    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(world.events).toHaveLength(0);
  });

  it("returns null for an unknown conversation instead of inventing one", async () => {
    const world = makeWorld();
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    expect(await supervisor.refresh("nope")).toBeNull();
  });

  it("keeps the state unknown, not error, when the journal probe fails", async () => {
    // The audit's §5 reproduction: a probe that threw was read as "the history is
    // gone" and written to the store as `error`.
    const world = makeWorld();
    world.seed({
      id: "c1",
      state: "running",
      nativeSessionId: "sess-1",
      nativeSessionPath: "/tmp/journal.jsonl",
      tmuxSessionId: "$8",
      tmuxSessionName: "caw-gone",
      tmuxServerIdentity: "private-socket:1",
      tmuxPanePid: 1_000_000_000,
    });
    world.adapters.sessionPathExists = async () => {
      throw new Error("EACCES: permission denied");
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const conversation = await supervisor.refresh("c1");
    expect(conversation?.state).toBe("unknown");
    expect(conversation?.state).not.toBe("error");
    expect(conversation?.statusDetail).toMatch(/EACCES/);
  });

  it("still reports error when the journal is confirmed absent", async () => {
    const world = makeWorld();
    world.seed({
      id: "c1",
      state: "running",
      nativeSessionId: "sess-1",
      nativeSessionPath: "/tmp/journal.jsonl",
      tmuxSessionId: "$8",
      tmuxSessionName: "caw-gone",
      tmuxServerIdentity: "private-socket:1",
      tmuxPanePid: 1_000_000_000,
    });
    world.adapters.sessionPathExists = async () => false;
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const conversation = await supervisor.refresh("c1");
    expect(conversation?.state).toBe("error");
  });

  it("keeps the state unknown, not stopped, when the tmux enumeration fails", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.breakTmuxList(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const conversation = await supervisor.refresh("c1");
    expect(conversation?.state).toBe("unknown");
    expect(conversation?.state).not.toBe("stopped");
    expect(conversation?.statusDetail).toMatch(/tmux session list could not be read/i);
  });
});
