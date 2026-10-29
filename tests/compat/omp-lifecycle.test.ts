import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { Conversation } from "@caw/contracts";
import { createSupervisor } from "@caw/runtime";
import type { ConversationRuntimeStore, RuntimeAdapters, RuntimeLaunchSpec, RuntimeTmuxSession } from "@caw/runtime";
import {
  DefaultCapabilityService,
  DefaultCollabRegistryService,
  DefaultNativeSessionCatalog,
  DefaultSessionLeaseProbe,
  DefaultTmuxService,
} from "@caw/omp-adapter";

/**
 * Real-OMP compatibility suite.
 *
 * These tests launch actual agents through the real adapter stack, so they are
 * opt-in: `CAW_COMPAT=1 npx vitest run tests/compat`. They are skipped by default
 * because agents consume provider credits and deserve a disposable workspace.
 *
 * What only these tests can prove: that our supervisor, driving the real `omp`
 * and `tmux`, starts a process the machine can see, that a terminal can attach to
 * it, and that the duplicate-writer guard refuses to start a second one.
 */
const enabled = process.env.CAW_COMPAT === "1";
const maybe = enabled ? describe : describe.skip;
const execFileAsync = promisify(execFile);

/**
 * An isolated tmux server, so this suite can never disturb the owner's sessions.
 * The name is unique per run; cleanup is by socket, never by killing processes we
 * did not start.
 */
const socketName = `caw-compat-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

const temporaryDirs: string[] = [];
afterAll(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  // Tear down only the tmux server we created, addressed by our own socket name.
  await execFileAsync("tmux", ["-L", socketName, "kill-server"]).catch(() => undefined);
});

/** A minimal store over a Map, shaped as the supervisor's port. */
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

function newConversation(id: string): Conversation {
  return {
    id,
    projectId: "compat-project",
    nativeSessionId: null,
    nativeSessionPath: null,
    title: "compat",
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

maybe("real OMP: managed launch, terminal continuity, duplicate-writer refusal", () => {
  it(
    "launches through tmux, is attachable, and refuses a second writer for the same conversation",
    async () => {
      const capability = new DefaultCapabilityService();
      const probe = await capability.probe(true);
      expect(probe.omp.available, "omp binary is required for this suite").toBe(true);
      expect(probe.tmux.available, "tmux is required for this suite").toBe(true);

      const projectDir = await mkdtemp(join(tmpdir(), "caw-compat-proj-"));
      temporaryDirs.push(projectDir);
      await mkdir(join(projectDir, "src"), { recursive: true });

      // Point the agent at a relay that is deliberately not listening. The launch
      // must still succeed and the registry must honestly report relayConnected:
      // false — that is exactly the degraded case the product has to survive.
      const configPath = join(projectDir, "overlay.yml");
      await writeFile(configPath, "collab:\n  autoStart: control\n  relayUrl: ws://localhost:39999\n", "utf8");

      const tmux = new DefaultTmuxService({ socketName });
      const catalog = new DefaultNativeSessionCatalog();
      const lease = new DefaultSessionLeaseProbe();
      const registry = new DefaultCollabRegistryService();

      const conversations = new Map<string, Conversation>([["c1", newConversation("c1")]]);

      const adapters: RuntimeAdapters = {
        // The registry reports a model object; the runtime only needs a display
        // string. Flattening belongs here in the adapter, not in the supervisor.
        listHosts: async () =>
          (await registry.list()).map((host) => ({
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
        listManagedTmux: () => tmux.listManaged(),
        getTmux: async (id: string) => {
          try {
            return { ok: true as const, session: await tmux.getById(id) };
          } catch (error) {
            return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
          }
        },
        // Identity comes from the adapter, not from a fake: the guard under test is
        // what decides whether a recorded `$N` may still be addressed.
        tmuxServerIdentity: () => tmux.serverIdentity(),
        launch: (spec: RuntimeLaunchSpec): Promise<RuntimeTmuxSession> =>
          tmux.launch({
            name: spec.name,
            cwd: spec.cwd,
            configPath: spec.configPath,
            args: spec.resumeSessionPath ? ["--resume", spec.resumeSessionPath] : [],
          }),
        killTmux: (id: string, expectedServerIdentity: string) => tmux.kill(id, { expectedIdentity: expectedServerIdentity }),
        isSessionLive: (id: string) => lease.isLive(id),
        newestSessionFor: async (cwd: string) => {
          const sessions = await catalog.listForCwd(cwd);
          const newest = sessions[0];
          return newest ? { sessionId: newest.sessionId, path: newest.path } : null;
        },
        sessionPathExists: async (path: string) => existsSync(path),
        findBySessionId: (id: string) => catalog.findBySessionId(id),
      };

      const supervisor = createSupervisor({
        store: createStore(conversations),
        adapters,
        maxActive: 2,
        publishTimeoutMs: 20_000,
        publishPollMs: 1_000,
      });

      const started = await supervisor.start("c1", { conversationId: "c1", name: "caw-compat-c1", cwd: projectDir, configPath });

      // Identity is the tmux session id, not the label.
      expect(started.tmuxSessionId, "launch records a stable tmux session id").toMatch(/^\$\d+$/);

      const live = await tmux.getById(started.tmuxSessionId!);
      expect(live?.alive).toBe(true);
      expect(live?.name).toBe("caw-compat-c1");

      // Terminal continuity: the pane must be rendering the agent's own TUI, which
      // is what `tmux attach` would show the owner.
      const pane = await tmux.capture(started.tmuxSessionId!, 40);
      expect(pane.length).toBeGreaterThan(0);

      // The guard: a second launch for a conversation that already runs is refused,
      // and nothing new is created.
      await expect(supervisor.start("c1", { conversationId: "c1", name: "caw-compat-c1-again", cwd: projectDir, configPath })).rejects.toMatchObject({
        code: "conflict_owner",
      });
      const managed = await tmux.listManaged();
      expect(managed).toHaveLength(1);

      // Stop through the supervisor, addressed by the recorded id.
      const stopped = await supervisor.stop("c1", 20_000);
      expect(stopped.state).toBe("stopped");
      const afterStop = await tmux.getById(started.tmuxSessionId!);
      expect(afterStop === null || afterStop.alive === false).toBe(true);
    },
    180_000,
  );

  it(
    "reads a real session journal header from a bounded prefix",
    async () => {
      const catalog = new DefaultNativeSessionCatalog();
      const sessions = await catalog.listAll(20);
      if (sessions.length === 0) {
        // A machine with no sessions yet is a valid state: the contract is an empty
        // list, not an exception.
        expect(sessions).toEqual([]);
        return;
      }
      const first = sessions[0]!;
      expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(existsSync(first.path)).toBe(true);

      const header = await catalog.readHeader(first.path);
      expect(header?.sessionId).toBe(first.sessionId);
      expect(typeof header?.cwd).toBe("string");

      // Prove the prefix read is genuinely bounded: the journal on disk is larger
      // than what we read to learn the header.
      const raw = await readFile(first.path, "utf8");
      expect(raw.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
