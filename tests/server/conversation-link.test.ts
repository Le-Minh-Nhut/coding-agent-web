import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Conversation, CollabLinkResponse } from "@caw/contracts";
import { createAuthenticationService } from "../../apps/server/src/auth";
import { buildApp } from "../../apps/server/src/app";
import { createMetadataStore } from "../../apps/server/src/store";
import type { ServerConfig } from "../../apps/server/src/config";
import { createMintLink } from "../../apps/server/src/server";

/**
 * The live-session link route and the middleware that protects it.
 *
 * These cases exist because a bodiless POST is the one request shape that slips
 * through a naive "mutations must be JSON" check, and the link endpoint is the
 * one route a bodiless POST is *for*. Both bugs were real: the route 500'd and
 * the guard 415'd before a handler ran.
 */
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(options: { mintLink?: (conversation: Conversation, access: "control" | "view") => Promise<CollabLinkResponse> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "caw-link-"));
  dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 8791,
    stateDir: dir,
    allowedRoots: [dir],
    relayPort: 8792, relayAllowedOrigins: [],
    maxActiveAgents: 3,
    authTokenTtlHours: 720,
    trustTailscaleOrigin: false,
    logLevel: "silent",
    insecureCookies: false,
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
  return { app, headers, conversation, store };
}

