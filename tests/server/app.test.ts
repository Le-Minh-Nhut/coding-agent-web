import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeError, createSupervisor } from "@caw/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { createRuntimeSpec, launchWithOverlay } from "../../apps/server/src/server.js";
import { buildApp } from "../../apps/server/src/app.js";
import type { Conversation, NativeSessionSummary } from "@caw/contracts";
import type { RuntimeLaunchSpec, Supervisor } from "@caw/runtime";
import type { CollabHost, NativeSessionHistory } from "@caw/omp-adapter";
import type { ServerConfig } from "../../apps/server/src/config.js";
import type { WorkspacePathPolicy } from "../../apps/server/src/path-policy.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(options: { paths?: WorkspacePathPolicy; tmuxSocketPath?: string; tmuxServerIdentity?: () => Promise<string | null>; supervisor?: Supervisor; runtimeSpec?: (conversation: Conversation, input: { resumeSessionId?: string; model?: string }) => Promise<RuntimeLaunchSpec> | RuntimeLaunchSpec; modelCatalog?: { listModels(): Promise<string[]>; listModelsDetailed(): Promise<{ models: string[]; source: "omp" | "unavailable"; reason: string | null }> }; listNativeSessions?: (conversation: { projectPath: string }) => Promise<Array<Omit<NativeSessionSummary, "hasCollabHost">>>; listCollabHosts?: () => Promise<CollabHost[]>; findLiveHost?: (sessionId: string) => Promise<CollabHost | null>; readNativeHistory?: (sessionId: string, expectedCwd: string, options?: { before?: string }) => Promise<NativeSessionHistory> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "caw-app-")); dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined }); await auth.initAuth();
  const config: ServerConfig = { host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false };
  const store = createMetadataStore(dir);
  const app = buildApp({ config, auth, store, originAllowlist: ["https://workspace.test"], ...options });
  const session = auth.createSession();
  const headers = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
  return { app, headers, dir, store, config, auth };
}
describe("launch overlay failure", () => {
  it("refuses launch when the required overlay cannot be written", async () => {
    let launched = false;
    await expect(launchWithOverlay(
      { overlayDir: "/unused", conversationId: "c1", relayPort: 8792 },
      async () => { launched = true; },
      async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); },
    )).rejects.toMatchObject({
      code: "agent_launch_failed",
      message: expect.stringMatching(/overlay.*ENOSPC/i),
    });
    expect(launched).toBe(false);
  });
});


