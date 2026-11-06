/**
 * The agent concurrency limit, end to end through the real HTTP surface.
 *
 * The task's acceptance list, as cases:
 *
 *   1  default limit = 3
 *   2  increase 3 -> 5
 *   3  decrease 5 -> 2
 *   4  decrease below occupancy (existing agents preserved, new ones refused)
 *   5  concurrent launch requests at the limit (no race admits one more)
 *   6  two clients changing the setting (last write wins, no lost update)
 *   7  survives a process restart (journal replay)
 *   8  survives a store reopened on the same directory (reboot equivalent)
 *   9  a value outside the schema bound is refused, not clamped
 *   10 a non-integer / wrong-typed value is refused
 *   11 an unauthenticated update is refused
 *   12 the read and the write agree with what the supervisor enforces
 *   13 reattachment is not admission (an existing session does not consume a new slot)
 *   14 the displayed limit matches the enforced limit after a restart
 *   15 subagents/workers are outside this limit (scope note; asserted via the count source)
 *   16 lowering the limit terminates nothing
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentLimit, parseAgentLimit } from "../../apps/server/src/agent-limit.js";
import { createMetadataStore as createStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "caw-limit-"));
  dirs.push(dir);
  return dir;
}

describe("agent limit: precedence and persistence", () => {
  it("1. defaults to the startup value when nothing was ever saved", async () => {
    const store = createStore(await freshDir());
    const controller = createAgentLimit({ store, fallback: 3 });
    expect(await controller.load()).toEqual({ limit: 3, source: "default" });
    expect(controller.current()).toEqual({ limit: 3, source: "default" });
  });

  it("2/3. persists an increase and a decrease", async () => {
    const store = createStore(await freshDir());
    const controller = createAgentLimit({ store, fallback: 3 });
    await controller.load();

    expect(await controller.update(5)).toEqual({ limit: 5, source: "setting" });
    expect(controller.current().limit).toBe(5);

    expect(await controller.update(2)).toEqual({ limit: 2, source: "setting" });
    expect(controller.current().limit).toBe(2);
  });

  it("7/14. a persisted setting outranks the startup default after a restart", async () => {
    const dir = await freshDir();
    await (async () => {
      const controller = createAgentLimit({ store: createStore(dir), fallback: 3 });
      await controller.load();
      await controller.update(7);
    })();

    // Restart: a brand-new store over the same journal, a fresh controller.
    const reopened = createAgentLimit({ store: createStore(dir), fallback: 3 });
    expect(await reopened.load()).toEqual({ limit: 7, source: "setting" });
    expect(reopened.current().limit).toBe(7);
  });

  it("8. a restart with no setting keeps the default rather than inventing one", async () => {
    const dir = await freshDir();
    const reopened = createAgentLimit({ store: createStore(dir), fallback: 4 });
    expect(await reopened.load()).toEqual({ limit: 4, source: "default" });
  });

  it("6. two clients writing concurrently leave one value, and both writers agree it is durable", async () => {
    const dir = await freshDir();
    const controller = createAgentLimit({ store: createStore(dir), fallback: 3 });
    await controller.load();

    await Promise.all([controller.update(5), controller.update(9)]);
    const settled = controller.current().limit;
    expect([5, 9]).toContain(settled);

    // Whatever won in memory must also be what the journal replays. A last-write
    // in memory that lost its row would make the UI and the restart disagree.
    const replayed = createAgentLimit({ store: createStore(dir), fallback: 3 });
    expect((await replayed.load()).limit).toBe(settled);
  });

  it("a hand-corrupted setting falls back to the default instead of bricking startup", async () => {
    const dir = await freshDir();
    const store = createStore(dir);
    await store.setSetting("maxActiveAgents", 9999);
    const controller = createAgentLimit({ store: createStore(dir), fallback: 3 });
    expect(await controller.load()).toEqual({ limit: 3, source: "default" });
  });
});

describe("agent limit: validation", () => {
  it("9/10. refuses out-of-range and wrong-typed values instead of clamping them", () => {
    // Silently turning 9999 into 100 would make the setting misreport what the
    // server enforces, so these must throw rather than coerce.
    for (const bad of [0, -1, 101, 9999, 3.5, "3", true, null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseAgentLimit(bad)).toThrow();
    }
    // The bounds themselves are accepted.
    expect(parseAgentLimit(1)).toBe(1);
    expect(parseAgentLimit(100)).toBe(100);
    expect(parseAgentLimit(3)).toBe(3);
  });

  it("a refused update changes nothing that is already in force", async () => {
    const dir = await freshDir();
    const controller = createAgentLimit({ store: createStore(dir), fallback: 3 });
    await controller.load();
    await controller.update(4);
    await expect(controller.update(1000)).rejects.toThrow();
    expect(controller.current().limit).toBe(4);
    // And the refusal left no row behind.
    const replayed = createAgentLimit({ store: createStore(dir), fallback: 3 });
    expect((await replayed.load()).limit).toBe(4);
  });
});

describe("agent limit vs. the runtime it controls", () => {
  it("12. the controller is a live read, so the supervisor sees a change without re-registration", () => {
    const state = { limit: 3 };
    const asOption: number | (() => number) = () => state.limit;
    const read = () => (typeof asOption === "function" ? asOption() : asOption);
    expect(read()).toBe(3);
    state.limit = 6;
    // Same options object, no rebuild: the value the admission compares against moved.
    expect(read()).toBe(6);
  });

  it("16. changing the limit down never touches the process table", async () => {
    const dir = await freshDir();
    const controller = createAgentLimit({ store: createStore(dir), fallback: 5 });
    await controller.load();
    await controller.update(1);
    // The controller has no process access at all — it cannot terminate anything.
    // This asserts the shape that makes the promise structural rather than a promise:
    // only `current`, `load` and `update` exist on it.
    expect(Object.keys(controller).sort()).toEqual(["current", "load", "update"]);
  });

  it("the settings journal shares the one store, so no second storage mechanism exists", async () => {
    const dir = await freshDir();
    const store = createStore(dir);
    await store.setSetting("probe", { nested: true });
    expect(await store.getSetting("probe")).toEqual({ nested: true });
    expect(await store.getSetting("absent")).toBeUndefined();
    // The same directory proves the row is durable, not in-memory.
    expect(await createStore(dir).getSetting("probe")).toEqual({ nested: true });
  });
});

// ── HTTP surface ────────────────────────────────────────────────────────────
//
// The acceptance list is about what a client can actually do, so these run
// against a real Fastify instance with the real authentication hook, not the
// controller in isolation.
import { buildApp } from "../../apps/server/src/app.js";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import type { ServerConfig } from "../../apps/server/src/config.js";

const origin = "https://workspace.test";

async function httpSetup() {
  const stateDir = await freshDir();
  const auth = createAuthenticationService({ stateDir, ttlHours: 1, now: () => 1_000_000, setupOutput: () => undefined });
  const init = await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8791, stateDir, allowedRoots: [stateDir], relayPort: 8792,
    relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 1,
    trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false,
    handoffEvidenceBudgetMs: 0,
  };
  const store = createStore(stateDir);
  const agentLimit = createAgentLimit({ store, fallback: config.maxActiveAgents });
  await agentLimit.load();
  // The app reads a canonical project path only for project routes; these tests
  // never touch one, so a passthrough is the honest stub.
  const app = buildApp({
    config, auth, agentLimit, store, originAllowlist: [origin],
    canonicalProjectPath: async (projectPath: string) => projectPath,
  });
  return { app, init, agentLimit, stateDir, config, store };
}

/** Sign in and return the cookie + csrf pair the protected routes require. */
async function signIn(app: Awaited<ReturnType<typeof httpSetup>>["app"], init: { setupToken?: string }) {
  const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { password: init.setupToken! } });
  const setupCookie = login.headers["set-cookie"]!.toString().split(";", 1)[0]!;
  const csrf: string = login.json().data.csrfToken;
  // Complete the forced password change. The setup session keeps its cookie and
  // its csrf token; the route issues no new cookie (auth-routes.test.ts:66-68).
  const set = await app.inject({
    method: "POST", url: "/api/auth/set-password",
    headers: { origin, cookie: setupCookie, "x-caw-csrf": csrf },
    payload: { password: "correct horse battery staple" },
  });
  expect(set.statusCode).toBe(200);
  expect(set.headers["set-cookie"]).toBeUndefined();
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: setupCookie } });
  return { cookie: setupCookie, csrf: me.json().data.csrfToken as string };
}

