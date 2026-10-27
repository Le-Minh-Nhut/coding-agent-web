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

it("adopts its own host when publish happens after startup deadline", async () => {
  const world = makeWorld();
  world.seed();
  const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
  await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
  world.hosts.push({ instanceId: "late-host", generation: 1, pid: world.tmuxSessions[0]!.panePid, sessionId: "late-native", cwd: "/tmp/project", model: "model", participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control" });
  await supervisor.refresh("c1");
  await supervisor.reconcile();
  const current = await world.store.getConversation("c1");
  expect(current?.nativeSessionId).toBe("late-native");
  expect(current?.hostInstanceId).toBe("late-host");
  expect(current?.hostGeneration).toBe(1);
  expect(world.launches).toHaveLength(1);
});

it("recovers a host published during startup after backend restart", async () => {
  const world = makeWorld();
  world.seed();
  const firstBackend = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
  await firstBackend.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });

  world.hosts.push({ instanceId: "restarted-host", generation: 3, pid: world.tmuxSessions[0]!.panePid, sessionId: "restarted-native", cwd: "/tmp/project", model: "model", participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control" });
  const restartedBackend = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });
  await restartedBackend.refresh("c1");

  const current = await world.store.getConversation("c1");
  expect(current?.nativeSessionId).toBe("restarted-native");
  expect(current?.hostInstanceId).toBe("restarted-host");
});

it("uses lineage when multiple same-directory hosts are visible", async () => {
  const world = makeWorld();
  world.seed();
  const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
  await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
  const panePid = world.tmuxSessions[0]!.panePid;
  world.hosts.push(
    { instanceId: "unrelated-host", generation: 1, pid: 88_888, sessionId: "unrelated-native", cwd: "/tmp/project", model: null, participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control" },
    { instanceId: "matching-host", generation: 1, pid: panePid, sessionId: "matching-native", cwd: "/tmp/project", model: null, participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control" },
  );

  await supervisor.refresh("c1");
  const current = await world.store.getConversation("c1");
  expect(current?.nativeSessionId).toBe("matching-native");
  expect(current?.hostInstanceId).toBe("matching-host");
});

it("stays unknown with explicit reason when host lineage is unknown", async () => {
  const world = makeWorld();
  world.seed();
  const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
  await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
  world.adapters.isProcessDescendant = async () => "unknown";
  world.hosts.push({ instanceId: "uncertain-host", generation: 1, pid: 88_888, sessionId: "uncertain-native", cwd: "/tmp/project", model: null, participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control" });

  const current = await supervisor.refresh("c1");
  expect(current?.state).toBe("unknown");
  expect(current?.nativeSessionId).toBeNull();
  expect(current?.hostInstanceId).toBeNull();
  expect(current?.statusDetail).toMatch(/lineage could not be determined/i);
});

it("refuses a lineage-matched host with a different known native session", async () => {
  const world = makeWorld();
  world.seed({ nativeSessionId: "expected-native" });
  const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3, publishTimeoutMs: 0 });
  await supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" });
  world.hosts.push({ instanceId: "wrong-session-host", generation: 1, pid: world.tmuxSessions[0]!.panePid, sessionId: "different-native", cwd: "/tmp/project", model: null, participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control" });

  const current = await supervisor.refresh("c1");
  expect(current?.state).toBe("unknown");
  expect(current?.nativeSessionId).toBe("expected-native");
  expect(current?.hostInstanceId).toBeNull();
  expect(current?.statusDetail).toMatch(/not recorded session expected-native/i);
});

it("does not rotate recorded host generation during repeated reconciliation", async () => {
  const world = makeWorld();
  world.seed({
    nativeSessionId: "stable-native",
    tmuxSessionId: "$1",
    tmuxServerIdentity: "private-socket:1",
    tmuxPanePid: 1002,
    hostInstanceId: "stable-host",
    hostGeneration: 7,
  });
  world.tmuxSessions.push({ id: "$1", name: "caw-c1", alive: true, panePid: 1002, serverIdentity: "private-socket:1" });
  world.hosts.push({ instanceId: "stable-host", generation: 7, pid: 1002, sessionId: "stable-native", cwd: "/tmp/project", model: null, participants: 1, relayConnected: true, inputRequired: false, busy: false, access: "control" });
  const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

  await supervisor.reconcile();
  await supervisor.refresh("c1");
  const current = await world.store.getConversation("c1");
  expect(current?.hostInstanceId).toBe("stable-host");
  expect(current?.hostGeneration).toBe(7);
});
it("classifies a held lease as external and refuses to launch another writer", async () => {
  const world = makeWorld();
  world.seed({ nativeSessionId: "foreign-native" });
  world.setLease(true);
  const supervisor = createSupervisor({ store: world.store, adapters: world.adapters, clock: instantClock, maxActive: 3 });

  const refreshed = await supervisor.refresh("c1");
  expect(refreshed?.state).toBe("unknown");
  expect(refreshed?.ownership).toBe("external");
  await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-c1", cwd: "/tmp/project" })).rejects.toMatchObject({ code: "conflict_owner" });
  expect(world.launches).toHaveLength(0);
});