describe("Fastify API security", () => {
  it("returns 401 for every protected API route without a session", async () => {
    const { app } = await fixture();
    const requests: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string }> = [
      { method: "POST", url: "/api/auth/logout" }, { method: "GET", url: "/api/auth/me" },
      { method: "GET", url: "/api/capabilities" }, { method: "GET", url: "/api/projects" },
      { method: "GET", url: "/api/browse" }, { method: "POST", url: "/api/directories" }, { method: "PATCH", url: "/api/projects/id" },
      { method: "GET", url: "/api/projects/id/conversations" }, { method: "POST", url: "/api/projects/id/conversations" },
      { method: "GET", url: "/api/conversations/id/history" }, { method: "GET", url: "/api/conversations/id/events" }, { method: "PATCH", url: "/api/conversations/id/model" },
      { method: "POST", url: "/api/projects/id/sessions/session/attach-live" },
      { method: "POST", url: "/api/conversations/id/actions" }, { method: "GET", url: "/api/models" }, { method: "GET", url: "/api/runtime" },
    ];
    for (const request of requests) expect((await app.inject(request)).statusCode, `${request.method} ${request.url}`).toBe(401);
    await app.close();
  });

  it("accepts browser-style authenticated GET requests without Origin, content type, or CSRF", async () => {
    const { app, headers } = await fixture();
    const browserHeaders = { cookie: headers.cookie };
    for (const url of ["/api/projects", "/api/capabilities", "/api/runtime"]) {
      const response = await app.inject({ method: "GET", url, headers: browserHeaders });
      expect(response.statusCode, url).toBe(200);
      expect(response.json().ok, url).toBe(true);
    }
    await app.close();
  });

  it("returns detailed model catalog results and unavailable reason", async () => {
    const modelCatalog = {
      listModels: async () => ["cx/model-a"],
      listModelsDetailed: async () => ({ models: ["cx/model-a"], source: "omp" as const, reason: null }),
    };
    const configured = await fixture({ modelCatalog });
    const browserHeaders = { cookie: configured.headers.cookie };
    const response = await configured.app.inject({ method: "GET", url: "/api/models", headers: browserHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ models: ["cx/model-a"], source: "omp", reason: null });
    await configured.app.close();

    const unconfigured = await fixture();
    const missing = await unconfigured.app.inject({ method: "GET", url: "/api/models", headers: { cookie: unconfigured.headers.cookie } });
    expect(missing.statusCode).toBe(200);
    expect(missing.json().data).toMatchObject({ models: [], source: "unavailable", reason: expect.stringMatching(/not configured/i) });
    await unconfigured.app.close();
  });

  it("rejects missing and disallowed Origin on state-changing requests", async () => {
    const { app, headers } = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: headers.cookie, "x-caw-csrf": headers["x-caw-csrf"] }, payload: { path: "/tmp" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/projects", headers: { ...headers, origin: "https://evil.test" }, payload: { path: "/tmp" } })).statusCode).toBe(403);
    await app.close();
  });

  it("rejects bodies over 64 KiB", async () => {
    const { app, headers } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/projects", headers, payload: { path: "/tmp/project", label: "x".repeat(70 * 1024) } });
    expect(response.statusCode).toBe(413);
    expect(response.json().ok).toBe(false);
    await app.close();
  });

  it("deletes project metadata but never removes filesystem paths", async () => {
    const { app, headers, dir } = await fixture();
    const projectDir = join(dir, "project"); await mkdir(projectDir);
    const created = await app.inject({ method: "POST", url: "/api/projects", headers, payload: { path: projectDir } });
    expect(created.statusCode).toBe(201);
    const id: string = created.json().data.id;
    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers });
    expect(deleted.json().data.filesRemoved).toBe(false);
    expect((await stat(projectDir)).isDirectory()).toBe(true);
    await app.close();
  });

  it("creates exactly one directory under an allowed parent", async () => {
    const { app, headers, dir } = await fixture();
    const parent = join(dir, "workspace");
    await mkdir(parent);
    const response = await app.inject({ method: "POST", url: "/api/directories", headers, payload: { path: parent, name: "new-folder" } });
    const createdPath = join(parent, "new-folder");
    expect(response.statusCode).toBe(201);
    expect(response.json().data.path).toBe(createdPath);
    expect((await stat(createdPath)).isDirectory()).toBe(true);
    await app.close();
  });

  it("rejects invalid names, unsafe parents, and existing targets without creating anything", async () => {
    const { app, headers, dir } = await fixture();
    const parent = join(dir, "workspace");
    await mkdir(parent);
    const outsideParent = await mkdtemp(join(tmpdir(), "caw-outside-")); dirs.push(outsideParent);
    const fileParent = join(parent, "parent-file");
    await writeFile(fileParent, "file");
    const existing = join(parent, "occupied");
    await mkdir(existing);
    const before = await readdir(parent);
    const invalidNames = ["..", ".", "", "   ", "sub/name", "sub\\name", "/etc/foo", "x".repeat(65), "control\nname"];

    for (const name of invalidNames) {
      const response = await app.inject({ method: "POST", url: "/api/directories", headers, payload: { path: parent, name } });
      expect(response.statusCode, JSON.stringify(name)).toBe(400);
      expect(response.json().error.code).toBe("bad_request");
      expect(await readdir(parent)).toEqual(before);
    }

    const outside = await app.inject({ method: "POST", url: "/api/directories", headers, payload: { path: outsideParent, name: "outside" } });
    expect(outside.statusCode).toBe(403);
    expect(await stat(join(outsideParent, "outside")).then(() => true, () => false)).toBe(false);

    const nonDirectory = await app.inject({ method: "POST", url: "/api/directories", headers, payload: { path: fileParent, name: "child" } });
    expect(nonDirectory.statusCode).toBe(400);
    expect(nonDirectory.json().error.code).toBe("not_a_directory");
    expect(await readdir(parent)).toEqual(before);

    const conflict = await app.inject({ method: "POST", url: "/api/directories", headers, payload: { path: parent, name: "occupied" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("already_exists");
    expect(await readdir(parent)).toEqual(before);

    const nfdName = "cafe\u0301";
    await mkdir(join(parent, nfdName));
    const countBefore = (await readdir(parent)).length;
    const nfcConflict = await app.inject({ method: "POST", url: "/api/directories", headers, payload: { path: parent, name: "café" } });
    expect(nfcConflict.statusCode).toBe(409);
    expect(nfcConflict.json().error.code).toBe("already_exists");
    expect((await readdir(parent)).length).toBe(countBefore);
    await app.close();
  });

  it("serves stable browse pages and rejects oversized or forged paging requests", async () => {
    const { app, headers, dir } = await fixture();
    const workspace = join(dir, "browse");
    await mkdir(workspace);
    await Promise.all(Array.from({ length: 5 }, (_, index) => mkdir(join(workspace, `page-${index}`))));
    const query = (suffix: string) => `/api/browse?path=${encodeURIComponent(workspace)}${suffix}`;
    const first = await app.inject({ method: "GET", url: query("&limit=2"), headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ hasMore: true });
    expect(first.json().data.entries.map((entry: { name: string }) => entry.name)).toEqual(["page-0", "page-1"]);
    const cursor = first.json().data.nextCursor as string;
    const second = await app.inject({ method: "GET", url: query(`&limit=2&cursor=${encodeURIComponent(cursor)}`), headers });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.entries.map((entry: { name: string }) => entry.name)).toEqual(["page-2", "page-3"]);
    const last = await app.inject({ method: "GET", url: query(`&limit=2&cursor=${encodeURIComponent(second.json().data.nextCursor as string)}`), headers });
    expect(last.statusCode).toBe(200);
    expect(last.json().data).toMatchObject({ hasMore: false, nextCursor: null });
    expect(last.json().data.entries.map((entry: { name: string }) => entry.name)).toEqual(["page-4"]);
    const forged = await app.inject({ method: "GET", url: query("&cursor=forged"), headers });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.code).toBe("path_forbidden");
    const oversized = await app.inject({ method: "GET", url: query("&limit=501"), headers });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error.code).toBe("bad_request");
    await app.close();
  });
  it("reports filesystem permission failures as internal errors, not missing paths", async () => {
    const paths = {
      listDirectory: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
    } as unknown as WorkspacePathPolicy;
    const { app, headers } = await fixture({ paths });
    const response = await app.inject({ method: "GET", url: "/api/browse", headers });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({ code: "internal", message: "Permission denied while accessing workspace path" });
    await app.close();
  });

  it("reports filesystem I/O failures as internal errors with honest message", async () => {
    const paths = {
      listDirectory: async () => { throw Object.assign(new Error("io error"), { code: "EIO" }); },
    } as unknown as WorkspacePathPolicy;
    const { app, headers } = await fixture({ paths });
    const response = await app.inject({ method: "GET", url: "/api/browse", headers });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({ code: "internal", message: "Filesystem I/O error while accessing workspace path" });
    await app.close();
  });

  it("SEC-6: two conversations with identical titles get distinct launch names and neither is refused", async () => {
    const { dir, app, store } = await fixture();
    const runtimeSpec = createRuntimeSpec({
      store,
      paths: { assertInsideRoots: async (p) => p },
      catalog: { findBySessionId: async () => null, readHeader: async () => null },
    });

    const project = await store.createProject({ path: dir, label: "test-project" });
    const convA = await store.createConversation({ projectId: project.id, title: "Fix the bug" });
    const convB = await store.createConversation({ projectId: project.id, title: "Fix the bug" });

    const specA = await runtimeSpec(convA, {});
    const specB = await runtimeSpec(convB, {});
    // Distinct launch names derived from conversation ID
    expect(specA.name).not.toBe(specB.name);

    // Simulate tmux launch with duplicate name detection
    const launched = new Set<string>();
    const fakeTmuxLaunch = (name: string) => {
      if (launched.has(name)) throw new Error(`duplicate session: ${name}`);
      launched.add(name);
      return { id: `$${launched.size}`, name, alive: true, panePid: 1234 };
    };

    expect(() => fakeTmuxLaunch(specA.name)).not.toThrow();
    expect(() => fakeTmuxLaunch(specB.name)).not.toThrow();
    await app.close();
  });

  it("forwards a native-session resume request into an independent conversation", async () => {
    let getConversation: (id: string) => Promise<Conversation | null> = async () => null;
    let launchedSpec: RuntimeLaunchSpec | undefined;
    const supervisor = {
      start: async (_id: string, spec: RuntimeLaunchSpec) => (await getConversation(spec.conversationId))!,
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({
      supervisor,
      runtimeSpec: (conversation, input) => {
        const spec: RuntimeLaunchSpec = {
          conversationId: conversation.id,
          name: `resume-${conversation.id}`,
          cwd: dir,
          resumeSessionPath: input.resumeSessionId ? join(dir, "existing.jsonl") : undefined,
        };
        launchedSpec = spec;
        return spec;
      },
    });
    getConversation = (id) => store.getConversation(id);
    const project = await store.createProject({ path: dir, label: "resume-test" });
    const existing = await store.createConversation({ projectId: project.id, title: "Existing native session", nativeSessionId: "native-session-id" });
    const response = await app.inject({
      method: "POST", url: `/api/projects/${project.id}/conversations`, headers,
      payload: { title: "Resumed session", resumeSessionId: "native-session-id" },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(201);
    expect(response.json().data.id).not.toBe(existing.id);
    expect(response.json().data.nativeSessionId).toBe("native-session-id");
    expect(launchedSpec?.resumeSessionPath).toBe(join(dir, "existing.jsonl"));
    await app.close();
  });
  it("persists a model preference, rejects invalid models, and restarts with chosen model", async () => {
    let conversation: Conversation;
    let launchedModel: string | undefined;
    const runtimeSpec = (_current: Conversation, input: { resumeSessionId?: string; model?: string }): RuntimeLaunchSpec => ({
      conversationId: conversation.id,
      name: "model-test",
      cwd: "/tmp/model-test",
      model: input.model,
    });
    const supervisor = {
      start: async (_id: string, spec: RuntimeLaunchSpec) => {
        launchedModel = spec.model;
        return conversation;
      },
      stop: async () => conversation,
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({ runtimeSpec, supervisor });
    const project = await store.createProject({ path: dir });
    conversation = await store.createConversation({ projectId: project.id });
    const saved = await app.inject({ method: "PATCH", url: `/api/conversations/${conversation.id}/model`, headers, payload: { model: "  provider/model-x  " } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.modelPreference).toBe("provider/model-x");
    expect((await createMetadataStore(dir).getConversation(conversation.id))?.modelPreference).toBe("provider/model-x");
    for (const model of ["   ", "m".repeat(129)]) {
      expect((await app.inject({ method: "PATCH", url: `/api/conversations/${conversation.id}/model`, headers, payload: { model } })).statusCode).toBe(400);
    }
    const restarted = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(restarted.statusCode).toBe(200);
    expect(launchedModel).toBe("provider/model-x");
    await app.close();
  });
  it("restarts only when recorded session history can be resolved", async () => {
    let conversation: Conversation;
    let launched: RuntimeLaunchSpec | undefined;
    let launchCount = 0;
    let journalPath: string | null = null;
    let unreadable = false;
    let missingDuringHeaderRead = false;
    let mismatchHeader = false;
    let headerReadFails = false;
    let runtimeSpec: (conversation: Conversation, input: { resumeSessionId?: string; model?: string }) => Promise<RuntimeLaunchSpec>;
    const supervisor = {
      start: async (_id: string, spec: RuntimeLaunchSpec) => {
        launched = spec;
        launchCount += 1;
        conversation = (await store.updateConversation(conversation.id, { state: "idle", tmuxSessionId: "$2" }))!;
        return conversation;
      },
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({
      supervisor,
      runtimeSpec: (...args) => runtimeSpec(...args),
    });
    runtimeSpec = createRuntimeSpec({
      store,
      paths: { assertInsideRoots: async (path) => path },
      catalog: {
        findBySessionId: async (id) => {
          if (unreadable) throw Object.assign(new Error("EACCES: session catalog unreadable"), { code: "EACCES" });
          return id === "journal-session" ? journalPath : null;
        },
        readHeader: async (path) => {
          if (path !== journalPath) return null;
          if (missingDuringHeaderRead) throw Object.assign(new Error("journal was removed"), { code: "ENOENT" });
          if (headerReadFails) throw Object.assign(new Error("journal read denied"), { code: "EACCES" });
          return { sessionId: mismatchHeader ? "wrong-session" : "journal-session", cwd: dir, timestamp: null, version: null, title: null };
        },
      },
    });
    const project = await store.createProject({ path: dir });

    conversation = await store.createConversation({ projectId: project.id });
    const fresh = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(fresh.statusCode).toBe(200);
    expect(launched).toMatchObject({ resumeSessionPath: undefined });
    const afterFresh = launchCount;

    conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "missing-journal" });
    const missing = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
    expect(launchCount).toBe(afterFresh);

    unreadable = true;
    conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "journal-session" });
    const failedCatalog = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(failedCatalog.statusCode).toBe(500);
    expect(launchCount).toBe(afterFresh);
    unreadable = false;

    journalPath = `${dir}/journal.jsonl`;
    missingDuringHeaderRead = true;
    const disappeared = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(disappeared.statusCode).toBe(404);
    expect(disappeared.json().error.code).toBe("not_found");
    expect(launchCount).toBe(afterFresh);
    missingDuringHeaderRead = false;

    headerReadFails = true;
    const unreadableHeader = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(unreadableHeader.statusCode).toBe(500);
    expect(launchCount).toBe(afterFresh);
    headerReadFails = false;

    journalPath = `${dir}/journal.jsonl`;
    mismatchHeader = true;
    const badHeaderConversation = await store.createConversation({ projectId: project.id, nativeSessionId: "journal-session" });
    const badHeader = await app.inject({ method: "POST", url: `/api/conversations/${badHeaderConversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(badHeader.statusCode).toBe(409);
    expect(launchCount).toBe(afterFresh);
    mismatchHeader = false;

    const good = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(good.statusCode).toBe(200);
    expect(launched?.resumeSessionPath).toBe(journalPath);
    await app.close();
  });

  it("restarts fresh when journal is absent, resumes existing journal, and rejects unknown explicit session", async () => {
    let conversation: Conversation;
    let launched: RuntimeLaunchSpec | undefined;
    let journalPath: string | null = null;
    let runtimeSpec: (conversation: Conversation, input: { resumeSessionId?: string; model?: string }) => Promise<RuntimeLaunchSpec>;
    const supervisor = {
      start: async (_id: string, spec: RuntimeLaunchSpec) => {
        launched = spec;
        conversation = (await store.updateConversation(conversation.id, { state: "idle", tmuxSessionId: "$2" }))!;
        return conversation;
      },
      stop: async (id: string) => {
        conversation = (await store.updateConversation(id, { state: "stopped", tmuxSessionId: null }))!;
        return conversation;
      },
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({
      supervisor,
      runtimeSpec: (...args) => runtimeSpec(...args),
    });
    runtimeSpec = createRuntimeSpec({
      store,
      paths: { assertInsideRoots: async (path) => path },
      catalog: {
        findBySessionId: async (id) => {
          if (id === "unreadable-catalog") throw Object.assign(new Error("EACCES: session catalog unreadable"), { code: "EACCES" });
          return id === "journal-session" ? journalPath : null;
        },
        readHeader: async (path) => path === journalPath ? { sessionId: "journal-session", cwd: dir } : null,
      },
    });
    const project = await store.createProject({ path: dir });
    conversation = await store.createConversation({ projectId: project.id });
    const freshRestart = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(freshRestart.statusCode).toBe(200);
    expect(launched).toMatchObject({ resumeSessionPath: undefined });

    conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "missing-journal" });
    await store.updateConversation(conversation.id, { modelPreference: "provider/chosen-model" });
    const missingRestart = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(missingRestart.statusCode).toBe(404);
    expect(missingRestart.json().error.code).toBe("not_found");
    expect(launched?.resumeSessionPath).toBeUndefined();
    conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "unreadable-catalog" });
    const unreadableRestart = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(unreadableRestart.statusCode).toBe(500);
    expect(launched?.resumeSessionPath).toBeUndefined();


    journalPath = `${dir}/journal.jsonl`;
    conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "journal-session" });
    const resumedRestart = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(resumedRestart.statusCode).toBe(200);
    expect(launched?.resumeSessionPath).toBe(journalPath);

    const unknown = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      headers,
      payload: { resumeSessionId: "unknown-session" },
    });
    expect(unknown.statusCode, JSON.stringify(unknown.json())).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
    await app.close();
  });
  it("ARCH-2: attach command uses private socket only for matching server identity", async () => {
    const { app, headers, store } = await fixture({ tmuxSocketPath: "/private/caw/tmux.sock", tmuxServerIdentity: async () => "start:123" });
    const project = await store.createProject({ path: "/tmp/p" });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.updateConversation(conversation.id, { ownership: "managed", tmuxSessionId: "$17", tmuxSessionName: "caw-test", tmuxServerIdentity: "start:123" });
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/attach`, headers });
    expect(response.json().data).toMatchObject({ available: true, command: "tmux -S '/private/caw/tmux.sock' attach -t '$17'", reason: null });
    await app.close();
  });

  it("ARCH-2: attach refuses a reused tmux id when server identity differs or is absent", async () => {
    const { app, headers, store } = await fixture({ tmuxSocketPath: "/private/caw/tmux.sock", tmuxServerIdentity: async () => "live:456" });
    const project = await store.createProject({ path: "/tmp/p" });
    const mismatched = await store.createConversation({ projectId: project.id });
    await store.updateConversation(mismatched.id, { ownership: "managed", tmuxSessionId: "$4", tmuxServerIdentity: "old:123" });
    const mismatchResponse = await app.inject({ method: "GET", url: `/api/conversations/${mismatched.id}/attach`, headers });
    expect(mismatchResponse.json().data).toMatchObject({ available: false, command: null, reason: expect.stringContaining("does not match") });

    const missing = await store.createConversation({ projectId: project.id });
    await store.updateConversation(missing.id, { ownership: "managed", tmuxSessionId: "$4" });
    const missingResponse = await app.inject({ method: "GET", url: `/api/conversations/${missing.id}/attach`, headers });
    expect(missingResponse.json().data).toMatchObject({ available: false, command: null, reason: expect.stringContaining("cannot be verified") });
    await app.close();
  });
  it("reports unknown active count without claiming zero agents", async () => {
    const { app, headers } = await fixture({ supervisor: { activeCount: async () => ({ count: 0, known: false, reason: "tmux enumeration failed" }) } as unknown as Supervisor });
    const response = await app.inject({ method: "GET", url: "/api/runtime", headers });
    expect(response.json().data).toMatchObject({ activeCount: null, activeCountReason: "tmux enumeration failed" });
    await app.close();
  });

  it("SEC-11: 404 does not echo query string or request.url", async () => {
    const { app, headers } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/nonexistent-route?token=SECRET_BEARER_TOKEN_12345",
      headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("SECRET_BEARER_TOKEN_12345");
    expect(response.json().message).toBe("Route GET:/api/nonexistent-route not found");
    await app.close();
  });
});

