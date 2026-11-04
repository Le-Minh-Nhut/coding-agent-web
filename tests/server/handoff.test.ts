import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { HandoffResult } from "@caw/omp-adapter";
import { createAuthenticationService } from "../../apps/server/src/auth";
import { buildApp } from "../../apps/server/src/app";
import { createMetadataStore } from "../../apps/server/src/store";
import type { ServerConfig } from "../../apps/server/src/config";

/**
 * The handoff route's refusal matrix.
 *
 * Handoff is a keystroke into a live agent's editor, so every precondition is a
 * refusal we can name. These cases drive the route with a stub adapter and assert
 * which facts earn a delivery and which earn a refusal — the same split the
 * adapter enforces, so the two halves cannot drift apart.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface HandoffInput { sessionId: string; expectedIdentity: string; expectedPanePid: number; assertIdle: () => Promise<boolean> }

async function fixture(options: {
  handoff?: (input: HandoffInput) => Promise<HandoffResult>;
  liveIdentity?: string | null;
  host?: { sessionId: string; access: "view" | "control"; relayConnected: boolean | null; busy: boolean | null; inputRequired: boolean | null } | null;
  conversation?: Record<string, unknown>;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "caw-handoff-route-"));
  dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir],
    relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720,
    trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false,
  };
  const store = createMetadataStore(dir);
  const app = buildApp({
    config, auth, store, originAllowlist: ["https://workspace.test"],
    sendHandoff: options.handoff ?? (async () => ({ delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 })),
    tmuxServerIdentity: async () => (options.liveIdentity === undefined ? "sock:1:2" : options.liveIdentity),
    findLiveHost: async () => (options.host === undefined
      ? { instanceId: "i", generation: 1, pid: 1, sessionId: "sess-1", sessionName: null, cwd: dir, model: null, startedAt: null, participants: 0, relayConnected: true, inputRequired: false, busy: false, access: "control" }
      : options.host) as never,
  });
  const session = auth.createSession();
  const headers = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
  const project = await store.createProject({ path: dir, label: "p" });
  const conversation = await store.createConversation({ projectId: project.id, title: "c" });
  await store.updateConversation(conversation.id, {
    ownership: "managed", state: "idle", nativeSessionId: "sess-1",
    tmuxSessionId: "$0", tmuxSessionName: "caw-c", tmuxServerIdentity: "sock:1:2", tmuxPanePid: 42,
    ...options.conversation,
  });
  return { app, headers, conversation, store };
}

const post = (app: FastifyInstance<HttpServer>, id: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: "POST", url: `/api/conversations/${id}/handoff`, headers, ...(payload === undefined ? {} : { payload }) });

describe("handoff route", () => {
  it("delivers the handoff for a managed, idle, control-access session", async () => {
    let received: HandoffInput | null = null;
    const { app, headers, conversation } = await fixture({ handoff: async (input) => { received = input; return { delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 }; } });
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ delivered: true, paneId: "%0" });
    expect(received).toMatchObject({ sessionId: "$0", expectedIdentity: "sock:1:2", expectedPanePid: 42 });
    // The route hands the adapter a real idleness proof, and it resolves true only
    // on positive registry evidence.
    expect(await received!.assertIdle()).toBe(true);
    await app.close();
  });

  it("refuses a non-managed conversation and one without a recorded tmux identity", async () => {
    const external = await fixture({ conversation: { ownership: "external" } });
    const externalResponse = await post(external.app, external.conversation.id, external.headers);
    expect(externalResponse.statusCode).toBe(409);
    expect(externalResponse.json().error.code).toBe("conflict_owner");
    await external.app.close();

    const untracked = await fixture({ conversation: { tmuxSessionId: null, tmuxServerIdentity: null, tmuxPanePid: null } });
    const untrackedResponse = await post(untracked.app, untracked.conversation.id, untracked.headers);
    expect(untrackedResponse.statusCode).toBe(409);
    expect(untrackedResponse.json().error.code).toBe("conflict_owner");
    await untracked.app.close();
  });

  it("refuses when the recorded tmux server is no longer the live one", async () => {
    const { app, headers, conversation } = await fixture({ liveIdentity: "other:9:9" });
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict_owner");
    await app.close();
  });

  it("never claims idle on absent registry evidence", async () => {
    const cases: Array<Record<string, unknown> | null> = [
      null,
      { sessionId: "sess-1", access: "control", relayConnected: true, busy: null, inputRequired: false },
      { sessionId: "sess-1", access: "control", relayConnected: true, busy: false, inputRequired: null },
      { sessionId: "sess-1", access: "control", relayConnected: null, busy: false, inputRequired: false },
      { sessionId: "sess-1", access: "view", relayConnected: true, busy: false, inputRequired: false },
    ];
    for (const host of cases) {
      let proof: boolean | null = null;
      const { app, headers, conversation } = await fixture({
        host: host as never,
        handoff: async (input) => { proof = await input.assertIdle(); return { delivered: false, refusal: "not_idle", reason: (proof ? "" : "not idle") as string } as HandoffResult; },
      });
      const response = await post(app, conversation.id, headers);
      expect(proof).toBe(false);
      expect(response.statusCode).toBe(409);
      await app.close();
    }
  });

  it("maps an attached terminal to its own code so the client can say 'run it yourself'", async () => {
    const { app, headers, conversation } = await fixture({
      handoff: async () => ({ delivered: false, refusal: "terminal_attached", reason: "A terminal is attached." }),
    });
    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("terminal_attached");
    await app.close();
  });

  it("maps every other adapter refusal to conflict_owner rather than a 500", async () => {
    for (const refusal of ["session_missing", "identity_changed", "pane_ambiguous", "pane_changed", "command_changed", "process_changed"] as const) {
      const { app, headers, conversation } = await fixture({ handoff: async () => ({ delivered: false, refusal, reason: "no" }) });
      const response = await post(app, conversation.id, headers);
      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("conflict_owner");
      await app.close();
    }
  });

  it("refuses a concurrent second handoff while the first is in flight", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { app, headers, conversation } = await fixture({
      handoff: async () => { await gate; return { delivered: true, sessionId: "$0", paneId: "%0", panePid: 42 }; },
    });
    const first = post(app, conversation.id, headers);
    // Let the first request enter the handler, then race the second.
    await new Promise((resolve) => setImmediate(resolve));
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("handoff_in_flight");
    release();
    expect((await first).statusCode).toBe(200);
    // The lock is released in `finally`, so a later request succeeds again.
    expect((await post(app, conversation.id, headers)).statusCode).toBe(200);
    await app.close();
  });

  it("refuses a non-empty focus argument with capability_missing", async () => {
    const { app, headers, conversation } = await fixture();
    const response = await post(app, conversation.id, headers, { focus: "editor" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("capability_missing");
    await app.close();
  });

  it("404s an unknown conversation and 501s when handoff is not configured", async () => {
    const { app, headers, conversation } = await fixture();
    expect((await post(app, "missing-id", headers)).statusCode).toBe(404);
    await app.close();

    const dir = await mkdtemp(join(tmpdir(), "caw-handoff-nocfg-"));
    dirs.push(dir);
    const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
    await auth.initAuth();
    const config: ServerConfig = {
      host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir],
      relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720,
      trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false,
    };
    const store = createMetadataStore(dir);
    const bare = buildApp({ config, auth, store, originAllowlist: ["https://workspace.test"] });
    const session = auth.createSession();
    const bareHeaders = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
    const project = await store.createProject({ path: dir, label: "p" });
    const row = await store.createConversation({ projectId: project.id, title: "c" });
    await store.updateConversation(row.id, { ownership: "managed", nativeSessionId: "sess-1", tmuxSessionId: "$0", tmuxServerIdentity: "sock:1:2", tmuxPanePid: 42 });
    const response = await post(bare, row.id, bareHeaders);
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe("capability_missing");
    await bare.close();
  });
});
