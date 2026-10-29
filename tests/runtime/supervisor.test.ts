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

/**
 * A published host row. `pid` and `sessionId` are the identity the stop gate
 * verifies: a pane is only ours when exactly one published host descends from
 * it and serves the native session we recorded.
 */
function hostRow(over: Partial<RuntimeHost> & { pid: number | null; sessionId: string }): RuntimeHost {
  return {
    instanceId: `host-${over.sessionId}`,
    generation: 1,
    cwd: "/tmp/project",
    model: null,
    participants: 1,
    relayConnected: true,
    inputRequired: false,
    busy: false,
    access: "control",
    ...over,
  };
}

/** A controllable world: tmux sessions, rooms, leases, and a journal of events. */
function makeWorld() {
  const tmuxSessions: RuntimeTmuxSession[] = [];
  const hosts: RuntimeHost[] = [];
  let lease: boolean | "unknown" = false;
  let registryThrows = false;
  let tmuxListThrows = false;
  let storeWriteThrows = false;
  let killThrows = false;
  let recordEventThrows = false;
  let nextId = 1;
  let tmuxServerIdentity: string | null = "private-socket:1";

  const events: Array<{ conversationId: string; type: string; payload: unknown; seq: number }> = [];
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
      return { ok: true as const, session: tmuxSessions.find((session) => session.id === id) ?? null };
    },
    async isProcessDescendant(candidatePid, panePid) {
      return candidatePid === panePid;
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
  const reserved = new Set<string>();
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
    async updateConversationIfCurrent(id, expectedEpoch, patch) {
      const current = conversations.get(id);
      if (!current) return null;
      if ((current.lifecycleEpoch ?? 0) !== expectedEpoch) return { conversation: current, applied: false };
      if (storeWriteThrows) throw new Error("simulated store write failure after tmux launch");
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      conversations.set(id, next);
      return { conversation: next, applied: true };
    },
    async recordEvent(conversationId, type, payload) {
      if (recordEventThrows) throw new Error("simulated journal failure");
      const event = { conversationId, type, payload, seq: events.filter((item) => item.conversationId === conversationId).length + 1 };
      events.push(event);
      return event;
    },
    async reserveLaunch(id: string) {
      if (!conversations.has(id)) return false;
      reserved.add(id);
      return true;
    },
    releaseLaunch(id: string) {
      reserved.delete(id);
    },
    isLaunchReserved(id: string) {
      return reserved.has(id);
    },
  };

  function seed(over: Partial<Conversation> = {}): Conversation {
    const managedPane = over.ownership !== "external" && Boolean(over.tmuxSessionId);
    const managedSession = over.tmuxSessionId ? tmuxSessions.find((session) => session.id === over.tmuxSessionId) : undefined;
    const panePid = over.tmuxPanePid !== undefined ? over.tmuxPanePid : managedSession?.panePid ?? null;
    const nativeSessionId = over.nativeSessionId ?? (managedPane ? `native-${over.id ?? "c1"}` : null);
    const conversation: Conversation = {
      id: over.id ?? "c1",
      projectId: "p1",
      nativeSessionPath: null,
      title: "conversation",
      model: null,
      ownership: "managed",
      state: "starting",
      tmuxSessionId: null,
      tmuxSessionName: null,
      tmuxServerIdentity: null,
      hostInstanceId: null,
      hostGeneration: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: null,
      statusDetail: null,
      ...over,
      tmuxPanePid: panePid,
      nativeSessionId,
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
    breakStoreWrites: (value: boolean) => {
      storeWriteThrows = value;
    },
    breakRecordEvents: (value: boolean) => {
      recordEventThrows = value;
    },
    breakKills: (value: boolean) => {
      killThrows = value;
    },
    setServerIdentity: (value: string | null) => {
      tmuxServerIdentity = value;
    },
    /** Drop a row the way a committed project delete does. */
    removeRow: (conversationId: string) => {
      conversations.delete(conversationId);
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
    world.seed({ id: "c1", nativeSessionId: "native-c1" });
    world.adapters.listManagedTmux = async () => (await tmux.listManaged()).map(runtimeSession);
    world.adapters.getTmux = async (id) => {
      try {
        const session = await tmux.getById(id);
        return { ok: true as const, session: session ? runtimeSession(session) : null };
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
      }
    };
    world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
    world.adapters.killTmux = async (id, identity) => {
      await tmux.kill(id, { expectedIdentity: identity });
      // A killed pane publishes no room, so its host row goes with it. Leaving it
      // behind would make the restart look like a live stranger's process.
      world.hosts.splice(0, world.hosts.length);
    };
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      const session = runtimeSession(await tmux.launch({ name: spec.name, cwd: spec.cwd, args: ["30"] }));
      // Ownership is verifiable only when the published host descends from the pane.
      world.hosts.splice(0, world.hosts.length, hostRow({ pid: session.panePid, sessionId: "native-c1" }));
      return session;
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
      // The process dies before it ever hosts a room. The pane PID is pinned out of
      // reach so "exited" is a fact rather than an accident of which PIDs exist.
      session.panePid = 1_000_000_000;
      world.tmuxSessions.splice(0, world.tmuxSessions.length);
      return session;
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishPollMs: 0 });
    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
    expect(result.state).toBe("error");
    expect(world.events.map((e) => e.type)).toContain("agent.exited");
  });

  it("keeps waiting for a launch whose pane is missing while its PID is alive", async () => {
    // The session list loses our `$N` right after launch, but the pane process the
    // launch recorded is this very process: that is an unverified observation, not
    // an exit, so the startup must not claim `error` or `agent.exited`.
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      const session: RuntimeTmuxSession = { id: "$1", name: spec.name, alive: true, panePid: process.pid, serverIdentity: "private-socket:1" };
      world.tmuxSessions.push(session);
      world.tmuxSessions.splice(0, world.tmuxSessions.length);
      return session;
    };
    let now = 0;
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => (now += 1_000), sleep: async () => {} },
      maxActive: 3,
      publishTimeoutMs: 5_000,
      publishPollMs: 0,
    });

    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });

    expect(result.state).not.toBe("error");
    expect(world.events.some((e) => e.type === "agent.exited")).toBe(false);
  });

  it("adopts only the room it launched, never a stranger's room in the same directory", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });

    // A second process publishes into the same cwd after the launch begins, with
    // a larger PID. PID order must not let it steal this conversation.
    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      world.hosts.push({
        instanceId: "stranger",
        generation: 1,
        pid: 99_999,
        sessionId: "01a1ffff-0000-0000-0000-000000000000",
        cwd: spec.cwd,
        model: null,
        participants: 1,
        relayConnected: true,
        inputRequired: false,
        busy: false,
        access: "control",
      });
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
  it("matches concurrent same-project launches by process ancestry, not publish order or PID", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.seed({ id: "c2" });
    const originalLaunch = world.adapters.launch;
    let count = 0;
    let resolveBoth!: () => void;
    const bothLaunched = new Promise<void>((resolve) => { resolveBoth = resolve; });
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      count += 1;
      session.panePid = spec.conversationId === "c1" ? 2002 : 2001;
      if (count === 2) {
        const rows = [
          { instanceId: "host-c2", pid: 2001, sessionId: "native-c2" },
          { instanceId: "host-c1", pid: 2002, sessionId: "native-c1" },
        ];
        for (const row of rows) world.hosts.push({
          ...row,
          generation: 1,
          cwd: spec.cwd,
          model: null,
          participants: 1,
          relayConnected: true,
          inputRequired: false,
          busy: false,
          access: "control",
        });
        resolveBoth();
      }
      return session;
    };
    const supervisor = createSupervisor({
      store: world.store,
      adapters: world.adapters,
      clock: { now: () => Date.now(), sleep: async () => bothLaunched },
      maxActive: 3,
      publishTimeoutMs: 5_000,
      publishPollMs: 0,
    });

    const [c1, c2] = await Promise.all([
      supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" }),
      supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" }),
    ]);

    expect(c1.hostInstanceId).toBe("host-c1");
    expect(c1.nativeSessionId).toBe("native-c1");
    expect(c2.hostInstanceId).toBe("host-c2");
    expect(c2.nativeSessionId).toBe("native-c2");
    expect(world.launches).toHaveLength(2);
  });

  it("adopts a host process descended from the launched pane through a wrapper", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      session.panePid = 4000;
      world.hosts.push({
        instanceId: "wrapped-host", generation: 1, pid: 4010, sessionId: "wrapped-session",
        cwd: spec.cwd, model: null, participants: 1, relayConnected: true,
        inputRequired: false, busy: false, access: "control",
      });
      return session;
    };
    world.adapters.isProcessDescendant = async (candidatePid, panePid) => candidatePid === 4010 && panePid === 4000;
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishPollMs: 0 });

    const result = await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });

    expect(result.hostInstanceId).toBe("wrapped-host");
    expect(result.nativeSessionId).toBe("wrapped-session");
  });

  it("does not adopt a matching-cwd host when process identity is unavailable", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.adapters.launch = async (spec) => {
      const session: RuntimeTmuxSession = {
        id: "$1", name: spec.name, alive: true, panePid: null, serverIdentity: "private-socket:1",
      };
      world.tmuxSessions.push(session);
      world.hosts.push({
        instanceId: "unknown-pid-host", generation: 1, pid: null, sessionId: "other-native",
        cwd: spec.cwd, model: null, participants: 1, relayConnected: true,
        inputRequired: false, busy: false, access: "control",
      });
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
    expect(result.hostInstanceId).toBeNull();
    expect(result.nativeSessionId).toBeNull();
    expect(result.statusDetail).toMatch(/could not be positively matched/i);
  });

  it("never adopts another native session while resuming a known session", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "expected-native" });
    const originalLaunch = world.adapters.launch;
    world.adapters.launch = async (spec) => {
      const session = await originalLaunch(spec);
      world.hosts.push({
        instanceId: "wrong-native-host", generation: 1, pid: session.panePid,
        sessionId: "different-native", cwd: spec.cwd, model: null, participants: 1,
        relayConnected: true, inputRequired: false, busy: false, access: "control",
      });
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

    const result = await supervisor.start("c1", {
      conversationId: "c1", name: "caw-c1", cwd: "/tmp/project", resumeSessionPath: "/tmp/expected.jsonl",
    });

    expect(result.statusDetail).toMatch(/could not be positively matched/i);
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
    world.adapters.isProcessDescendant = async (candidatePid, panePid) => candidatePid === panePid;
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
  it("reports an unpublished but live process as starting, not idle", async () => {
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
    expect(result.state).toBe("starting");
    expect(result.statusDetail).toMatch(/no collab host was positively matched/i);
    expect(world.events.map((e) => e.type)).toContain("agent.publish_timeout");
  });
});