describe("native session history route", () => {
  it("returns bounded history by conversation session and canonical project cwd", async () => {
    let requested: { sessionId: string; expectedCwd: string; before?: string } | null = null;
    const history: NativeSessionHistory = {
      header: { sessionId: "native-123", cwd: "", timestamp: "2026-10-26T00:00:00.000Z", version: 3, title: null },
      entries: [{ type: "message", role: "user", content: "stored" }],
      truncated: true,
      truncatedByBytes: false,
      truncatedByEntries: true,
      skippedOversized: false,
      hasOlder: true,
      nextCursor: "cursor",
    };
    const { app, headers, dir, store } = await fixture({
      readNativeHistory: async (sessionId, expectedCwd, options) => { requested = { sessionId, expectedCwd, ...(options?.before ? { before: options.before } : {}) }; history.header.cwd = expectedCwd; return history; },
    });
    const projectPath = join(dir, "project");
    await mkdir(projectPath);
    const project = await store.createProject({ path: projectPath });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-123" });
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/history?path=/etc/passwd`, headers });
    expect(response.statusCode).toBe(200);
    expect(requested).toEqual({ sessionId: "native-123", expectedCwd: projectPath });
    expect(response.json().data).toMatchObject({ header: { sessionId: "native-123" }, entries: [{ content: "stored" }], truncated: true, hasOlder: true, nextCursor: "cursor" });
    await app.close();
  });

  it("forwards opaque before cursors and preserves older-page metadata", async () => {
    let requested: { sessionId: string; before?: string } | null = null;
    const { app, headers, dir, store } = await fixture({
      readNativeHistory: async (sessionId, expectedCwd, options) => {
        requested = { sessionId, before: options?.before };
        return {
          header: { sessionId, cwd: expectedCwd, timestamp: null, version: 3, title: null },
          entries: [{ id: "older", type: "message" }],
          truncated: true, truncatedByBytes: true, truncatedByEntries: false,
          skippedOversized: false,
          hasOlder: true, nextCursor: "next-opaque-cursor",
        };
      },
    });
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-page" });
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/history?before=opaque-cursor`, headers });
    expect(response.statusCode).toBe(200);
    expect(requested).toEqual({ sessionId: "native-page", before: "opaque-cursor" });
    expect(response.json().data).toMatchObject({ entries: [{ id: "older" }], truncatedByBytes: true, truncatedByEntries: false, hasOlder: true, nextCursor: "next-opaque-cursor" });
    await app.close();
  });

  it("maps a forged history cursor to path_forbidden", async () => {
    const { app, headers, dir, store } = await fixture({
      readNativeHistory: async () => { throw Object.assign(new Error("Invalid history cursor"), { code: "path_forbidden" }); },
    });
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "native-page" });
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/history?before=forged`, headers });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("path_forbidden");
    await app.close();
  });

  it("preserves live-lease refusal for saved history", async () => {
    const { app, headers, dir, store } = await fixture({
      readNativeHistory: async () => { throw Object.assign(new Error("Native session is live"), { code: "conflict_owner" }); },
    });
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id, nativeSessionId: "live-history" });
    const response = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/history`, headers });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict_owner");
    await app.close();
  });

  it("returns clear errors for missing and foreign journals", async () => {
    const { app, headers, dir, store } = await fixture({
      readNativeHistory: async (sessionId, expectedCwd) => {
        if (sessionId === "missing-native") throw Object.assign(new Error("missing"), { code: "not_found" });
        return { header: { sessionId, cwd: join(dir, "other"), timestamp: null, version: 3, title: null }, entries: [], truncated: false, truncatedByBytes: false, truncatedByEntries: false, skippedOversized: false, hasOlder: false, nextCursor: null };
      },
    });
    const projectPath = join(dir, "project");
    const otherPath = join(dir, "other");
    await mkdir(projectPath);
    await mkdir(otherPath);
    const project = await store.createProject({ path: projectPath });
    const missing = await store.createConversation({ projectId: project.id, nativeSessionId: "missing-native" });
    const foreign = await store.createConversation({ projectId: project.id, nativeSessionId: "foreign-native" });
    const missingResponse = await app.inject({ method: "GET", url: `/api/conversations/${missing.id}/history`, headers });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.json().error.code).toBe("not_found");
    const foreignResponse = await app.inject({ method: "GET", url: `/api/conversations/${foreign.id}/history`, headers });
    expect(foreignResponse.statusCode).toBe(403);
    expect(foreignResponse.json().error.code).toBe("path_forbidden");
    await app.close();
  });
});

