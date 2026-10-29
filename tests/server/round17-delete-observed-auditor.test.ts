import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSupervisor } from "@caw/runtime";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { createMetadataStore } from "../../apps/server/src/store.js";
import { buildApp } from "../../apps/server/src/app.js";

it("V17 delete uses confirmed dead process even when stored label is still idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-delete-"));
  const store = createMetadataStore(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => {} }); await auth.initAuth();
  const config: any = { host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false };
  const adapters: any = { listManagedTmux: async () => [], listHosts: async () => [], isSessionLive: async () => false, sessionPathExists: async () => true, findBySessionId: async () => "/tmp/journal", isProcessDescendant: async () => false };
  const supervisor = createSupervisor({ store, adapters, maxActive: 3 });
  const app = buildApp({ config, auth, store, supervisor, originAllowlist: ["https://workspace.test"] });
  try {
    // Two projects carry the identical cached-`idle` dead-row fixture. The first is
    // deleted straight away; the second keeps the older workaround path as a
    // positive control. Both must end at 200 — the point is that the cached label
    // never decides either way.
    const p = await store.createProject({ path: dir }); const c = await store.createConversation({ projectId: p.id, nativeSessionId: "native-A" });
    await store.updateConversation(c.id, { state: "idle", nativeSessionPath: "/tmp/journal", tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: 1000000000 });
    const controlDir = join(dir, "control"); await mkdir(controlDir);
    const p2 = await store.createProject({ path: controlDir }); const c2 = await store.createConversation({ projectId: p2.id, nativeSessionId: "native-B" });
    await store.updateConversation(c2.id, { state: "idle", nativeSessionPath: "/tmp/journal", tmuxSessionId: "$1", tmuxServerIdentity: "private:1", tmuxPanePid: 1000000000 });
    const session = auth.createSession();
    const response = await app.inject({ method: "DELETE", url: `/api/projects/${p.id}`, headers: { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken } });
    const observed = await supervisor.observe(c2.id);
    const storedState = (await store.getConversation(c2.id))?.state;
    // Positive control: merely opening GET conversation refreshes the cached label;
    // exactly the same DELETE then works, without changing any machine fact.
    await supervisor.refresh(c2.id);
    const afterRefresh = await app.inject({ method: "DELETE", url: `/api/projects/${p2.id}`, headers: { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken } });
    console.log("AUDIT17 dead delete", JSON.stringify({ status: response.statusCode, body: response.json(), observedTmux: observed?.tmux, lease: observed?.leaseLive, storedState, afterRefreshStatus: afterRefresh.statusCode }));
    expect(afterRefresh.statusCode).toBe(200);
    expect(response.statusCode).toBe(200);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