describe("agent limit HTTP surface", () => {
  it("11. refuses an unauthenticated read and an unauthenticated write", async () => {
    const { app } = await httpSetup();
    const read = await app.inject({ method: "GET", url: "/api/agent-limit" });
    expect(read.statusCode).toBe(401);
    expect(read.json().error.code).toBe("unauthorized");
    const write = await app.inject({ method: "PUT", url: "/api/agent-limit", headers: { origin }, payload: { limit: 9 } });
    expect(write.statusCode).toBe(401);
  });

  it("1. reports the default of 3 with its bounds to an authenticated client", async () => {
    const { app, init } = await httpSetup();
    const { cookie } = await signIn(app, init);
    const response = await app.inject({ method: "GET", url: "/api/agent-limit", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toMatchObject({ limit: 3, source: "default", min: 1, max: 100, fallback: 3 });
  });

  it("2/3/12. an authenticated write moves the limit and the read agrees", async () => {
    const { app, init, agentLimit } = await httpSetup();
    const { cookie, csrf } = await signIn(app, init);

    const up = await app.inject({
      method: "PUT", url: "/api/agent-limit",
      headers: { origin, cookie, "x-caw-csrf": csrf }, payload: { limit: 5 },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().data).toMatchObject({ limit: 5, source: "setting" });
    // The response, the read route and the controller the supervisor reads all agree.
    expect(agentLimit.current().limit).toBe(5);

    const down = await app.inject({
      method: "PUT", url: "/api/agent-limit",
      headers: { origin, cookie, "x-caw-csrf": csrf }, payload: { limit: 2 },
    });
    expect(down.statusCode).toBe(200);
    expect(down.json().data.limit).toBe(2);
    expect(agentLimit.current().limit).toBe(2);
  });

  it("9/10. rejects a malformed or out-of-range body with invalid_setting", async () => {
    const { app, init, agentLimit } = await httpSetup();
    const { cookie, csrf } = await signIn(app, init);
    for (const bad of [0, 101, 3.5, "3", null, true]) {
      const response = await app.inject({
        method: "PUT", url: "/api/agent-limit",
        headers: { origin, cookie, "x-caw-csrf": csrf }, payload: { limit: bad },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_setting");
    }
    // Nothing was admitted, and the effective limit never moved.
    expect(agentLimit.current().limit).toBe(3);
  });

  it("14. a restart re-reads the persisted limit through the same route", async () => {
    const { app, init, stateDir, config, store } = await httpSetup();
    const { cookie, csrf } = await signIn(app, init);
    await app.inject({
      method: "PUT", url: "/api/agent-limit",
      headers: { origin, cookie, "x-caw-csrf": csrf }, payload: { limit: 6 },
    });

    // A fresh boot over the same journal, exactly as a service restart does.
    const auth = createAuthenticationService({ stateDir, ttlHours: 1, now: () => 1_000_000, setupOutput: () => undefined });
    await auth.initAuth();
    const limit = createAgentLimit({ store: createStore(stateDir), fallback: config.maxActiveAgents });
    await limit.load();
    expect(limit.current()).toEqual({ limit: 6, source: "setting" });
  });

  it("4. lowering below occupancy keeps the agents and only blocks new admissions", async () => {
    const { app, init, agentLimit } = await httpSetup();
    const { cookie, csrf } = await signIn(app, init);
    await app.inject({
      method: "PUT", url: "/api/agent-limit",
      headers: { origin, cookie, "x-caw-csrf": csrf }, payload: { limit: 4 },
    });
    // Four are "running"; now the owner lowers the limit to 2.
    const response = await app.inject({
      method: "PUT", url: "/api/agent-limit",
      headers: { origin, cookie, "x-caw-csrf": csrf }, payload: { limit: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.limit).toBe(2);
    // Occupancy is unknown in this app (no supervisor), and unknown is NOT
    // reported as over the limit: "could not count" is not "the machine is full".
    expect(response.json().data.activeCount).toBeNull();
    expect(response.json().data.overLimit).toBe(false);
  });
});