describe("native session host availability", () => {
  const session = { sessionId: "native-listed", path: "/workspace/session.jsonl", cwd: "/workspace", title: null, updatedAt: null, live: true as const, tracked: false };
  const host = { instanceId: "host-listed", generation: 1, pid: 12, sessionId: "native-listed", sessionName: null, cwd: "/workspace", model: null, startedAt: null, participants: 0, relayConnected: true, inputRequired: null, busy: null, access: "view" as const };

  it("reports only matching connected host rows and false when absent", async () => {
    let registryReads = 0;
    const { app, headers, dir, store } = await fixture({
      listNativeSessions: async () => [session, { ...session, sessionId: "no-host" }],
      listCollabHosts: async () => { registryReads++; return [host]; },
    });
    const project = await store.createProject({ path: dir });
    const response = await app.inject({ method: "GET", url: `/api/projects/${project.id}/sessions`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: NativeSessionSummary) => [row.sessionId, row.hasCollabHost])).toEqual([["native-listed", true], ["no-host", false]]);
    expect(registryReads).toBe(1);
    await app.close();
  });

  it("does not turn an unreadable registry into a false negative", async () => {
    const { app, headers, dir, store } = await fixture({
      listNativeSessions: async () => [session],
      listCollabHosts: async () => { throw Object.assign(new Error("registry read failed"), { code: "EIO" }); },
    });
    const project = await store.createProject({ path: dir });
    const response = await app.inject({ method: "GET", url: `/api/projects/${project.id}/sessions`, headers });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("internal");
    expect(response.json().data).toBeUndefined();
    await app.close();
  });
});

