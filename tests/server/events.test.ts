import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import { buildApp } from "../../apps/server/src/app.js";
import { createMetadataStore } from "../../apps/server/src/store.js";
import type { ServerConfig } from "../../apps/server/src/config.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "caw-events-"));
  dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 8791,
    stateDir: dir,
    allowedRoots: [dir],
    relayPort: 8792,
    relayAllowedOrigins: [], maxActiveAgents: 3,
    authTokenTtlHours: 720,
    trustTailscaleOrigin: false,
    logLevel: "silent",
    insecureCookies: false,
  };
  const store = createMetadataStore(dir);
  const app = buildApp({ config, auth, store, originAllowlist: ["https://workspace.test"] });
  const session = auth.createSession();
  const headers = {
    cookie: `__Host-caw_session=${session.token}`,
    origin: "https://workspace.test",
    "x-caw-csrf": session.csrfToken,
  };
  return { app, headers, dir, store };
}

describe("GET /api/conversations/:id/events", () => {
  it("requires authentication like every other route", async () => {
    const { app } = await fixture();
    const res = await app.inject({ method: "GET", url: "/api/conversations/c-unknown/events" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
    await app.close();
  });

  it("returns 404 for an unknown conversation", async () => {
    const { app, headers } = await fixture();
    const res = await app.inject({
      method: "GET",
      url: "/api/conversations/nonexistent-id/events",
      headers,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    await app.close();
  });

  it("rejects bad query parameters with 400 bad_request", async () => {
    const { app, headers, store } = await fixture();
    const project = await store.createProject({ path: "/tmp/p" });
    const conv = await store.createConversation({ projectId: project.id });

    // Negative after
    const res1 = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events?after=-1`,
      headers,
    });
    expect(res1.statusCode).toBe(400);
    expect(res1.json().error.code).toBe("bad_request");

    // Invalid non-numeric limit
    const res2 = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events?limit=abc`,
      headers,
    });
    expect(res2.statusCode).toBe(400);
    expect(res2.json().error.code).toBe("bad_request");

    // Zero limit
    const res3 = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events?limit=0`,
      headers,
    });
    expect(res3.statusCode).toBe(400);
    expect(res3.json().error.code).toBe("bad_request");

    await app.close();
  });

  it("caps limit to 500 and defaults to 100", async () => {
    const { app, headers, store } = await fixture();
    const project = await store.createProject({ path: "/tmp/p" });
    const conv = await store.createConversation({ projectId: project.id });

    // Record 550 events
    for (let i = 1; i <= 550; i++) {
      await store.recordEvent(conv.id, "test.event", { n: i });
    }

    // Default limit should return 100 events
    const resDefault = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events`,
      headers,
    });
    expect(resDefault.statusCode).toBe(200);
    const dataDefault = resDefault.json().data;
    expect(dataDefault.events.length).toBe(100);
    expect(dataDefault.nextAfter).toBe(100);

    // Explicit limit above 500 should be capped to 500
    const resCapped = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events?limit=9999`,
      headers,
    });
    expect(resCapped.statusCode).toBe(200);
    const dataCapped = resCapped.json().data;
    expect(dataCapped.events.length).toBe(500);
    expect(dataCapped.nextAfter).toBe(500);

    await app.close();
  });

  it("pages through the timeline in seq order and signals nextAfter null at end", async () => {
    const { app, headers, store } = await fixture();
    const project = await store.createProject({ path: "/tmp/p" });
    const conv = await store.createConversation({ projectId: project.id });

    await store.recordEvent(conv.id, "agent.launched", { tmuxSessionId: "$1" });
    await store.recordEvent(conv.id, "agent.hosted", { sessionId: "s1" });
    await store.recordEvent(conv.id, "agent.stopped", { tmuxSessionId: "$1" });

    // Fetch page 1 with limit 2
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events?limit=2`,
      headers,
    });
    expect(page1Res.statusCode).toBe(200);
    const page1 = page1Res.json().data;
    expect(page1.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2]);
    expect(page1.nextAfter).toBe(2);

    // Fetch page 2 with after=2
    const page2Res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events?after=2&limit=2`,
      headers,
    });
    expect(page2Res.statusCode).toBe(200);
    const page2 = page2Res.json().data;
    expect(page2.events.map((e: { seq: number }) => e.seq)).toEqual([3]);
    expect(page2.nextAfter).toBeNull();

    await app.close();
  });

  it("redacts token-shaped values, URL fragments, and bearer headers before returning", async () => {
    const { app, headers, store } = await fixture();
    const project = await store.createProject({ path: "/tmp/p" });
    const conv = await store.createConversation({ projectId: project.id });

    const rawCollabLink = "ws://127.0.0.1:8792/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    await store.recordEvent(conv.id, "agent.hosted", {
      urlWithFragment: "https://relay.internal:8792/session#secret-room-key-fragment",
      authHeader: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.supersecretpayload.signature123",
      collabLink: rawCollabLink,
      nested: {
        token: "sensitive-token-value-xyz",
        standaloneHash: "#privateFragment",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/conversations/${conv.id}/events`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const payload = res.json().data.events[0].payload;

    // URL fragment redacted
    expect(payload.urlWithFragment).toBe("https://relay.internal:8792/session#[REDACTED]");
    expect(payload.urlWithFragment).not.toContain("secret-room-key-fragment");

    // Bearer token redacted
    expect(payload.authHeader).toBe("Bearer [REDACTED]");
    expect(payload.authHeader).not.toContain("supersecretpayload");

    // Collab link key redacted
    expect(payload.collabLink).toBe("ws://127.0.0.1:8792/r/[REDACTED]");
    expect(payload.collabLink).not.toContain("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");

    // Sensitive object key redacted
    expect(payload.nested.token).toBe("[REDACTED]");
    expect(payload.nested.token).not.toContain("sensitive-token-value-xyz");

    // Standalone fragment redacted
    expect(payload.nested.standaloneHash).toBe("#[REDACTED]");

    await app.close();
  });
});
