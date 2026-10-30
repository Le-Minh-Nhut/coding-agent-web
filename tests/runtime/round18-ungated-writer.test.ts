import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { epochOf, observationSeqOf, type Conversation } from "@caw/contracts";
import { createSupervisor, type RuntimeAdapters, type RuntimeHost, type RuntimeTmuxSession } from "@caw/runtime";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { buildApp } from "../../apps/server/src/app.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

/**
 * The refused-launch stamp of `POST /api/projects/:id/conversations` is a *verdict
 * about the machine*: the row the request read still has no process, so the launch
 * that was refused left nothing behind. It is not a user intent.
 *
 * Its freshness gate is the row it read, and a second launch for the same
 * conversation can take the store's reservation between that read and this write —
 * legitimately, with a real process about to record its identity. An unflagged
 * write there only compares the *epoch*, and the pre-record window has not advanced
 * it yet, so it lands, advances the epoch, and the launch's own record is then
 * refused: the supervisor kills the process it just started as an unrecorded
 * writer. The protection is the writer's `observation` flag, which the store's
 * reservation gate uses to drop it.
 */

// Node 20 has no `Promise.withResolvers`; same helper shape as round18-epoch-auditor.
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const dead: RuntimeTmuxSession = { id: "$1", name: "pane", alive: true, panePid: 1_000_000_001, serverIdentity: "private:1" };

/** A launch that stops in the post-spawn pre-record window, holding the reservation. */
function gatedLaunchWorld() {
  const entered = deferred<void>();
  const release = deferred<void>();
  const killed: string[] = [];
  let sessions: RuntimeTmuxSession[] = [];
  const hosts: RuntimeHost[] = [];
  const adapters: RuntimeAdapters = {
    listManagedTmux: async () => [...sessions],
    listHosts: async () => [...hosts],
    isSessionLive: async () => false,
    sessionPathExists: async () => true,
    findBySessionId: async () => null,
    newestSessionFor: async () => null,
    isProcessDescendant: async (pid, panePid) => pid === panePid,
    tmuxServerIdentity: async () => "private:1",
    getTmux: async () => ({ ok: true, session: sessions[0] ?? null }),
    killTmux: async (id) => { killed.push(id); sessions = []; },
    launch: async (spec) => { const pane = { ...dead, name: spec.name }; sessions = [pane]; entered.resolve(); await release.promise; return pane; },
  };
  return { adapters, entered, release, killed };
}

const adapterStub = (): RuntimeAdapters => ({
  listManagedTmux: async () => [], listHosts: async () => [], isSessionLive: async () => false,
  sessionPathExists: async () => true, findBySessionId: async () => null, newestSessionFor: async () => null,
  isProcessDescendant: async (pid, panePid) => pid === panePid, tmuxServerIdentity: async () => "private:1",
  getTmux: async () => ({ ok: true, session: null }), killTmux: async () => {},
  launch: async () => { throw new Error("this supervisor launches nothing"); },
});

