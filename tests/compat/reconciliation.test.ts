import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { Conversation } from "@caw/contracts";
import { createSupervisor } from "@caw/runtime";
import type { ConversationRuntimeStore, RuntimeAdapters, RuntimeHost, RuntimeLaunchSpec, RuntimeTmuxSession } from "@caw/runtime";
import {
  DefaultCapabilityService,
  DefaultCollabRegistryService,
  DefaultNativeSessionCatalog,
  DefaultSessionLeaseProbe,
  DefaultTmuxService,
  encodeSessionDirName,
} from "@caw/omp-adapter";
import type { TmuxSession } from "@caw/omp-adapter";
import { createRelay } from "@caw/relay";
import type { Relay } from "@caw/relay";

const enabled = process.env.CAW_COMPAT === "1";
const maybe = enabled ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const socketName = `caw-reconcile-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const temporaryDirs: string[] = [];
const relays: Relay[] = [];
const createdTmuxIds: string[] = [];
const seededJournalPaths: string[] = [];
const tmux = new DefaultTmuxService({ socketName });

afterAll(async () => {
  // Tear down by id only when the server that owns those ids is still the live one:
  // the identity guard is exactly what should apply to our own cleanup too.
  const liveIdentity = await tmux.serverIdentity().catch(() => null);
  if (liveIdentity) {
    await Promise.all(createdTmuxIds.map((id) => tmux.kill(id, { expectedIdentity: liveIdentity }).catch(() => undefined)));
  }
  await execFileAsync("tmux", ["-L", socketName, "kill-server"]).catch(() => undefined);
  await rm(join(tmpdir(), `tmux-${process.getuid?.() ?? 0}`, socketName), { force: true });
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
  await Promise.all(seededJournalPaths.splice(0).map((path) => rm(path, { force: true })));
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createStore(conversations: Map<string, Conversation>) {
  const reserved = new Set<string>();
  return {
    getConversation: async (id: string) => conversations.get(id) ?? null,
    listAllConversations: async () => [...conversations.values()],
    updateConversation: async (id: string, patch: Partial<Conversation>) => {
      const current = conversations.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      conversations.set(id, next);
      return next;
    },
    updateConversationIfCurrent: async (id: string, expectedEpoch: number, patch: Partial<Conversation>) => {
      const current = conversations.get(id);
      if (!current) return null;
      if ((current.lifecycleEpoch ?? 0) !== expectedEpoch) return { conversation: current, applied: false };
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      conversations.set(id, next);
      return { conversation: next, applied: true };
    },
    recordEvent: async () => null,
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
  } satisfies ConversationRuntimeStore;
}

function newConversation(id: string, nativeSessionId: string | null = null, nativeSessionPath: string | null = null): Conversation {
  return {
    id,
    projectId: "compat-project",
    nativeSessionId,
    nativeSessionPath,
    title: id,
    model: null,
    ownership: "managed",
    state: "starting",
    tmuxSessionId: null,
    tmuxSessionName: null, tmuxServerIdentity: null, tmuxPanePid: null,
    hostInstanceId: null,
    hostGeneration: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: null,
    statusDetail: null,
  };
}

function toRuntimeTmux(session: TmuxSession): RuntimeTmuxSession {
  return {
    id: session.id,
    name: session.name,
    alive: session.alive,
    panePid: session.panePid,
    serverIdentity: session.serverIdentity,
  };
}

function createAdapters(
  catalog: DefaultNativeSessionCatalog,
  lease: DefaultSessionLeaseProbe,
  registry: DefaultCollabRegistryService,
  tracking: { killCalls: string[]; launchCalls: number },
): RuntimeAdapters {
  return {
    listHosts: async () =>
      (await registry.list()).map((host): RuntimeHost => ({
        instanceId: host.instanceId,
        generation: host.generation,
        pid: host.pid,
        sessionId: host.sessionId,
        cwd: host.cwd,
        model: host.model ? `${host.model.provider}/${host.model.id}` : null,
        participants: host.participants,
        relayConnected: host.relayConnected,
        inputRequired: host.inputRequired,
        busy: host.busy,
        access: host.access,
      })),
    listManagedTmux: async () => (await tmux.listManaged()).map(toRuntimeTmux),
    // The probe result keeps "the server answered and it is not there" distinct
    // from "the probe could not run"; the adapter throwing is the latter.
    getTmux: async (id) => {
      try {
        const session = await tmux.getById(id);
        return { ok: true as const, session: session ? toRuntimeTmux(session) : null };
      } catch (error) {
        return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    // The runtime now proves ownership before acting on a recorded tmux id, so the
    // adapter must expose the owning server's identity. Mapping the real adapter's
    // value through keeps this a test of the runtime, not of a fake.
    tmuxServerIdentity: () => tmux.serverIdentity(),
    launch: async (spec) => {
      tracking.launchCalls += 1;
      const launched = await tmux.launch({
        name: spec.name,
        cwd: spec.cwd,
        configPath: spec.configPath,
        args: [
          ...(spec.resumeSessionPath ? ["--resume", spec.resumeSessionPath] : []),
          `--session-dir=${join(spec.cwd, "sessions")}`,
        ],
      });
      createdTmuxIds.push(launched.id);
      return toRuntimeTmux(launched);
    },
    killTmux: async (id, expectedServerIdentity) => {
      tracking.killCalls.push(id);
      // Pass the runtime's expected identity through: the guard under test lives in
      // the adapter, and bypassing it here would make the test prove nothing.
      await tmux.kill(id, { expectedIdentity: expectedServerIdentity });
    },
    isSessionLive: (id) => lease.isLive(id),
    newestSessionFor: async (cwd) => {
      const sessions = await catalog.listForCwd(cwd);
      const newest = sessions[0];
      return newest ? { sessionId: newest.sessionId, path: newest.path } : null;
    },
    sessionPathExists: async (path) => existsSync(path),
    findBySessionId: (id) => catalog.findBySessionId(id),
  };
}

async function launchManagedAgent(label: string) {
  const capability = await new DefaultCapabilityService().probe(true);
  expect(capability.omp.available, "omp binary is required for this suite").toBe(true);
  expect(capability.tmux.available, "tmux is required for this suite").toBe(true);

  const projectDir = await mkdtemp(join(tmpdir(), `caw-reconcile-${label}-`));
  temporaryDirs.push(projectDir);
  await mkdir(join(projectDir, "src"), { recursive: true });
  const sessionsDir = join(projectDir, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  const relay = createRelay({ host: "127.0.0.1", port: 0 });
  relays.push(relay);
  const relayStatus = await relay.start();
  const configPath = join(projectDir, "overlay.yml");
  await writeFile(configPath, `collab:\n  autoStart: control\n  relayUrl: ${relayStatus.url}\n`, "utf8");

  const catalog = new DefaultNativeSessionCatalog({ sessionsRoot: sessionsDir });
  const lease = new DefaultSessionLeaseProbe();
  const registry = new DefaultCollabRegistryService();
  const conversations = new Map<string, Conversation>([["managed", newConversation("managed")]]);
  const store = createStore(conversations);
  const tracking = { killCalls: [] as string[], launchCalls: 0 };
  const adapters = createAdapters(catalog, lease, registry, tracking);
  const supervisor = createSupervisor({ store, adapters, maxActive: 2, publishTimeoutMs: 30_000, publishPollMs: 500 });
  const spec: RuntimeLaunchSpec = { conversationId: "managed", name: `caw-reconcile-managed-${label}`, cwd: projectDir, configPath };

  try {
    const started = await supervisor.start("managed", spec);
    expect(started.nativeSessionId, "real OMP host must publish its native session").toMatch(/^[0-9a-f-]{36}$/);
    expect(started.tmuxSessionId, "launch must record its private tmux id").toMatch(/^\$\d+$/);
    return { projectDir, sessionsDir, catalog, lease, registry, conversations, store, tracking, adapters, spec, started };
  } catch (error) {
    for (const session of await tmux.listManaged()) {
      if (session.name === spec.name) {
        createdTmuxIds.push(session.id);
        await tmux.kill(session.id).catch(() => undefined);
      }
    }
    throw error;
  }
}

async function seedJournal(sessionsDir: string, cwd: string, sessionId: string): Promise<string> {
  // OMP does not flush an empty startup session to disk; write its native header format
  // so dead-history assertions exercise the real catalog and filesystem without prompts.
  const bucket = join(sessionsDir, encodeSessionDirName(cwd));
  await mkdir(bucket, { recursive: true });
  const path = join(bucket, `${new Date().toISOString().replace(/:/g, "-")}_${sessionId}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() })}\n`, "utf8");
  seededJournalPaths.push(path);
  return path;
}

/**
 * Tear down sessions this suite created.
 *
 * The identity guard now refuses a kill that cannot prove which tmux server owns
 * the id, so cleanup must pass the live identity — the same requirement the
 * product's own stop path follows. Without it this helper silently killed
 * nothing, which made a later scenario observe a still-running agent.
 */
async function killCreatedSessions(ids: Array<string | null | undefined>) {
  const identity = await tmux.serverIdentity().catch(() => null);
  if (!identity) return;
  const unique = [...new Set(ids.filter((value): value is string => Boolean(value)))];
  await Promise.all(unique.map((id) => tmux.kill(id, { expectedIdentity: identity }).catch(() => undefined)));
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    // tmux and OMP release the process lease asynchronously; poll observed state.
    await delay(250);
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

maybe("real OMP: reconciliation after backend restart", () => {
  it("adopts live managed agent and restores current host identity", async () => {
    const fixture = await launchManagedAgent("adopt");
    try {
      const nativeSessionId = fixture.started.nativeSessionId!;
      const host = (await fixture.registry.list()).find((row) => row.sessionId === nativeSessionId);
      expect(host, "the real agent must have a Collab registry row").toBeTruthy();
      await fixture.store.updateConversation("managed", { hostInstanceId: null, hostGeneration: null });

      const report = await createSupervisor({ store: fixture.store, adapters: fixture.adapters, maxActive: 2 }).reconcile();
      const conversation = fixture.conversations.get("managed")!;
      expect(report).toEqual({ adopted: 1, external: 0, stopped: 0, unknown: 0, registered: 1 });
      expect(conversation.hostInstanceId).toBe(host!.instanceId);
      expect(conversation.hostGeneration).toBe(host!.generation);
      expect(conversation.state).not.toBe("stopped");
      console.info(`[reconcile-verification] adopt ${JSON.stringify({ report, state: conversation.state, hostInstanceId: conversation.hostInstanceId, hostGeneration: conversation.hostGeneration })}`);
    } finally {
      await killCreatedSessions([fixture.started.tmuxSessionId]);
    }
  }, 180_000);

  it("marks a dead process stopped with surviving journal and allows another start", async () => {
    const fixture = await launchManagedAgent("dead-history");
    try {
      const nativeSessionId = fixture.started.nativeSessionId!;
      const oldTmuxId = fixture.started.tmuxSessionId!;
      const journalPath = await seedJournal(fixture.sessionsDir, fixture.projectDir, nativeSessionId);
      await fixture.store.updateConversation("managed", { nativeSessionPath: journalPath });
      expect(existsSync(journalPath)).toBe(true);

      await killCreatedSessions([oldTmuxId]);
      await waitFor(async () =>
        (await tmux.getById(oldTmuxId)) === null &&
        (await fixture.lease.isLive(nativeSessionId)) === false &&
        !(await fixture.registry.list()).some((host) => host.sessionId === nativeSessionId),
      );

      const freshSupervisor = createSupervisor({ store: fixture.store, adapters: fixture.adapters, maxActive: 2 });
      const report = await freshSupervisor.reconcile();
      const stopped = fixture.conversations.get("managed")!;
      expect(report).toEqual({ adopted: 0, external: 0, stopped: 1, unknown: 0, registered: 0 });
      expect(stopped.state).toBe("stopped");
      expect(stopped.statusDetail).toBe("The agent process is no longer running; its conversation history is intact.");
      expect(existsSync(journalPath)).toBe(true);

      const restarted = await freshSupervisor.start("managed", fixture.spec);
      expect(restarted.tmuxSessionId).toMatch(/^\$\d+$/);
      console.info(`[reconcile-verification] dead-history ${JSON.stringify({ report, state: stopped.state, statusDetail: stopped.statusDetail, journalExists: existsSync(journalPath), retryStartAllowed: true, retryTmuxSessionId: restarted.tmuxSessionId, journalSeededByTest: true })}`);
    } finally {
      await killCreatedSessions([fixture.started.tmuxSessionId, fixture.conversations.get("managed")?.tmuxSessionId]);
    }
  }, 180_000);

  it("leaves unrecorded session in private tmux server alive", async () => {
    const fixture = await launchManagedAgent("unrecorded");
    let unrecordedId: string | null = null;
    try {
      const { stdout } = await execFileAsync("tmux", ["-L", socketName, "new-session", "-d", "-P", "-F", "#{session_id}", "-s", "caw-reconcile-unrecorded-extra", "-c", fixture.projectDir, "sleep", "300"], { shell: false });
      unrecordedId = stdout.trim();
      createdTmuxIds.push(unrecordedId);
      expect(unrecordedId).toMatch(/^\$\d+$/);
      fixture.tracking.killCalls.length = 0;

      const report = await createSupervisor({ store: fixture.store, adapters: fixture.adapters, maxActive: 2 }).reconcile();
      const stillAlive = await tmux.getById(unrecordedId);
      expect(stillAlive?.alive).toBe(true);
      expect(fixture.tracking.killCalls).not.toContain(unrecordedId);
      expect(report).toMatchObject({ adopted: 1, stopped: 0 });
      console.info(`[reconcile-verification] unrecorded ${JSON.stringify({ report, unrecordedSessionId: unrecordedId, unrecordedAlive: stillAlive?.alive, killCallsDuringReconcile: fixture.tracking.killCalls })}`);
    } finally {
      await killCreatedSessions([fixture.started.tmuxSessionId, unrecordedId]);
    }
  }, 180_000);

  it("reports live foreign writer unknown without launching a duplicate", async () => {
    const fixture = await launchManagedAgent("foreign-writer");
    let leaseServer: ReturnType<typeof createServer> | undefined;
    try {
      const nativeSessionId = fixture.started.nativeSessionId!;
      const nativeSessionPath = await seedJournal(fixture.sessionsDir, fixture.projectDir, nativeSessionId);
      await killCreatedSessions([fixture.started.tmuxSessionId]);
      await waitFor(async () =>
        (await fixture.lease.isLive(nativeSessionId)) === false &&
        !(await fixture.registry.list()).some((host) => host.sessionId === nativeSessionId),
      );

      leaseServer = createServer();
      const listening = once(leaseServer, "listening");
      leaseServer.listen(`\0${fixture.lease.leaseName(nativeSessionId)}`);
      await listening;
      expect(await fixture.lease.isLive(nativeSessionId)).toBe(true);

      const conversations = new Map<string, Conversation>([["foreign", newConversation("foreign", nativeSessionId, nativeSessionPath)]]);
      const store = createStore(conversations);
      const launchCalls = fixture.tracking.launchCalls;
      const report = await createSupervisor({ store, adapters: fixture.adapters, maxActive: 2 }).reconcile();
      const conversation = conversations.get("foreign")!;
      expect(report).toEqual({ adopted: 0, external: 0, stopped: 0, unknown: 1, registered: 0 });
      expect(conversation.state).toBe("unknown");
      expect(conversation.statusDetail).toContain("not managed here");
      expect(fixture.tracking.launchCalls).toBe(launchCalls);
      console.info(`[reconcile-verification] foreign-writer ${JSON.stringify({ report, state: conversation.state, statusDetail: conversation.statusDetail, leaseLive: await fixture.lease.isLive(nativeSessionId), launchCallsBeforeAndAfterReconcile: [launchCalls, fixture.tracking.launchCalls], leaseHolder: "test process abstract socket", registryRowAbsent: true, journalSeededByTest: true })}`);
    } finally {
      if (leaseServer?.listening) {
        const closed = once(leaseServer, "close");
        leaseServer.close();
        await closed;
      }
      await killCreatedSessions([fixture.started.tmuxSessionId]);
    }
  }, 180_000);

  it("keeps live managed agent unknown when registry read fails", async () => {
    const fixture = await launchManagedAgent("registry-failure");
    try {
      const adapters: RuntimeAdapters = { ...fixture.adapters, listHosts: async () => { throw new Error("injected unreadable registry"); } };
      fixture.tracking.killCalls.length = 0;
      const report = await createSupervisor({ store: fixture.store, adapters, maxActive: 2 }).reconcile();
      const conversation = fixture.conversations.get("managed")!;
      expect(report).toEqual({ adopted: 0, external: 0, stopped: 0, unknown: 1, registered: 0 });
      expect(conversation.state).toBe("unknown");
      expect(conversation.statusDetail).toContain("registry could not be read");
      expect(fixture.tracking.killCalls).toEqual([]);
      expect((await tmux.getById(fixture.started.tmuxSessionId!))?.alive).toBe(true);
      console.info(`[reconcile-verification] registry-failure ${JSON.stringify({ report, state: conversation.state, statusDetail: conversation.statusDetail, killCallsDuringReconcile: fixture.tracking.killCalls, tmuxAlive: true })}`);
    } finally {
      await killCreatedSessions([fixture.started.tmuxSessionId]);
    }
  }, 180_000);

  it("classifies unlaunched room external and refuses stop", async () => {
    const fixture = await launchManagedAgent("external-room");
    try {
      const nativeSessionId = fixture.started.nativeSessionId!;
      const nativeSessionPath = await seedJournal(fixture.sessionsDir, fixture.projectDir, nativeSessionId);
      const conversations = new Map<string, Conversation>([["external", newConversation("external", nativeSessionId, nativeSessionPath)]]);
      const store = createStore(conversations);
      fixture.tracking.killCalls.length = 0;
      const supervisor = createSupervisor({ store, adapters: fixture.adapters, maxActive: 2 });
      const report = await supervisor.reconcile();
      const conversation = conversations.get("external")!;
      expect(report).toEqual({ adopted: 0, external: 1, stopped: 0, unknown: 0, registered: 0 });
      expect(conversation.ownership).toBe("external");
      expect(conversation.statusDetail).toContain("not managed here");
      await expect(supervisor.stop("external")).rejects.toMatchObject({ code: "agent_not_running" });
      expect(fixture.tracking.killCalls).toEqual([]);
      console.info(`[reconcile-verification] external-room ${JSON.stringify({ report, ownership: conversation.ownership, state: conversation.state, statusDetail: conversation.statusDetail, stopRefused: true, killCalls: fixture.tracking.killCalls, journalSeededByTest: true })}`);
    } finally {
      await killCreatedSessions([fixture.started.tmuxSessionId]);
    }
  }, 180_000);
});