describe("live session link route", () => {
  it("mints a link for a bodiless POST whose client declares JSON", async () => {
    const minted: CollabLinkResponse = { url: "wss://relay.test/r/room.key", access: "full", instanceId: "inst-1", generation: 3 };
    const { app, headers, conversation } = await fixture({ mintLink: async () => minted });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    // 200, not 415 and not 500: the endpoint takes no body and must not demand one.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: minted });
    // The response carries a bearer credential and must never be cached.
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("?access=view reaches mintLink with 'view' and response reports access: 'view'", async () => {
    let receivedAccess: string | undefined;
    const { app, headers, conversation } = await fixture({
      mintLink: async (_conv, access) => {
        receivedAccess = access;
        return { url: "wss://relay.test/r/room.key", access: "view", instanceId: "inst-1", generation: 3 };
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link?access=view`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(receivedAccess).toBe("view");
    expect(response.json().data.access).toBe("view");
    await app.close();
  });

  it("an invalid value like ?access=admin returns 400", async () => {
    const { app, headers, conversation } = await fixture({
      mintLink: async () => ({ url: "wss://relay.test/r/room.key", access: "full", instanceId: "inst-1", generation: 3 }),
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link?access=admin`,
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().ok).toBe(false);
    await app.close();
  });

  it("translates a stale room generation into a retryable conflict, not a 500", async () => {
    const { app, headers, conversation } = await fixture({
      mintLink: async () => {
        throw Object.assign(new Error("stale"), { code: "stale_generation" });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_generation");
    await app.close();
  });
  it("ARCH-3: rejects minting if returned room generation mismatches observed listing generation", async () => {
    const fakeRegistry = {
      list: async () => [
        { sessionId: "sess-1", instanceId: "inst-1", generation: 3, relayConnected: true },
      ],
      link: async () => ({
        instanceId: "inst-1",
        generation: 4,
        url: "wss://relay.test/r/successor-room.key",
      }),
    };
    const { app, headers, conversation, store } = await fixture({
      mintLink: createMintLink(fakeRegistry),
    });
    await store.updateConversation(conversation.id, { nativeSessionId: "sess-1" });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_generation");
    expect(response.body).not.toContain("successor-room");
    expect(response.json().data).toBeUndefined();
    await app.close();
  });

  it("ARCH-3: rejects minting if returned instanceId mismatches observed instanceId", async () => {
    const fakeRegistry = {
      list: async () => [
        { sessionId: "sess-1", instanceId: "inst-1", generation: 3, relayConnected: true },
      ],
      link: async () => ({
        instanceId: "inst-2",
        generation: 3,
        url: "wss://relay.test/r/other-room.key",
      }),
    };
    const { app, headers, conversation, store } = await fixture({
      mintLink: createMintLink(fakeRegistry),
    });
    await store.updateConversation(conversation.id, { nativeSessionId: "sess-1" });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_generation");
    expect(response.body).not.toContain("other-room");
    expect(response.json().data).toBeUndefined();
    await app.close();
  });
  it.each([
    ["generation", { instanceId: "inst-1" }],
    ["instanceId", { generation: 3 }],
  ])("ARCH-3: missing returned %s refuses the URL as stale_generation", async (_field, linkFields) => {
    const fakeRegistry = {
      list: async () => [{ sessionId: "sess-1", instanceId: "inst-1", generation: 3, relayConnected: true }],
      link: async () => ({ ...linkFields, url: "wss://relay.test/r/unverified-room.key" }),
    };
    const { app, headers, conversation, store } = await fixture({ mintLink: createMintLink(fakeRegistry) });
    await store.updateConversation(conversation.id, { nativeSessionId: "sess-1" });
    const response = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/link`, headers });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("stale_generation");
    expect(response.body).not.toContain("unverified-room");
    expect(response.json().data).toBeUndefined();
    await app.close();
  });

  it("ARCH-3: happy path mints URL when generation and instanceId match", async () => {
    const fakeRegistry = {
      list: async () => [
        { sessionId: "sess-1", instanceId: "inst-1", generation: 3, relayConnected: true },
      ],
      link: async () => ({
        instanceId: "inst-1",
        generation: 3,
        url: "wss://relay.test/r/valid-room.key",
      }),
    };
    const { app, headers, conversation, store } = await fixture({
      mintLink: createMintLink(fakeRegistry),
    });
    await store.updateConversation(conversation.id, { nativeSessionId: "sess-1" });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.url).toBe("wss://relay.test/r/valid-room.key");
    expect(response.json().data.generation).toBe(3);
    expect(response.json().data.instanceId).toBe("inst-1");
    await app.close();
  });

  it("reports an unavailable room as such instead of an internal error", async () => {
    const { app, headers, conversation } = await fixture({
      mintLink: async () => {
        throw Object.assign(new Error("not hosting"), { code: "link_unavailable" });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("link_unavailable");
    await app.close();
  });

  it("never leaks an internal failure message, which could contain a room URL", async () => {
    const { app, headers, conversation } = await fixture({
      mintLink: async () => {
        throw new Error("failed talking to wss://relay.test/r/room.SECRETKEY");
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("SECRETKEY");
    await app.close();
  });

  it("still requires a session", async () => {
    const { app, conversation } = await fixture({
      mintLink: async () => ({ url: "x", access: "full", instanceId: "i", generation: 1 }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers: { origin: "https://workspace.test" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("a direct relay link comes back as a deep link on the configured publicOrigin, with the room and secret untouched", async () => {
    const roomId = "0123456789abcdef";
    const secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8w";
    const fakeRegistry = {
      list: async () => [
        { sessionId: "sess-rewrite", instanceId: "inst-rewrite", generation: 1, relayConnected: true },
      ],
      link: async () => ({
        instanceId: "inst-rewrite",
        generation: 1,
        url: `ws://127.0.0.1:9999/r/${roomId}.${secret}`,
      }),
    };
    const publicOrigin = "http://127.0.0.1:8791";
    const { app, headers, conversation, store } = await fixture({
      mintLink: createMintLink(fakeRegistry, publicOrigin),
    });
    await store.updateConversation(conversation.id, { nativeSessionId: "sess-rewrite" });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    const rewritten = new URL(data.url);
    // The outer URL is the app the phone can reach; the room path lives in the
    // fragment, which no server ever sees. A path outside the fragment would put a
    // bearer credential into bytes that travel to our own logs and any proxy.
    expect(rewritten.origin).toBe(publicOrigin);
    expect(rewritten.pathname).toBe("/");
    const inner = new URL(rewritten.hash.slice(1));
    expect(inner.pathname).toBe(`/r/${roomId}.${secret}`);
    const returnedSecret = inner.pathname.split(".")[1]!;
    expect(returnedSecret).toBe(secret);
    expect(returnedSecret.length).toBe(secret.length);
    await app.close();
  });

  it("a link with deep-link fragment format comes back with publicOrigin in outer URL and WebSocket origin in fragment", async () => {
    const roomId = "0123456789abcdef";
    const secret = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8w";
    const fakeRegistry = {
      list: async () => [
        { sessionId: "sess-frag", instanceId: "inst-frag", generation: 2, relayConnected: true },
      ],
      link: async () => ({
        instanceId: "inst-frag",
        generation: 2,
        url: `http://127.0.0.1:8812/#ws://127.0.0.1:8812/r/${roomId}.${secret}`,
      }),
    };
    const publicOrigin = "https://phone.tailnet.ts.net";
    const { app, headers, conversation, store } = await fixture({
      mintLink: createMintLink(fakeRegistry, publicOrigin),
    });
    await store.updateConversation(conversation.id, { nativeSessionId: "sess-frag" });

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    const parsed = new URL(data.url);
    expect(parsed.origin).toBe("https://phone.tailnet.ts.net");
    expect(parsed.hash).toBe(`#wss://phone.tailnet.ts.net/r/${roomId}.${secret}`);
    await app.close();
  });

  it("a link whose path does not match /r/<id>.<key> is refused rather than rewritten", async () => {
    const badPaths = [
      "ws://127.0.0.1:9999/not-a-room-path",
      "ws://127.0.0.1:9999/r/no-secret-key",
      "ws://127.0.0.1:9999/api/conversations/123",
      "ws://127.0.0.1:9999/r/short.key",
    ];
    for (const badUrl of badPaths) {
      const fakeRegistry = {
        list: async () => [
          { sessionId: "sess-bad", instanceId: "inst-bad", generation: 1, relayConnected: true },
        ],
        link: async () => ({
          instanceId: "inst-bad",
          generation: 1,
          url: badUrl,
        }),
      };
      const { app, headers, conversation, store } = await fixture({
        mintLink: createMintLink(fakeRegistry, "http://127.0.0.1:8791"),
      });
      await store.updateConversation(conversation.id, { nativeSessionId: "sess-bad" });

      const response = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversation.id}/link`,
        headers,
      });

      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe("internal");
      await app.close();
    }
  });
});

describe("request-shape guard", () => {
  it("accepts a body-less POST that declares no content-type", async () => {
    // This is what a plain `fetch(url, {method:'POST'})` sends. Refusing it would
    // break every bodiless mutation.
    const { app, headers, conversation } = await fixture({
      mintLink: async () => ({ url: "wss://relay.test/r/room.key", access: "full", instanceId: "i", generation: 1 }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("still refuses a body that is not JSON", async () => {
    const { app, headers } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { ...headers, "content-type": "text/plain" },
      payload: "not json",
    });
    expect(response.statusCode).toBe(415);
    await app.close();
  });

  it("still requires an Origin on a state-changing request", async () => {
    const { app, headers, conversation } = await fixture({
      mintLink: async () => ({ url: "x", access: "full", instanceId: "i", generation: 1 }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers: { cookie: headers.cookie, "x-caw-csrf": headers["x-caw-csrf"] },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("serves an authenticated GET with no Origin, no content-type and no CSRF header", async () => {
    // Exactly what the browser sends when loading a screen.
    const { app, headers } = await fixture();
    const response = await app.inject({
      method: "GET",
      url: "/api/projects",
      headers: { cookie: headers.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ok).toBe(true);
    await app.close();
  });
});

describe("empty body declared as JSON", () => {
  it("is a client error, not an internal one", async () => {
    const { app, headers, conversation } = await fixture({
      mintLink: async () => ({ url: "wss://relay.test/r/room.key", access: "full", instanceId: "i", generation: 1 }),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversation.id}/link`,
      headers: { ...headers, "content-type": "application/json" },
      payload: "",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
    await app.close();
  });
});
