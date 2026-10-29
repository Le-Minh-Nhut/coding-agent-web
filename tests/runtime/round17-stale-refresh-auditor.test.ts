import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { createSupervisor, type RuntimeAdapters, type RuntimeTmuxSession, type RuntimeHost } from "@caw/runtime";
import { createMetadataStore } from "../../apps/server/src/store.js";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { buildApp } from "../../apps/server/src/app.js";

it("V17 refresh must not publish an old stopped observation after a newer launch hosted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-refresh-"));
  try {
    const store = createMetadataStore(dir);
    const p = await store.createProject({ path: dir });
    const c = await store.createConversation({ projectId: p.id, nativeSessionId: "native-A" });
    await store.updateConversation(c.id, { nativeSessionPath: "/tmp/journal-A", state: "stopped", tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: 1000000000 });
    let seen!: () => void;
    let release!: (value: boolean) => void;
    const observing = new Promise<void>(r => { seen = r; });
    const historyGate = new Promise<boolean>(r => { release = r; });
    let sessions: RuntimeTmuxSession[] = [];
    let hosts: RuntimeHost[] = [];
    const adapters: RuntimeAdapters = {
      listManagedTmux: async () => [...sessions], listHosts: async () => [...hosts],
      isSessionLive: async () => hosts.length > 0,
      sessionPathExists: async () => { seen(); return historyGate; }, findBySessionId: async () => "/tmp/journal-A", newestSessionFor: async () => null,
      isProcessDescendant: async (pid, pane) => pid === pane,
      tmuxServerIdentity: async () => "private:1", getTmux: async () => ({ ok: true, session: null }), killTmux: async () => {},
      launch: async spec => {
        const pane = { id: "$2", name: spec.name, alive: true, panePid: 1000000001, serverIdentity: "private:1" };
        sessions = [pane];
        hosts = [{ instanceId: "new-host", generation: 2, pid: pane.panePid, sessionId: "native-A", cwd: dir, model: "deepseek-new", participants: 0, relayConnected: true, inputRequired: false, busy: false, access: "control" }];
        return pane;
      },
    };
    let now = 0;
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 10, publishPollMs: 1, clock: { now: () => now, sleep: async ms => { now += ms; } } });
    const oldRefresh = supervisor.refresh(c.id);
    await observing;
    const started = await supervisor.start(c.id, { conversationId: c.id, name: "new-pane", cwd: dir });
    expect(started.state).toBe("idle");
    release(true);
    await oldRefresh;
    const final = (await store.getConversation(c.id))!;
    console.log("AUDIT17 stale refresh", JSON.stringify({ before: started.state, after: final.state, tmuxSessionId: final.tmuxSessionId, paneAlive: sessions[0]!.alive, host: final.hostInstanceId }));
    expect(final.state).toBe("idle");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("V17 stale refresh plus an earlier delete observation cannot orphan a newer live launch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-orphan-"));
  let app: ReturnType<typeof buildApp> | undefined;
  let child: ChildProcess | undefined;
  try {
    const store = createMetadataStore(dir);
    const p = await store.createProject({ path: dir });
    const c = await store.createConversation({ projectId: p.id, nativeSessionId: "native-A" });
    await store.updateConversation(c.id, { nativeSessionPath: "/tmp/journal-A", state: "stopped", tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: 1000000000 });
    let observedRefresh!: () => void, releaseRefresh!: (value: boolean) => void;
    const refreshObserved = new Promise<void>(r => { observedRefresh = r; });
    const refreshGate = new Promise<boolean>(r => { releaseRefresh = r; });
    let historyCalls = 0;
    let sessions: RuntimeTmuxSession[] = [], hosts: RuntimeHost[] = [];
    const adapters: RuntimeAdapters = {
      listManagedTmux: async () => [...sessions], listHosts: async () => [...hosts], isSessionLive: async () => hosts.length > 0,
      sessionPathExists: async () => { if (++historyCalls === 1) { observedRefresh(); return refreshGate; } return true; },
      findBySessionId: async () => "/tmp/journal-A", newestSessionFor: async () => null, isProcessDescendant: async (pid, pane) => pid === pane,
      tmuxServerIdentity: async () => "private:1", getTmux: async () => ({ ok: true, session: null }), killTmux: async () => {},
      launch: async spec => {
        // A real, harmless child makes the final liveness assertion independent
        // of the fake tmux listing. This is deliberately NOT OMP or real tmux.
        child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", reject); });
        const pane = { id: "$2", name: spec.name, alive: true, panePid: child.pid!, serverIdentity: "private:1" };
        sessions = [pane]; hosts = [{ instanceId: "new-host", generation: 2, pid: pane.panePid, sessionId: "native-A", cwd: dir, model: "deepseek-new", participants: 0, relayConnected: true, inputRequired: false, busy: false, access: "control" }]; return pane;
      },
    };
    let now = 0;
    const supervisor = createSupervisor({ store, adapters, maxActive: 3, publishTimeoutMs: 10, publishPollMs: 1, clock: { now: () => now, sleep: async ms => { now += ms; } } });
    const staleRefresh = supervisor.refresh(c.id); await refreshObserved;
    let sawDelete!: () => void, releaseDelete!: () => void;
    const deletionObserved = new Promise<void>(r => { sawDelete = r; });
    const deleteGate = new Promise<void>(r => { releaseDelete = r; });
    const observe = supervisor.observe;
    supervisor.observe = async id => { const result = await observe(id); sawDelete(); await deleteGate; return result; };
    const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => {} }); await auth.initAuth();
    const config: any = { host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false };
    app = buildApp({ config, auth, store, supervisor, originAllowlist: ["https://workspace.test"] });
    const session = auth.createSession();
    const deletion = app.inject({ method: "DELETE", url: `/api/projects/${p.id}`, headers: { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken } }).then(r => r);
    await deletionObserved;
    await supervisor.start(c.id, { conversationId: c.id, name: "new-pane", cwd: dir });
    expect(supervisor.isLaunching(c.id)).toBe(false);
    releaseRefresh(true); await staleRefresh;
    releaseDelete(); const response = await deletion;
    const remains = !!await store.getConversation(c.id);
    let actualProcessAlive = false;
    try { process.kill(child!.pid!, 0); actualProcessAlive = true; } catch {}
    console.log("AUDIT17 live orphan composition", JSON.stringify({ status: response.statusCode, conversationRemains: remains, projectRemains: (await store.listProjects()).some(row => row.id === p.id), paneAlive: sessions[0]!.alive, actualProcessAlive, launchReserved: supervisor.isLaunching(c.id) }));
    expect(actualProcessAlive).toBe(true);
    expect(response.statusCode).toBe(409);
    expect(remains).toBe(true);
  } finally {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise<void>(resolve => { child!.once("exit", () => resolve()); });
      child.kill("SIGKILL"); await exited;
    }
    await app?.close(); await rm(dir, { recursive: true, force: true });
  }
});