describe("supervisor.stop", () => {
  it("kills by recorded tmux id and settles to stopped", async () => {
    const world = makeWorld();
    // The pane PID is pinned out of reach: the test asserts the process is GONE, so
    // a low PID that happens to exist on the machine would make `processAlive` report
    // a live pane and the poll would never settle (a real-PID accident, not a bug).
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxPanePid: 1_000_000_000, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$4", name: "caw-c1", alive: true, panePid: 1_000_000_000, serverIdentity: "private-socket:1" });
    // The pane must be positively verified as serving the recorded native session.
    world.hosts.push(hostRow({ pid: 1_000_000_000, sessionId: "native-c1" }));
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
      world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.hosts.push(hostRow({ pid: ours.panePid, sessionId: "native-c1" }));
      world.adapters.killTmux = async () => {};
      let newIdentity: string | null = null;
      world.adapters.tmuxServerIdentity = async () => (restarted ? newIdentity : ours.serverIdentity);
      let probeReads = 0;
      world.adapters.getTmux = async (id) => {
        probeReads += 1;
        // The precheck probe sees our pane. The polling probe is the one that races
        // the restart: the identity read that preceded it already said "old server".
        if (probeReads >= 2 && !restarted) {
          restarted = true;
          // Kill our server and immediately reissue `$0` on a fresh one. The pane the
          // gate recorded no longer exists; only the reused id remains, under a
          // different server identity. A live replacement is enough — the gate must
          // refuse on the identity change alone, never on the pane's liveness.
          await execFileAsync("tmux", ["-S", socketPath, "kill-server"]);
          // tmux briefly refuses to start a new server on a just-killed socket
          // ("server exited unexpectedly"); bounded retries settle it without sleeping.
          let spawned = false;
          for (let attempt = 0; attempt < 10 && !spawned; attempt += 1) {
            try {
              await execFileAsync("tmux", ["-S", socketPath, "new-session", "-d", "-P", "-F", "#{session_id}", "-s", "caw-stop-stranger", "-c", directory, "sleep", "30"]);
              spawned = true;
            } catch {
              // Retry: the previous server is still releasing the socket.
            }
          }
          if (!spawned) throw new Error("could not restart the tmux server on the test socket");
          newIdentity = await tmux.serverIdentity();
          return { ok: true, session: null };
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
      // `$0` was reissued on the replacement server: same id, different identity.
      expect(stranger).toMatchObject({ alive: true, serverIdentity: expect.not.stringMatching(ours.serverIdentity) });
      expect(world.kills).toHaveLength(0);
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
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxPanePid: 900, tmuxServerIdentity: "old-socket:1:10" });
    world.adapters.killTmux = async () => {};
    const stranger: RuntimeTmuxSession = { id: "$0", name: "caw-stranger", alive: true, panePid: 901, serverIdentity: "new-socket:2:20" };
    let restartedBetweenReads = false;
    world.adapters.tmuxServerIdentity = async () => restartedBetweenReads ? "new-socket:2:20" : "old-socket:1:10";
    world.adapters.getTmux = async () => {
      // First identity read was old. Restart immediately before getTmux and reissue `$0`.
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
    await expect(supervisor.stop("c1", 1_000)).rejects.toMatchObject({ code: "agent_not_running" });
    expect(restartedBetweenReads).toBe(true);
    expect(world.kills).toHaveLength(0);
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
    expect((await world.store.getConversation("c1"))?.state).not.toBe("stopped");
    expect(world.tmuxSessions[0]).toMatchObject({ id: "$0", alive: true, serverIdentity: "new-socket:2:20" });
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
      world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.adapters.tmuxServerIdentity = () => tmux.serverIdentity();
      const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
      await unlink(socketPath);

      // The socket is gone but the recorded pane is still alive: absence cannot be
      // verified, so ownership cannot be confirmed and the stop is refused.
      await expect(supervisor.stop("c1")).rejects.toMatchObject({ code: "agent_not_running" });
      expect(world.kills).toHaveLength(0);
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
      world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.hosts.push(hostRow({ pid: ours.panePid, sessionId: "native-c1" }));
      world.adapters.getTmux = async (id) => {
        try {
          const session = await tmux.getById(id);
          return { ok: true as const, session: session ? runtimeSession(session) : null };
        } catch (error) {
          return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
        }
      };
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
      world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: ours.id, tmuxSessionName: ours.name, tmuxServerIdentity: ours.serverIdentity, tmuxPanePid: ours.panePid });
      world.hosts.push(hostRow({ pid: ours.panePid, sessionId: "native-c1" }));
      world.adapters.getTmux = async (id) => {
        try {
          const session = await tmux.getById(id);
          return { ok: true as const, session: session ? runtimeSession(session) : null };
        } catch (error) {
          return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
        }
      };
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

  it("refuses stop when the socket is unreachable but the pane process lives", async () => {
    // The recorded server cannot be reached, and the recorded pane PID is still
    // alive, so ownership cannot be confirmed: refuse rather than report a stop.
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxPanePid: process.pid, tmuxServerIdentity: `private-socket:1:${process.pid}` });
    world.hosts.push(hostRow({ pid: process.pid, sessionId: "native-c1" }));
    world.adapters.tmuxServerIdentity = async () => null;
    world.adapters.killTmux = async () => {};
    await expect(
      createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 }).stop("c1", 500),
    ).rejects.toMatchObject({ code: "agent_not_running" });
    expect(world.kills).toHaveLength(0);
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
  });

  it("refuses a legacy row without a pane PID when the socket is unreachable", async () => {
    // Legacy row: no recorded pane PID and no reachable socket. Neither the pane's
    // absence nor its ownership can be proven, so the stop is refused (RuntimeFailure)
    // rather than reported as a completed stop.
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxServerIdentity: "private-socket:1", tmuxPanePid: null });
    world.adapters.tmuxServerIdentity = async () => null;
    await expect(
      createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 }).stop("c1", 500),
    ).rejects.toMatchObject({ code: "agent_not_running" });
    expect(world.kills).toHaveLength(0);
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
    world.seed({ id: "c1", state: "running", tmuxSessionId: "$0", tmuxSessionName: "caw-ours", tmuxPanePid: 2_000_000_000, tmuxServerIdentity: "private-socket:1" });
    world.adapters.killTmux = async () => {};
    world.adapters.getTmux = async () => ({ ok: true, session: null });
    let t = 0;
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: { now: () => t, sleep: async () => { t += 250; } }, maxActive: 3 });
    const result = await supervisor.stop("c1", 1_000);
    expect(result.state).toBe("stopped");
  });

  it("keeps waiting when server identity probe fails", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxPanePid: 321, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$4", name: "caw-c1", alive: true, panePid: 321, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 321, sessionId: "native-c1" }));
    world.adapters.killTmux = async () => {};
    let identityReads = 0;
    // The precheck read sees the recorded server; every later read fails, so the
    // polling loop must keep waiting rather than settle a verdict it cannot prove.
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
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxPanePid: 321, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$4", name: "caw-c1", alive: true, panePid: 321, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 321, sessionId: "native-c1" }));
    world.adapters.killTmux = async () => {};
    // The precheck probe verifies our pane; every probe during polling fails, so the
    // loop must keep waiting rather than settle a stop it cannot prove.
    let probes = 0;
    world.adapters.getTmux = async (id) => {
      probes += 1;
      if (probes === 1) return { ok: true as const, session: world.tmuxSessions.find((session) => session.id === id) ?? null };
      return { ok: false as const, reason: "tmux probe could not run" };
    };
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

  it("refuses to settle a stop when the pane is missing but its recorded PID lives", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxServerIdentity: "private-socket:1", tmuxPanePid: process.pid });
    // The session list does not contain `$4` any more, but its recorded pane PID is
    // this very process. Absence of the session is not proof of exit.
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await expect(supervisor.stop("c1")).rejects.toMatchObject({ code: "agent_not_running" });
    expect(world.kills).toHaveLength(0);
    expect(world.events.map((event) => event.type)).not.toContain("agent.stopped");
    expect((await world.store.getConversation("c1"))?.state).not.toBe("stopped");
  });

  it("settles a stop when the pane is missing and its recorded PID is confirmed gone", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$4", tmuxSessionName: "caw-c1", tmuxServerIdentity: "private-socket:1", tmuxPanePid: 1_000_000_000 });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const result = await supervisor.stop("c1");

    expect(result.state).toBe("stopped");
    expect(world.events.map((event) => event.type)).toContain("agent.stopped");
  });

  it("reports a stop that does not complete as still stopping, and says so", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", state: "running", nativeSessionId: "native-c1", tmuxSessionId: "$5", tmuxSessionName: "caw-c1", tmuxPanePid: 900, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$5", name: "caw-c1", alive: true, panePid: 900, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 900, sessionId: "native-c1" }));
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
    world.seed({ id: "c1", state: "starting", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: 42, tmuxServerIdentity: "private-socket:1", nativeSessionId: "sess-1" });
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
  it("keeps external host state current through refresh without taking ownership", async () => {
    const world = makeWorld();
    world.seed({ nativeSessionId: "external-native", ownership: "external", state: "running" });
    world.setLease(true);
    world.hosts.push({
      instanceId: "external-host", generation: 1, pid: 9000, sessionId: "external-native",
      cwd: "/tmp/project", model: "model", participants: 1, relayConnected: true,
      inputRequired: false, busy: true, access: "control",
    });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    expect((await supervisor.refresh("c1"))?.state).toBe("running");
    world.hosts[0]!.busy = false;
    expect((await supervisor.refresh("c1"))?.state).toBe("idle");
    world.hosts[0]!.inputRequired = true;
    expect((await supervisor.refresh("c1"))?.state).toBe("awaiting_input");
    expect((await world.store.getConversation("c1"))?.ownership).toBe("external");
    expect(world.launches).toHaveLength(0);
  });

  it("reports unknown when an external host disappears", async () => {
    const world = makeWorld();
    world.seed({ nativeSessionId: "external-native", ownership: "external", state: "running" });
    world.setLease(true);
    world.hosts.push({
      instanceId: "external-host", generation: 1, pid: 9000, sessionId: "external-native",
      cwd: "/tmp/project", model: "model", participants: 1, relayConnected: true,
      inputRequired: false, busy: true, access: "control",
    });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    await supervisor.reconcile();
    world.hosts.splice(0);

    const refreshed = await supervisor.refresh("c1");
    expect(refreshed?.state).toBe("unknown");
    expect(refreshed?.statusDetail).toMatch(/another process is writing this session/i);
    expect(refreshed?.ownership).toBe("external");
  });

  it("reports unknown when the registry becomes unreadable for an external session", async () => {
    const world = makeWorld();
    world.seed({ nativeSessionId: "external-native", ownership: "external", state: "running" });
    world.setLease(true);
    world.hosts.push({
      instanceId: "external-host", generation: 1, pid: 9000, sessionId: "external-native",
      cwd: "/tmp/project", model: "model", participants: 1, relayConnected: true,
      inputRequired: false, busy: true, access: "control",
    });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    await supervisor.reconcile();
    world.breakRegistry(true);

    const refreshed = await supervisor.refresh("c1");
    expect(refreshed?.state).toBe("unknown");
  });

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

  it("keeps a live pane's ownership unknown when no host descends from it", async () => {
    // The pane exists under us, but the only registry row for the recorded native
    // session belongs to a process that is not behind that pane. Labelling it
    // `managed` would pair two different processes in the UI.
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "native-A", state: "running", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: 1002, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1002, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 9000, sessionId: "native-A", instanceId: "external-A", generation: 2 }));
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const refreshed = await supervisor.refresh("c1");

    expect(refreshed?.state).toBe("unknown");
    expect(refreshed?.ownership).toBe("managed");
    expect(refreshed?.hostInstanceId).toBeNull();
  });

  it("persists a model the host reports without touching the next-launch preference", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "native-A", state: "idle", model: "old-model", modelPreference: "chosen-model", statusDetail: "No turn in flight.", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: 1002, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1002, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 1002, sessionId: "native-A", model: "new-model" }));
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const refreshed = await supervisor.refresh("c1");

    expect(refreshed?.model).toBe("new-model");
    expect(refreshed?.modelPreference).toBe("chosen-model");
  });

  it("does not rewrite the row when an optional host generation is absent", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "native-A", state: "idle", hostGeneration: 3, hostInstanceId: "host-A", statusDetail: "No turn in flight.", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: 1002, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1002, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 1002, sessionId: "native-A", instanceId: "host-A", generation: null }));
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    await supervisor.refresh("c1");
    const first = await world.store.getConversation("c1");
    await supervisor.refresh("c1");
    const second = await world.store.getConversation("c1");

    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(second?.hostGeneration).toBe(3);
  });

  it("returns null for an unknown conversation instead of inventing one", async () => {
    const world = makeWorld();
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    expect(await supervisor.refresh("nope")).toBeNull();
  });

  it("keeps a matched pane managed when an unrelated host row has no PID", async () => {
    // A row without a PID cannot prove anything either way. Letting it be blanket
    // uncertainty blanked ownership for *every* live pane, even one with a clean
    // match sitting right next to it.
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "native-A", state: "running", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: 1002, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1002, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 1002, sessionId: "native-A", instanceId: "host-A" }));
    world.hosts.push(hostRow({ pid: null, sessionId: "other-native", instanceId: "unknown-pid-host" }));
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const refreshed = await supervisor.refresh("c1");

    expect(refreshed?.state).toBe("idle");
    expect(refreshed?.ownership).toBe("managed");
    expect(refreshed?.hostInstanceId).toBe("host-A");
  });

  it("backfills the pane PID a failed post-launch listing never recorded", async () => {
    // The launch returned a session whose pane PID was null, and no writer ever
    // filled it in. Without a PID the row cannot be stopped (identity incomplete)
    // or deleted (unknown), forever. The enumeration that qualified the session by
    // id and server lifetime is the missing PID.
    const world = makeWorld();
    // The PID is pinned out of reach, because this test then stops the conversation
    // and asserts the process is GONE: a low PID that exists on the machine would
    // make the stop poll see a live pane and never settle.
    world.seed({ id: "c1", nativeSessionId: "native-A", state: "unknown", tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: null, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1_000_000_000, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 1_000_000_000, sessionId: "native-A", instanceId: "host-A" }));
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const refreshed = await supervisor.refresh("c1");

    expect(refreshed?.tmuxPanePid).toBe(1_000_000_000);
    expect(refreshed?.state).toBe("idle");
    // The stop gate can now verify ownership instead of refusing on a missing PID.
    const stopped = await supervisor.stop("c1");
    expect(stopped.state).toBe("stopped");
    expect(world.kills).toEqual(["$1"]);
  });

  it("takes a new host's generation with its instance instead of pairing the old one", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "native-A", state: "idle", statusDetail: "No turn in flight.", hostInstanceId: "host-A", hostGeneration: 3, tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: 1002, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1002, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 1002, sessionId: "native-A", instanceId: "host-B", generation: null }));
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const refreshed = await supervisor.refresh("c1");

    // host-A's generation 3 belongs to host-A. Carrying it onto host-B would claim
    // a pair that never existed.
    expect(refreshed?.hostInstanceId).toBe("host-B");
    expect(refreshed?.hostGeneration).toBeNull();
  });

  it("drops stale host identity when no host matches the live pane", async () => {
    const world = makeWorld();
    world.seed({ id: "c1", nativeSessionId: "native-A", state: "running", hostInstanceId: "old-host", hostGeneration: 3, tmuxSessionId: "$1", tmuxSessionName: "caw-c1", tmuxPanePid: 1002, tmuxServerIdentity: "private-socket:1" });
    world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1002, serverIdentity: "private-socket:1" });
    world.hosts.push(hostRow({ pid: 9000, sessionId: "native-A", instanceId: "external-A", generation: 2 }));
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const refreshed = await supervisor.refresh("c1");

    // Nothing matched this pane, so no room can be claimed to be serving it.
    expect(refreshed?.hostInstanceId).toBeNull();
    expect(refreshed?.hostGeneration).toBeNull();
  });

  it("reports a launch as in flight until its process identity is recorded", async () => {
    const world = makeWorld();
    world.seed({ id: "c1" });
    let supervisor!: ReturnType<typeof createSupervisor>;
    let inFlightWhenSpawning = false;
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      // The process is being created right now: the row still says nothing is
      // running, so the reservation is the only signal that a launch is in flight.
      inFlightWhenSpawning = supervisor.isLaunching("c1");
      throw new Error("simulated launch failure");
    };
    supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0, publishPollMs: 0 });

    expect(supervisor.isLaunching("c1")).toBe(false);
    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" })).rejects.toThrow(/simulated launch failure/);

    expect(inFlightWhenSpawning).toBe(true);
    expect(world.launches).toHaveLength(1);
    // Released once the launch settled, so the row can be cleaned up again.
    expect(supervisor.isLaunching("c1")).toBe(false);
  });

  it("acquires the launch claim through the store before any adapter call", async () => {
    // The invariant that replaced "reserved synchronously before the first await":
    // the claim is taken by the STORE, so it is ordered on the store's own queue
    // against the queued delete. Two consequences are observable here — the claim
    // exists before the first adapter call, and a store that refuses the claim
    // (its row was deleted first) fails the launch without creating a process.
    const world = makeWorld();
    world.seed({ id: "c1" });
    let claimedWhenSpawning = false;
    world.adapters.launch = async (spec) => {
      world.launches.push(spec);
      // The first adapter call is the first thing that can create a process, so the
      // claim must already be visible to the store by now.
      claimedWhenSpawning = world.store.isLaunchReserved("c1");
      throw new Error("stop before publishing");
    };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });

    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" })).rejects.toThrow(/stop before publishing/);
    expect(claimedWhenSpawning).toBe(true);
    // Released on the failure path, so the row is deletable again.
    expect(supervisor.isLaunching("c1")).toBe(false);

    // The store refusing the claim means its row was already gone (a delete that
    // queued first): no adapter may be called, so no process is created at all.
    world.seed({ id: "c2" });
    world.removeRow("c2");
    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project" }))
      .rejects.toMatchObject({ code: "agent_not_running" });
    expect(world.launches).toHaveLength(1);
    expect(supervisor.isLaunching("c2")).toBe(false);
  });

  it("refuses a second launch for the same conversation while the first is in flight", async () => {
    // Reserving before the lock means the *pre-lock* reservation itself must be
    // recognised as a conflict, not mistaken for this call's own key.
    const world = makeWorld();
    world.seed({ id: "c1" });
    let gate!: () => void;
    const slowRead = new Promise<void>((resolve) => { gate = resolve; });
    const getConversation = world.store.getConversation;
    world.store.getConversation = async (id) => { await slowRead; return getConversation(id); };
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });

    const first = supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
    const second = supervisor.start("c1", { conversationId: "c1", name: "caw-c1-again", cwd: "/tmp/project" });
    gate();
    const results = await Promise.allSettled([first, second]);
    expect(world.launches).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.code)).toEqual([
      "conflict_owner",
    ]);
  });

  it("releases the reservation when a refusal cannot be journalled", async () => {
    // The leak: keys are added, then awaited work runs — including a refusal's own
    // `recordEvent`, which throws on a poisoned journal. The reservation must not
    // survive that throw. Here an untracked live tmux session makes the launch refuse
    // after the reservation was taken, and the journal write for the refusal fails.
    const world = makeWorld();
    world.seed({ id: "c1", state: "stopped" });
    // A live managed session with no recorded owner: launches are refused, and the
    // refusal path records an event before throwing.
    world.tmuxSessions.push({ id: "$9", name: "orphan", alive: true, panePid: 4242, serverIdentity: "private-socket:1" });
    world.breakRecordEvents(true);
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });

    await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" }))
      .rejects.toThrow(/simulated journal failure/);

    // Nothing was launched, and nothing stayed reserved: the row is deletable again
    // once the journal is repaired.
    expect(world.launches).toHaveLength(0);
    expect(supervisor.isLaunching("c1")).toBe(false);
  });

  it("leaves another launch's reservation alone when it refuses", async () => {
    // A refused call owns no key, so its cleanup must not drop the key the holder
    // took. `c1` runs from a timed-out publish (reservation released, row still
    // claimed); `c2` aliasing its journal is refused and must not disturb anything.
    const world = makeWorld();
    world.seed({ id: "c1" });
    world.seed({ id: "c2", state: "stopped" });
    const journal = "/tmp/journal.jsonl";
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
    await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project", resumeSessionPath: journal });

    await expect(supervisor.start("c2", { conversationId: "c2", name: "caw-c2", cwd: "/tmp/project", resumeSessionPath: journal }))
      .rejects.toMatchObject({ code: "conflict_owner" });

    expect(supervisor.isLaunching("c2")).toBe(false);
    expect(world.launches).toHaveLength(1);
  });

  it("releases the reservation when the conversation is not found before launch", async () => {
    // The early not-found throw now sits inside the same try as the reservation, so
    // it releases rather than leaving a key reserved for a row that does not exist.
    const world = makeWorld();
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
    await expect(supervisor.start("ghost", { conversationId: "ghost", name: "caw-ghost", cwd: "/tmp/project" }))
      .rejects.toMatchObject({ code: "agent_not_running" });
    expect(supervisor.isLaunching("ghost")).toBe(false);
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

  it("does not resurrect a refused launch as a ghost starting row", async () => {
    // A launch refused before any process existed leaves the row at `error` with the
    // refusal recorded. Nothing has ever launched for it, so no observation can make
    // it "starting"; the never-launched fallback must not turn the refusal into a
    // launch claim that overwrites the reason.
    const world = makeWorld();
    world.seed({ id: "c1", state: "error", statusDetail: "Agent launch was refused: No active slots" });
    const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

    const conversation = await supervisor.refresh("c1");
    expect(conversation?.state).toBe("error");
    expect(conversation?.statusDetail).toBe("Agent launch was refused: No active slots");
  });
});