it("V18 the refused-launch stamp cannot stamp a row a launch is recording", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r18-ungated-route-"));
  try {
    const store = createMetadataStore(dir);
    const { adapters, entered, release, killed } = gatedLaunchWorld();
    // The route's own supervisor refuses the launch (nothing to launch here), which
    // drives the real catch path; the reservation is free when its guard runs.
    const routeSupervisor = createSupervisor({ store, adapters: adapterStub(), maxActive: 0 });
    // The legitimate second launch for the same conversation: real, holding the
    // store's reservation while its process exists but is not yet recorded.
    const launchSupervisor = createSupervisor({
      store, adapters, maxActive: 3, publishTimeoutMs: 0,
      clock: { now: () => 0, sleep: async () => {} },
    });
    const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => {} });
    await auth.initAuth();
    const config = { host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false };
    const app = buildApp({
      config, auth, store, supervisor: routeSupervisor, originAllowlist: ["https://workspace.test"],
      runtimeSpec: (conversation) => ({ conversationId: conversation.id, name: "pane", cwd: dir }),
    });
    const session = auth.createSession();
    const headers = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
    const project = await store.createProject({ path: dir });
    const original = store.updateConversationIfCurrent.bind(store);
    let injected = false;
    let conversationId = "";
    let starting: Promise<Conversation | string> | undefined;
    // The catch's stamp is the first conditional write of this route. Take the
    // reservation *between* the route's `isLaunching` guard and its write — exactly
    // the window the reviewer reproduced — then let the write proceed unchanged.
    store.updateConversationIfCurrent = async (id, expectedEpoch, patch, opts) => {
      if (!injected) {
        injected = true;
        conversationId = id;
        starting = launchSupervisor.start(id, { conversationId: id, name: "pane", cwd: dir }).then((value) => value, (error) => String(error));
        await entered.promise;
      }
      return original(id, expectedEpoch, patch, opts);
    };
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, headers, payload: {} });
    release.resolve();
    const result = await starting!;
    store.updateConversationIfCurrent = original;
    const final = (await store.getConversation(conversationId))!;
    console.log("AUDIT18 ungated stamp", JSON.stringify({ status: response.statusCode, killed, resultState: (result as Conversation).state ?? null, error: typeof result === "string" ? result : null, finalState: final.state, finalDetail: final.statusDetail, finalTmux: final.tmuxSessionId }));
    // The launch owns the row: it recorded its process, and its own verdict landed.
    expect(killed).toEqual([]);
    expect(typeof result).not.toBe("string");
    expect((result as Conversation).tmuxSessionId).toBe("$1");
    expect(final.tmuxSessionId).toBe("$1");
    expect(final.state).toBe("starting");
    // The refusal stamp described a row a launch had taken, so it was dropped.
    expect(final.statusDetail ?? "").not.toMatch(/refused/i);
    expect(response.statusCode).toBe(409);
    await app.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each([
  { shape: "observation-gated (the app's shape)", flags: true, applied: false, killed: [] as string[] },
  { shape: "unflagged (the pre-fix shape)", flags: false, applied: true, killed: ["$1"] },
])("V18 the store's reservation gate only drops a writer that says it is observing: $shape", async ({ flags, applied, killed: expectedKilled }) => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r18-ungated-store-"));
  try {
    const store = createMetadataStore(dir);
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id });
    const { adapters, entered, release, killed } = gatedLaunchWorld();
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 0, clock: { now: () => 0, sleep: async () => {} } });
    const starting = supervisor.start(conversation.id, { conversationId: conversation.id, name: "pane", cwd: dir }).then((value) => value, (error) => String(error));
    await entered.promise;
    // The row as the refused request observed it: no process, pre-record.
    const observed = (await store.getConversation(conversation.id))!;
    const stamp = { state: "error" as const, statusDetail: "Agent launch was refused: No active slots" };
    const result = await store.updateConversationIfCurrent(conversation.id, epochOf(observed), stamp, flags
      ? { observation: true, expectedObservationSeq: observationSeqOf(observed) }
      : undefined);
    release.resolve();
    const launch = await starting;
    const final = (await store.getConversation(conversation.id))!;
    console.log("AUDIT18 ungated store", JSON.stringify({ flags, applied: result?.applied, killed, launchState: (launch as Conversation).state ?? null, error: typeof launch === "string" ? launch : null, finalState: final.state, finalTmux: final.tmuxSessionId }));
    expect(result?.applied).toBe(applied);
    expect(killed).toEqual(expectedKilled);
    if (flags) {
      expect(typeof launch).not.toBe("string");
      expect((launch as Conversation).tmuxSessionId).toBe("$1");
      expect(final.tmuxSessionId).toBe("$1");
    } else {
      // Without the flag the epoch-only comparison passes: the row moves and the
      // launch's own record is refused, so it kills the process it just started.
      expect(String(launch)).toContain("changed identity");
      expect(final.tmuxSessionId).toBeNull();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
