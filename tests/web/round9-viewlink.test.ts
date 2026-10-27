import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Conversation, CollabLinkResponse } from "@caw/contracts";
import { createAuthenticationService } from "../../apps/server/src/auth";
import { buildApp } from "../../apps/server/src/app";
import { createMetadataStore } from "../../apps/server/src/store";
import type { ServerConfig } from "../../apps/server/src/config";
import { createMintLink } from "../../apps/server/src/server";
import { api } from "../../apps/web/src/api.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options: { mintLink?: (conversation: Conversation, access: "control" | "view") => Promise<CollabLinkResponse> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "caw-web-view-link-"));
  dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792,
    relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720,
    trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false,
  };
  const store = createMetadataStore(dir);
  const app = buildApp({ config, auth, store, originAllowlist: ["https://workspace.test"], ...options });
  const session = auth.createSession();
  const headers = {
    cookie: `__Host-caw_session=${session.token}`,
    origin: "https://workspace.test",
    "x-caw-csrf": session.csrfToken,
  };
  const project = await store.createProject({ path: dir, label: "p" });
  const conversation = await store.createConversation({ projectId: project.id, title: "c" });
  await store.updateConversation(conversation.id, { nativeSessionId: "native-view" });
  return { app, headers, conversation, store };
}

describe("view-only live link through web API and real route", () => {
  it("offers explicit view access after the host refuses control, then returns a view link", async () => {
    const registry = {
      list: async () => [{ sessionId: "native-view", instanceId: "host-view", generation: 1, relayConnected: true, access: "view" as const }],
      link: async (_id: string, access: "view" | "control") => ({ instanceId: "host-view", generation: 1, access, url: "wss://relay.test/r/room.secret" }),
    };
    const { app, headers, conversation } = await fixture({ mintLink: createMintLink(registry) });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url, init) => {
        const response = await app.inject({ method: (init?.method ?? "GET") as "POST", url: String(url), headers });
        return new Response(response.body, { status: response.statusCode, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;

      const control = await api.getConversationLink(conversation.id);
      expect(control).toMatchObject({ ok: false, error: { code: "capability_missing" } });
      const view = await api.getConversationLink(conversation.id, "view");
      expect(view).toMatchObject({ ok: true, data: { access: "view", instanceId: "host-view", generation: 1 } });
    } finally {
      await app.close();
    }
  });
});