describe("live native session attachment", () => {
  const host = {
    instanceId: "host-live",
    generation: 3,
    pid: 42,
    sessionId: "native-live",
    sessionName: null,
    cwd: "",
    model: null,
    startedAt: null,
    participants: 0,
    relayConnected: true,
    inputRequired: false,
    busy: false,
    access: "view" as const,
  };

  it("registers an external observer without constructing a launch spec", async () => {
    let specs = 0;
    let starts = 0;
    const supervisor = { start: async () => { starts++; throw new Error("writer must not start"); } } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({
      supervisor,
      runtimeSpec: () => { specs++; throw new Error("launch spec must not be built"); },
      listNativeSessions: async ({ projectPath }) => [{ sessionId: "native-live", path: join(projectPath, "session.jsonl"), cwd: projectPath, title: "Live title", updatedAt: null, live: true, tracked: false }],
      findLiveHost: async () => ({ ...host, cwd: dir }),
    });
    const project = await store.createProject({ path: dir });
    const url = `/api/projects/${project.id}/sessions/native-live/attach-live`;
    const first = await app.inject({ method: "POST", url, headers });
    const second = await app.inject({ method: "POST", url, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ ownership: "external", nativeSessionId: "native-live", title: "Live title", tmuxSessionId: null, tmuxServerIdentity: null });
    expect(second.json().data.id).toBe(first.json().data.id);
    expect((await store.listConversations(project.id))).toHaveLength(1);
    expect(starts).toBe(0);
    expect(specs).toBe(0);
    await app.close();
  });

  it("refuses missing host, foreign cwd and unknown sessions without registration", async () => {
    const { app, headers, dir, store } = await fixture({
      listNativeSessions: async ({ projectPath }) => [
        { sessionId: "no-host", path: join(projectPath, "a.jsonl"), cwd: projectPath, title: null, updatedAt: null, live: true, tracked: false },
        { sessionId: "foreign", path: join(projectPath, "b.jsonl"), cwd: join(dir, "other"), title: null, updatedAt: null, live: true, tracked: false },
      ],
      findLiveHost: async (id) => id === "no-host" ? null : { ...host, sessionId: id, cwd: dir },
    });
    const project = await store.createProject({ path: dir });
    await mkdir(join(dir, "other"));
    const missingHost = await app.inject({ method: "POST", url: `/api/projects/${project.id}/sessions/no-host/attach-live`, headers });
    expect(missingHost.statusCode).toBe(409);
    expect(missingHost.json().error.code).toBe("link_unavailable");
    const foreign = await app.inject({ method: "POST", url: `/api/projects/${project.id}/sessions/foreign/attach-live`, headers });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("path_forbidden");
    const unknown = await app.inject({ method: "POST", url: `/api/projects/${project.id}/sessions/unknown/attach-live`, headers });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
    expect(await store.listConversations(project.id)).toEqual([]);
    await app.close();
  });

  it("refuses disconnected hosts and unknown writer leases", async () => {
    const { app, headers, dir, store } = await fixture({
      listNativeSessions: async ({ projectPath }) => [
        { sessionId: "lease-no-host", path: join(projectPath, "a.jsonl"), cwd: projectPath, title: null, updatedAt: null, live: true, tracked: false },
        { sessionId: "lease-unknown", path: join(projectPath, "b.jsonl"), cwd: projectPath, title: null, updatedAt: null, live: "unknown", tracked: false },
      ],
      findLiveHost: async (id) => id === "lease-no-host" ? { ...host, sessionId: id, relayConnected: false, cwd: dir } : null,
    });
    const project = await store.createProject({ path: dir });
    for (const id of ["lease-no-host", "lease-unknown"]) {
      const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/sessions/${id}/attach-live`, headers });
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe(id === "lease-unknown" ? "conflict_owner" : "link_unavailable");
    }
    expect(await store.listConversations(project.id)).toEqual([]);
    await app.close();
  });
});

describe("project deletion guard", () => {
  it("refuses to delete a project that still records conversations, and keeps their rows", async () => {
    const { app, headers, dir, store } = await fixture();
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id });
    // No supervisor is configured, so the gate falls back to the stored label.
    // `starting` may have a launch in progress; it must not be deleted.
    const refused = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("conflict_owner");
    expect((await store.listProjects()).map((item) => item.id)).toEqual([project.id]);
    expect((await store.listConversations(project.id)).map((item) => item.id)).toEqual([conversation.id]);
    await app.close();
  });

  it("deletes a project whose conversations are recorded as stopped, without touching files", async () => {
    const { app, headers, dir, store } = await fixture();
    const projectDir = join(dir, "project"); await mkdir(projectDir);
    const project = await store.createProject({ path: projectDir });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.updateConversation(conversation.id, { state: "stopped" });
    const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.filesRemoved).toBe(false);
    expect(await store.listProjects()).toEqual([]);
    // The conversation row goes with it: a row pointing at a deleted project can
    // neither be navigated nor restarted, and would hide the native session as
    // "already tracked" if the folder were added again.
    expect(await store.listConversations(project.id)).toEqual([]);
    expect((await stat(projectDir)).isDirectory()).toBe(true);
    await app.close();
  });

  it("refuses to delete a conversation whose launch is still in flight", async () => {
    // The launch window: the process may already exist but nothing is recorded yet,
    // so every stored field still reads "nothing running". Deleting the row here
    // would drop the only pointer to a process that is being started this instant.
    const supervisor = { isLaunching: () => true, observe: async () => null } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({ supervisor });
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id });
    const refused = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("conflict_owner");
    expect((await store.listConversations(project.id)).map((item) => item.id)).toEqual([conversation.id]);
    await app.close();
  });

  it("refuses when a launch reservation appears after the observation but before the delete commits", async () => {
    // The V16-01 window the loop alone cannot close: the row was observed and
    // verified stopped, then a start reserved the session while the observation was
    // still in flight. The row still reads process-free, so only the reservation —
    // asked inside the queued delete, and again inside its append — can stop the
    // delete from dropping the only pointer to a starting process.
    let observed = false;
    const supervisor = {
      // False during the observation loop (nothing was launching yet), true the
      // moment the loop's `observe` has run — exactly the race being pinned.
      isLaunching: () => observed,
      observe: async () => { observed = true; return null; },
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({ supervisor });
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id });
    await store.updateConversation(conversation.id, { state: "stopped" });
    const refused = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("conflict_owner");
    expect((await store.listProjects()).map((item) => item.id)).toEqual([project.id]);
    expect((await store.listConversations(project.id)).map((item) => item.id)).toEqual([conversation.id]);
    await app.close();
  });

  it("refuses to delete while a launch reservation is retained, and never auto-kills", async () => {
    // The retained state from the runtime: a launch created a process it could not
    // record and could not kill, so the reservation is deliberately held and the
    // row keeps the tmux identity. That reservation is the only thing marking the
    // session as taken, so DELETE must refuse — the project stays, the row stays,
    // and no kill is attempted. Recovery is a restart plus manual accounting, which
    // this test does not (and must not) perform.
    const { app: initialApp, headers, store, dir, auth, config } = await fixture();
    await initialApp.close();
    const project = await store.createProject({ path: dir });
    const conversation = await store.createConversation({ projectId: project.id });
    const killed: string[] = [];
    const adapters = {
      listManagedTmux: async () => [], listHosts: async () => [], isSessionLive: async () => false,
      tmuxServerIdentity: async () => "private:1", getTmux: async () => ({ ok: true as const, session: null }),
      sessionPathExists: async () => true, findBySessionId: async () => null,
      isProcessDescendant: async () => false, newestSessionFor: async () => null,
      launch: async () => ({ id: "$7", name: "pane", alive: true, panePid: 1_000_000_000, serverIdentity: "private:1" }),
      killTmux: async (id: string) => { killed.push(id); throw new Error("injected guarded kill failure"); },
    };
    const supervisor = createSupervisor({ store, adapters: adapters as never, maxActive: 3, publishTimeoutMs: 0 });
    const app = buildApp({ config, auth, store, supervisor, originAllowlist: ["https://workspace.test"] });

    // The launch records a process it cannot persist (store write fails) and the
    // undo kill fails, so ownership is retained.
    const originalUpdate = store.updateConversation.bind(store);
    let failNext = true;
    store.updateConversation = async (id, patch) => {
      if (failNext && patch.tmuxSessionId) { failNext = false; throw new Error("simulated store write failure"); }
      return originalUpdate(id, patch);
    };
    await expect(supervisor.start(conversation.id, { conversationId: conversation.id, name: "caw", cwd: dir }))
      .rejects.toThrow(/simulated store write failure/);
    store.updateConversation = originalUpdate;

    expect(supervisor.isLaunching(conversation.id)).toBe(true);
    expect(killed).toEqual(["$7"]);

    const refused = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("conflict_owner");
    // Both rows survive: the retained reservation keeps the only pointer to the
    // process alive. And the delete never tried to kill anything itself.
    expect((await store.listProjects()).map((row) => row.id)).toEqual([project.id]);
    expect((await store.listConversations(project.id)).map((row) => row.id)).toEqual([conversation.id]);
    expect(killed).toEqual(["$7"]);
    await app.close();
  });

  it("refuses to delete a project holding an external session with a live writer", async () => {
    // An external (attach-live) row has no managed pane, but a live writer still
    // exists behind it. The gate must consult the observation, not just the label.
    const supervisor = {
      isLaunching: () => false,
      observe: async () => ({
        tmux: null, host: null, leaseLive: true, sessionPathExists: true, sessionPathReason: null,
        hasNativeSession: true, everLaunched: false, stopRequested: false, registryUnreadable: false,
        tmuxOwnershipUnknown: false, tmuxEnumerationFailed: false, hostMatchReason: null, recoveredHost: false,
      }),
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({ supervisor });
    const project = await store.createProject({ path: dir });
    const conversation = await store.registerExternalConversation({ projectId: project.id, nativeSessionId: "native-live", title: "Live", hostInstanceId: "host-1", hostGeneration: 1 });
    const refused = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("conflict_owner");
    expect((await store.listConversations(project.id)).map((item) => item.id)).toEqual([conversation.id]);
    await app.close();
  });
});

describe("refused conversation creation", () => {
  it("keeps the row marked as refused when the launch was refused before any process existed", async () => {
    // The row is the chat the user just created. Deleting it loses the only handle
    // they have to see the reason and retry; leaving it at `starting` would claim a
    // launch forever. It is kept with the refusal recorded and no process identity.
    const supervisor = { start: async () => { throw new RuntimeError("conflict_limit", "No active slots"); } } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({ supervisor, runtimeSpec: () => ({} as RuntimeLaunchSpec) });
    const project = await store.createProject({ path: dir });
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, headers, payload: {} });
    expect(response.statusCode).toBe(409);
    const rows = await store.listConversations(project.id);
    expect(rows.map((row) => row.state)).toEqual(["error"]);
    expect(rows[0]?.statusDetail).toBe("Agent launch was refused: No active slots");
    expect(rows[0]).toMatchObject({ tmuxSessionId: null, tmuxPanePid: null });
    expect(rows[0]?.state).not.toBe("starting");
    await app.close();
  });

  it("keeps the row when the launch recorded a process it could not complete", async () => {
    // The launch may have created a writer it could not record. Deleting the row
    // would lose the only pointer to a live process, so it is kept as `unknown`.
    let conversationId = "";
    const supervisor = {
      start: async (id: string) => {
        conversationId = id;
        await store.updateConversation(id, { state: "unknown", tmuxSessionId: "$7", tmuxServerIdentity: "private:1", tmuxPanePid: 4321, statusDetail: "The agent process was launched but could not be recorded." });
        throw new RuntimeError("agent_launch_failed", "The conversation disappeared before its launched agent could be recorded.");
      },
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({ supervisor, runtimeSpec: () => ({} as RuntimeLaunchSpec) });
    const project = await store.createProject({ path: dir });
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, headers, payload: {} });
    expect(response.statusCode).toBe(409);
    const rows = await store.listConversations(project.id);
    expect(rows.map((row) => row.id)).toEqual([conversationId]);
    expect(rows[0]).toMatchObject({ state: "unknown", tmuxSessionId: "$7" });
    await app.close();
  });

  it("keeps the row when the launch failed while the launch was still in flight", async () => {
    // The POST catch runs after `start` threw, but the reservation may still be held
    // because the process exists and could not be recorded. Removing the row would
    // lose that pointer, so the in-flight signal keeps it.
    let conversationId = "";
    const supervisor = {
      isLaunching: (id: string) => id === conversationId,
      start: async (id: string) => {
        conversationId = id;
        throw new RuntimeError("agent_launch_failed", "The agent process could not be recorded.");
      },
    } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({ supervisor, runtimeSpec: () => ({} as RuntimeLaunchSpec) });
    const project = await store.createProject({ path: dir });
    const response = await app.inject({ method: "POST", url: `/api/projects/${project.id}/conversations`, headers, payload: {} });
    expect(response.statusCode).toBe(409);
    expect((await store.listConversations(project.id)).map((row) => row.id)).toEqual([conversationId]);
    await app.close();
  });
});

describe("external restart refusal", () => {
  it("refuses before constructing a launch spec or starting a writer", async () => {
    let specs = 0;
    let starts = 0;
    const supervisor = { start: async () => { starts++; throw new Error("writer must not start"); }, stop: async () => { throw new Error("no managed writer"); } } as unknown as Supervisor;
    const { app, headers, dir, store } = await fixture({
      supervisor,
      runtimeSpec: () => { specs++; throw new Error("launch spec must not be built"); },
    });
    const project = await store.createProject({ path: dir });
    const conversation = await store.registerExternalConversation({ projectId: project.id, nativeSessionId: "native-live", title: "Live", hostInstanceId: "host-live", hostGeneration: 3 });
    const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/actions`, headers, payload: { action: "restart" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict_owner");
    expect(starts).toBe(0);
    expect(specs).toBe(0);
    await app.close();
  });
});
