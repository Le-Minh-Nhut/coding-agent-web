import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { epochOf } from "@caw/contracts";
import { createSupervisor, type RuntimeAdapters, type RuntimeHost, type RuntimeTmuxSession } from "@caw/runtime";
import { createMetadataStore } from "../../apps/server/src/store.js";

/**
 * The sibling shapes of V17-01: an async lifecycle result computed from an older
 * observation must not land on a newer life. Each case below interleaves the two
 * operations deterministically with a gate, then asserts the *row* end state —
 * the mechanism (the store's `lifecycleEpoch`, checked inside its serialized
 * commit) is what every one of these exercises, not a particular code path.
 */

/** A promise plus its resolver, for holding one adapter probe open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Spin the microtask/macrotask queue until the predicate holds (deterministic gate). */
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("the gated condition was never reached");
}

const DEAD_PID = 1_000_000_000; // ESRCH: processAlive reports false, hermetically
const PANE_PID = 1_000_000_001;

function world() {
  const sessions: RuntimeTmuxSession[] = [];
  const hosts: RuntimeHost[] = [];
  return { sessions, hosts };
}

it("V17 sibling: a stop whose kill already settled the machine commits stopped when only a display write moved the epoch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-stop-"));
  try {
    const store = createMetadataStore(dir);
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-A" });
    await store.updateConversation(conversation.id, {
      nativeSessionPath: "/tmp/journal-A", state: "idle",
      tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: DEAD_PID,
    });

    const { sessions, hosts } = world();
    // The stop reads its row, then blocks on its first server-identity probe. While
    // it is held, a routine refresh lands its `idle`→`running` verdict in the same
    // row. `state` is a lifecycle field, so the epoch moves — but the recorded tmux
    // identity does not, so no new process is behind that write.
    const stopGate = deferred<string | null>();
    let identityCalls = 0;
    const adapters: RuntimeAdapters = {
      listManagedTmux: async () => [...sessions],
      listHosts: async () => [...hosts],
      isSessionLive: async () => false,
      sessionPathExists: async () => true,
      findBySessionId: async () => "/tmp/journal-A",
      newestSessionFor: async () => null,
      isProcessDescendant: async (pid, pane) => pid === pane,
      tmuxServerIdentity: async () => { if (++identityCalls === 1) return stopGate.promise; return "private:1"; },
      getTmux: async (id) => ({ ok: true, session: sessions.find((s) => s.id === id) ?? null }),
      killTmux: async (id) => { const index = sessions.findIndex((s) => s.id === id); if (index >= 0) sessions.splice(index, 1); },
      launch: async () => { throw new Error("no launch expected"); },
    };
    let now = 0;
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 10, publishPollMs: 1, clock: { now: () => now, sleep: async (ms) => { now += ms; } } });

    const stopping = supervisor.stop(conversation.id);
    await until(() => identityCalls >= 1);
    // The pane probes the stop will make are satisfiable: the recorded $1 is alive
    // and one host descends from its PID serving the recorded session.
    sessions.splice(0, sessions.length, { id: "$1", name: "pane", alive: true, panePid: DEAD_PID, serverIdentity: "private:1" });
    hosts.splice(0, hosts.length, { instanceId: "host-old", generation: 1, pid: DEAD_PID, sessionId: "native-A", cwd: dir, model: null, participants: 0, relayConnected: true, inputRequired: false, busy: false, access: "control" });
    // The refresh's state write lands while the stop is held. Same recorded tmux
    // session id, so a launch did not replace the process this stop killed.
    await store.updateConversation(conversation.id, { state: "running", hostInstanceId: "new-host" });
    stopGate.resolve("private:1");
    // Every probe passes and the guarded kill removes the pane, so the stop settles
    // the machine. The epoch moved under it, but the recorded session did not, so
    // the terminal row is the honest record rather than a refused stop.
    const settled = await stopping;

    const final = (await store.getConversation(conversation.id))!;
    console.log("AUDIT17 sibling old stop", JSON.stringify({ state: final.state, tmuxSessionId: final.tmuxSessionId, host: final.hostInstanceId }));
    expect(settled.state).toBe("stopped");
    expect(final.state).toBe("stopped");
    expect(final.tmuxSessionId).toBe("$1");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("V17 sibling: a stop must refuse when a genuinely newer process recorded a different tmux session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-stop-identity-"));
  try {
    const store = createMetadataStore(dir);
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-A" });
    await store.updateConversation(conversation.id, {
      nativeSessionPath: "/tmp/journal-A", state: "idle",
      tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: DEAD_PID,
    });

    const { sessions, hosts } = world();
    const stopGate = deferred<string | null>();
    let identityCalls = 0;
    const adapters: RuntimeAdapters = {
      listManagedTmux: async () => [...sessions],
      listHosts: async () => [...hosts],
      isSessionLive: async () => false,
      sessionPathExists: async () => true,
      findBySessionId: async () => "/tmp/journal-A",
      newestSessionFor: async () => null,
      isProcessDescendant: async (pid, pane) => pid === pane,
      tmuxServerIdentity: async () => { if (++identityCalls === 1) return stopGate.promise; return "private:1"; },
      getTmux: async (id) => ({ ok: true, session: sessions.find((s) => s.id === id) ?? null }),
      killTmux: async (id) => { const index = sessions.findIndex((s) => s.id === id); if (index >= 0) sessions.splice(index, 1); },
      launch: async () => { throw new Error("no launch expected"); },
    };
    let now = 0;
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 10, publishPollMs: 1, clock: { now: () => now, sleep: async (ms) => { now += ms; } } });

    const stopping = supervisor.stop(conversation.id);
    await until(() => identityCalls >= 1);
    sessions.splice(0, sessions.length, { id: "$1", name: "pane", alive: true, panePid: DEAD_PID, serverIdentity: "private:1" });
    hosts.splice(0, hosts.length, { instanceId: "host-old", generation: 1, pid: DEAD_PID, sessionId: "native-A", cwd: dir, model: null, participants: 0, relayConnected: true, inputRequired: false, busy: false, access: "control" });
    // A genuinely newer process takes the row: it recorded its own tmux session, so
    // the row is no longer the life this stop killed. Writing `stopped` here would
    // mark a live agent's row as dead.
    await store.updateConversation(conversation.id, { state: "starting", tmuxSessionId: "$2", tmuxPanePid: PANE_PID, hostInstanceId: "new-host" });
    stopGate.resolve("private:1");
    await expect(stopping).rejects.toThrow(/newer lifecycle/);

    const final = (await store.getConversation(conversation.id))!;
    console.log("AUDIT17 sibling old stop identity", JSON.stringify({ state: final.state, tmuxSessionId: final.tmuxSessionId, host: final.hostInstanceId }));
    expect(final.tmuxSessionId).toBe("$2");
    expect(final.state).not.toBe("stopped");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("V17 sibling: an older refresh must not publish its stale verdict over a newer life in the row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-refresh2-"));
  try {
    const store = createMetadataStore(dir);
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-A" });
    await store.updateConversation(conversation.id, {
      nativeSessionPath: "/tmp/journal-A", state: "idle",
      tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: DEAD_PID,
    });

    const { sessions, hosts } = world();
    // The refresh probes with an empty machine (the process is gone) and is held
    // mid-probe. A newer life is then written into the row before it commits.
    const probeGate = deferred<boolean>();
    const adapters: RuntimeAdapters = {
      listManagedTmux: async () => [...sessions],
      listHosts: async () => [...hosts],
      isSessionLive: async () => false,
      sessionPathExists: async () => probeGate.promise,
      findBySessionId: async () => "/tmp/journal-A",
      newestSessionFor: async () => null,
      isProcessDescendant: async (pid, pane) => pid === pane,
      tmuxServerIdentity: async () => "private:1",
      getTmux: async (id) => ({ ok: true, session: sessions.find((s) => s.id === id) ?? null }),
      killTmux: async () => {},
      launch: async () => { throw new Error("no launch expected"); },
    };
    let now = 0;
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 10, publishPollMs: 1, clock: { now: () => now, sleep: async (ms) => { now += ms; } } });

    const older = supervisor.refresh(conversation.id);
    await until(() => true); // the probe promise is now awaited by `older`
    // A newer life opens (a start/restart recording its own process and host).
    await store.updateConversation(conversation.id, {
      state: "idle", tmuxSessionId: "$2", tmuxPanePid: PANE_PID, hostInstanceId: "new-host", hostGeneration: 2, model: "deepseek-new",
    });
    // Now the older read returns; its verdict describes the life that is over.
    probeGate.resolve(true);
    await older;

    const final = (await store.getConversation(conversation.id))!;
    console.log("AUDIT17 sibling out-of-order refresh", JSON.stringify({ state: final.state, tmuxSessionId: final.tmuxSessionId, host: final.hostInstanceId, model: final.model }));
    // The newer life's identity and facts survive: the stale patch was dropped.
    expect(final.tmuxSessionId).toBe("$2");
    expect(final.hostInstanceId).toBe("new-host");
    expect(final.model).toBe("deepseek-new");
    expect(final.state).not.toBe("stopped");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("V17 sibling: a reconcile pass racing a launch must not stamp its old verdict on the new row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-reconcile-"));
  try {
    const store = createMetadataStore(dir);
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-A" });
    await store.updateConversation(conversation.id, {
      nativeSessionPath: "/tmp/journal-A", state: "idle",
      tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: DEAD_PID,
    });

    const { sessions, hosts } = world();
    // reconcile has already read its rows and is held in its first enumeration;
    // a start then completes and owns the row.
    const reconcileGate = deferred<RuntimeTmuxSession[]>();
    let enumerationCalls = 0;
    const adapters: RuntimeAdapters = {
      listManagedTmux: async () => { if (++enumerationCalls === 1) return reconcileGate.promise; return [...sessions]; },
      listHosts: async () => [...hosts],
      isSessionLive: async () => hosts.length > 0,
      sessionPathExists: async () => true,
      findBySessionId: async () => "/tmp/journal-A",
      newestSessionFor: async () => null,
      isProcessDescendant: async (pid, pane) => pid === pane,
      tmuxServerIdentity: async () => "private:1",
      getTmux: async () => ({ ok: true, session: sessions[0] ?? null }),
      killTmux: async () => {},
      launch: async (spec) => {
        const pane = { id: "$2", name: spec.name, alive: true, panePid: PANE_PID, serverIdentity: "private:1" };
        sessions.splice(0, sessions.length, pane);
        hosts.splice(0, hosts.length, { instanceId: "new-host", generation: 2, pid: pane.panePid, sessionId: "native-A", cwd: dir, model: "deepseek-new", participants: 0, relayConnected: true, inputRequired: false, busy: false, access: "control" });
        return pane;
      },
    };
    let now = 0;
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 10, publishPollMs: 1, clock: { now: () => now, sleep: async (ms) => { now += ms; } } });

    const reconciling = supervisor.reconcile();
    await new Promise((r) => setImmediate(r));
    const started = await supervisor.start(conversation.id, { conversationId: conversation.id, name: "new-pane", cwd: dir });
    expect(started.state).toBe("idle");
    reconcileGate.resolve([]); // the enumeration reconciled saw: nothing was running
    await reconciling;

    const final = (await store.getConversation(conversation.id))!;
    console.log("AUDIT17 sibling reconcile", JSON.stringify({ state: final.state, tmuxSessionId: final.tmuxSessionId, host: final.hostInstanceId }));
    expect(final.state).toBe("idle");
    expect(final.tmuxSessionId).toBe("$2");
    expect(final.hostInstanceId).toBe("new-host");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("V17 sibling: a late publish-timeout write loses to the stop that settled the row first", async () => {
  // The mechanism the publish wait relies on, exercised at its contract: it commits
  // conditional on the epoch the launch recorded. A stop that settled the row first
  // advances that epoch, so the late "the agent is still starting/unknown" write is
  // refused and the stopped row stands. (Same shape as the real `waitForPublish`
  // timeout at packages/runtime/src/supervisor.ts, without a timing race.)
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-publish-"));
  try {
    const store = createMetadataStore(dir);
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-A" });
    await store.updateConversation(conversation.id, { nativeSessionPath: "/tmp/journal-A", state: "stopped" });

    // The launch records its process: this is the epoch the publish wait is bound to.
    const before = (await store.getConversation(conversation.id))!;
    const launched = await store.updateConversationIfCurrent(conversation.id, epochOf(before), {
      state: "starting", tmuxSessionId: "$2", tmuxServerIdentity: "private:1", tmuxPanePid: PANE_PID,
    });
    expect(launched?.applied).toBe(true);
    const launchEpoch = epochOf(launched!.conversation);
    expect(launchEpoch).toBeGreaterThan(epochOf(before));

    // A stop settles the row in the meantime (a newer transition in the row).
    const settled = await store.updateConversationIfCurrent(conversation.id, launchEpoch, { state: "stopped", statusDetail: "Stopped." });
    expect(settled?.applied).toBe(true);

    // The launch's late timeout now tries to write its own verdict over the row.
    const late = await store.updateConversationIfCurrent(conversation.id, launchEpoch, {
      state: "unknown", statusDetail: "The agent is running, but no Collab host was matched before startup timed out.",
    });

    const final = (await store.getConversation(conversation.id))!;
    console.log("AUDIT17 sibling late publish timeout", JSON.stringify({ applied: late?.applied, state: final.state, detail: final.statusDetail }));
    expect(late?.applied).toBe(false);
    expect(final.state).toBe("stopped");
    expect(final.statusDetail).toBe("Stopped.");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("V17 sibling: a failed launch's late failure metadata must not mark a row a newer life took", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-failure-"));
  try {
    const store = createMetadataStore(dir);
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-A" });
    await store.updateConversation(conversation.id, { nativeSessionPath: "/tmp/journal-A", state: "stopped" });

    const { sessions, hosts } = world();
    // The launch is held; while it is, another writer opens a new life in the row
    // (a stop transition). The launch's record then fails, and its undo + failure
    // writes must be refused on the row that is no longer the life it launched.
    const launchGate = deferred<void>();
    const adapters: RuntimeAdapters = {
      listManagedTmux: async () => [...sessions],
      listHosts: async () => [...hosts],
      isSessionLive: async () => false,
      sessionPathExists: async () => true,
      findBySessionId: async () => "/tmp/journal-A",
      newestSessionFor: async () => null,
      isProcessDescendant: async (pid, pane) => pid === pane,
      tmuxServerIdentity: async () => "private:1",
      getTmux: async () => ({ ok: true, session: sessions[0] ?? null }),
      killTmux: async () => { sessions.splice(0, sessions.length); },
      launch: async () => { await launchGate.promise; return { id: "$2", name: "pane", alive: true, panePid: PANE_PID, serverIdentity: "private:1" }; },
    };
    let now = 0;
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 10, publishPollMs: 1, clock: { now: () => now, sleep: async (ms) => { now += ms; } } });

    const failing = supervisor.start(conversation.id, { conversationId: conversation.id, name: "new-pane", cwd: dir });
    await new Promise((r) => setImmediate(r));
    // A newer life takes the row (the same lifecycle bump a concurrent stop makes).
    await store.updateConversation(conversation.id, { state: "stopping", statusDetail: "Being stopped elsewhere." });
    launchGate.resolve();
    await expect(failing).rejects.toThrow(/changed identity|newer lifecycle/);

    const final = (await store.getConversation(conversation.id))!;
    const events = await store.listEvents(conversation.id);
    console.log("AUDIT17 sibling late failure", JSON.stringify({ state: final.state, detail: final.statusDetail, events: events.map((e) => e.type) }));
    // The newer row keeps its own state; only the event was recorded, never the
    // stale "stopped"/"unknown" metadata of the launch that lost the row.
    expect(final.state).toBe("stopping");
    expect(final.statusDetail).toBe("Being stopped elsewhere.");
    expect(events.map((event) => event.type)).toContain("agent.launch_discarded");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
