import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { bridgeConfigPath, BRIDGE_CONFIG_ENV, prepareBridge, readBridgeConfig } from "@caw/omp-adapter";
import { createAuthenticationService } from "../../apps/server/src/auth";
import { buildApp } from "../../apps/server/src/app";
import { createMetadataStore } from "../../apps/server/src/store";
import type { ServerConfig } from "../../apps/server/src/config";

/**
 * The vibe route's refusal matrix, driven against a *real* loopback bridge.
 *
 * The bridge here is a stub process, but it is a real HTTP one: the route's
 * whole job is to distinguish "the bridge answered and said no" from "there was
 * no bridge to ask", and only a real socket can tell those apart. That split is
 * the one AGENTS.md rule 6 demands everywhere else — "I could not ask" must
 * never be rendered as "the answer is inactive".
 */
const state = {
  plan: { status: "inactive" },
  vibe: { status: "inactive" },
  goal: { status: "inactive" },
  loop: { status: "inactive" },
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn().catch(() => undefined);
});

interface StubBridge {
  port: number;
  token: string;
  /** How many `POST /mode` requests actually reached the listener. */
  modeRequests: () => number;
  /** Resolves once a `POST /mode` has arrived; the response is held until {@link release}. */
  arrived: Promise<void>;
  release: () => void;
  stop: () => Promise<void>;
}

/**
 * A real bridge listener.
 *
 * `hold` makes the first `POST /mode` wait for {@link release}, so a test can
 * put a second request in flight against a known-first one without guessing a
 * duration — the race is *constructed*, not timed.
 */
async function startBridge(options: { token?: string; modeResult?: unknown; hold?: boolean; sessionId?: string | null } = {}): Promise<StubBridge> {
  const token = options.token ?? "bridge-token-0123456789";
  let modeRequests = 0;
  let signalArrived: () => void = () => {};
  const arrived = new Promise<void>((resolve) => { signalArrived = resolve; });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  const server = createServer((req, res) => {
    if (req.headers["x-caw-bridge-token"] !== token) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, code: "unauthorized" }));
    }
    const respond = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url?.startsWith("/state")) {
      // The real extension reports which native session it serves; the route
      // compares it against the conversation's recorded session, so the stub must
      // carry it too or every answer is (correctly) treated as unattributable.
      // `undefined` means "serve the fixture's session"; `null` means "cannot say".
      const sessionId = options.sessionId === undefined ? "sess-1" : options.sessionId;
      return respond(200, { ok: true, hasSessionModes: true, sessionId, modes: state, tools: ["read"], model: "test/model", thinkingLevel: "medium" });
    }
    if (req.method === "POST" && req.url?.startsWith("/mode")) {
      modeRequests += 1;
      req.resume();
      req.on("end", () => {
        const answer = () => respond(200, options.modeResult ?? { ok: true, changed: true, state: { ...state, vibe: { status: "active" } } });
        if (options.hold) void held.then(answer);
        else answer();
        signalArrived();
      });
      return;
    }
    respond(404, { ok: false, code: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    token,
    modeRequests: () => modeRequests,
    arrived,
    release,
    stop: async () => { release(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

async function fixture(options: {
  conversation?: Record<string, unknown>;
  withBridgeDir?: boolean;
  liveIdentity?: string | null;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "caw-bridge-route-"));
  cleanup.push(async () => { await rm(dir, { recursive: true, force: true }); });
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir],
    relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720,
    trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false,
    handoffEvidenceBudgetMs: 0,
  };
  const store = createMetadataStore(dir);
  const overlayDir = join(dir, "overlays");
  await mkdir(overlayDir, { recursive: true, mode: 0o700 });
  const app = buildApp({
    config, auth, store, originAllowlist: ["https://workspace.test"],
    tmuxServerIdentity: async () => (options.liveIdentity === undefined ? "sock:1:2" : options.liveIdentity),
    ...(options.withBridgeDir === false ? {} : { bridgeConfigDir: overlayDir }),
  });
  cleanup.push(async () => { await app.close(); });
  const session = auth.createSession();
  const headers = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
  const project = await store.createProject({ path: dir, label: "p" });
  const conversation = await store.createConversation({ projectId: project.id, title: "c" });
  await store.updateConversation(conversation.id, {
    ownership: "managed", state: "idle", nativeSessionId: "sess-1",
    tmuxSessionId: "$0", tmuxSessionName: "caw-c", tmuxServerIdentity: "sock:1:2", tmuxPanePid: 42,
    ...options.conversation,
  });
  /** Point this conversation's bridge config at a listening stub. */
  const attach = async (bridge: { port: number; token: string }) => {
    await writeFile(bridgeConfigPath(overlayDir, conversation.id), JSON.stringify({ port: bridge.port, token: bridge.token }), { mode: 0o600 });
  };
  return { app, headers, conversation, attach, overlayDir };
}

const get = (app: FastifyInstance<HttpServer>, id: string, headers: Record<string, string>) =>
  app.inject({ method: "GET", url: `/api/conversations/${id}/vibe`, headers });
const post = (app: FastifyInstance<HttpServer>, id: string, headers: Record<string, string>, payload: unknown = { action: "enter" }) =>
  app.inject({ method: "POST", url: `/api/conversations/${id}/vibe`, headers, payload });

describe("vibe route", () => {
  /**
   * B02 — the bridge serves a *process*, and a process can switch sessions.
   *
   * The dangerous case: a `/resume` inside the same TUI leaves the listener
   * answering for session B while the phone is still looking at conversation A.
   * Applying that mode change would mutate the wrong session, so identity is
   * verified before any write, and an answer that cannot be attributed is refused.
   */
  it("refuses a read when the bridge serves a different native session", async () => {
    const { app, conversation, headers, attach } = await fixture();
    const bridge = await startBridge({ sessionId: "some-other-session" });
    cleanup.push(bridge.stop);
    await attach(bridge);

    const response = await get(app, conversation.id, headers);
    expect(response.statusCode).toBe(200);
    // Reported as unavailable WITH the reason — never as another session's mode.
    expect(response.json().data.available).toBe(false);
    expect(response.json().data.modes).toBeNull();
    expect(response.json().data.reason).toMatch(/different native session/i);
    await app.close();
  });

  it("refuses a mode change when the bridge serves a different native session", async () => {
    const { app, conversation, headers, attach } = await fixture();
    const bridge = await startBridge({ sessionId: "some-other-session" });
    cleanup.push(bridge.stop);
    await attach(bridge);

    const response = await post(app, conversation.id, headers);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("conflict_owner");
    // And nothing was written: a mismatched answer must not reach the transition.
    expect(bridge.modeRequests()).toBe(0);
    await app.close();
  });

  it("refuses when the bridge cannot report which session it serves", async () => {
    // "I could not check" is not "it matches": an unreadable id fails closed.
    const { app, conversation, headers, attach } = await fixture();
    const bridge = await startBridge({ sessionId: null });
    cleanup.push(bridge.stop);
    await attach(bridge);

    const read = await get(app, conversation.id, headers);
    expect(read.json().data.available).toBe(false);
    expect(read.json().data.reason).toMatch(/did not report which native session/i);

    const write = await post(app, conversation.id, headers);
    expect(write.statusCode).toBe(409);
    expect(bridge.modeRequests()).toBe(0);
    await app.close();
  });

  it("reports the journal-proven worker ids alongside the state", async () => {
    // The Kill gate's evidence: only ids the server proved from the journal are
    // reported, and an absent reader yields none rather than every agent.
    const dir = await mkdtemp(join(tmpdir(), "caw-bridge-workers-"));
    cleanup.push(async () => { await rm(dir, { recursive: true, force: true }); });
    const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
    await auth.initAuth();
    const store = createMetadataStore(dir);
    const overlayDir = join(dir, "overlays");
    await mkdir(overlayDir, { recursive: true, mode: 0o700 });
    const app = buildApp({
      config: { host: "127.0.0.1", port: 8791, stateDir: dir, allowedRoots: [dir], relayPort: 8792, relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false, logLevel: "silent", insecureCookies: false, handoffEvidenceBudgetMs: 0 },
      auth, store, originAllowlist: ["https://workspace.test"],
      tmuxServerIdentity: async () => "sock:1:2",
      bridgeConfigDir: overlayDir,
      readVibeWorkers: async (sessionId) => ({ ids: sessionId === "sess-1" ? ["w1", "w2"] : [], timestamp: null }),
    });
    cleanup.push(async () => { await app.close(); });
    const session = auth.createSession();
    const headers = { cookie: `__Host-caw_session=${session.token}`, origin: "https://workspace.test", "x-caw-csrf": session.csrfToken };
    const project = await store.createProject({ path: dir, label: "p" });
    const conversation = await store.createConversation({ projectId: project.id, title: "c" });
    await store.updateConversation(conversation.id, { ownership: "managed", state: "idle", nativeSessionId: "sess-1", tmuxSessionId: "$0", tmuxSessionName: "caw-c", tmuxServerIdentity: "sock:1:2", tmuxPanePid: 42 });
    const bridge = await startBridge();
    cleanup.push(bridge.stop);
    await writeFile(bridgeConfigPath(overlayDir, conversation.id), JSON.stringify({ port: bridge.port, token: bridge.token }), { mode: 0o600 });

    const response = await get(app, conversation.id, headers);
    expect(response.json().data.workerIds).toEqual(["w1", "w2"]);
  });

  it("refuses an unauthenticated caller", async () => {
    const { app, conversation } = await fixture();
    // Registered with the app's own session guard, so it answers the same 401 as
    // every other conversation route instead of inventing its own.
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}/vibe` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/vibe`, payload: { action: "enter" } })).statusCode).toBe(401);
    await app.close();
  });

  it("refuses a conversation that is not ours, and one whose recorded agent is gone", async () => {
    const external = await fixture({ conversation: { ownership: "external", tmuxSessionId: null, tmuxServerIdentity: null, tmuxPanePid: null } });
    const externalResponse = await get(external.app, external.conversation.id, external.headers);
    expect(externalResponse.statusCode).toBe(409);
    expect(externalResponse.json().error.code).toBe("conflict_owner");
    await external.app.close();

    const unverified = await fixture({ conversation: { tmuxServerIdentity: null, tmuxPanePid: null } });
    expect((await get(unverified.app, unverified.conversation.id, unverified.headers)).json().error.code).toBe("conflict_owner");
    await unverified.app.close();

    // Identity recorded, but the live tmux server is a different one: `$0` is a
    // label until the server that minted it is proven to be the live one.
    const stale = await fixture({ liveIdentity: "sock:9:9" });
    expect((await get(stale.app, stale.conversation.id, stale.headers)).json().error.code).toBe("conflict_owner");
    await stale.app.close();

    // A server with no bridge directory configured can still reach no bridge.
    const unwired = await fixture({ withBridgeDir: false });
    const unwiredResponse = await get(unwired.app, unwired.conversation.id, unwired.headers);
    expect(unwiredResponse.json().data).toMatchObject({ available: false, modes: null });
    await unwired.app.close();
  });

  it("reports `unknown` with a reason when no bridge answers — never `off`", async () => {
    // No config file at all: the pre-bridge session, and the case this whole
    // discriminator exists for. `available: false` with `modes: null` is the only
    // honest answer; `vibe.status === "inactive"` would be a guess.
    const absent = await fixture();
    const absentResponse = await get(absent.app, absent.conversation.id, absent.headers);
    expect(absentResponse.statusCode).toBe(200);
    expect(absentResponse.json().data).toMatchObject({ available: false, modes: null, tools: null });
    expect(absentResponse.json().data.reason).toMatch(/restart/i);
    await absent.app.close();

    // A config pointing at a free port nobody holds: configured, but not there.
    const dead = await fixture();
    const deadBridge = await startBridge();
    const deadPort = deadBridge.port;
    await deadBridge.stop();
    await dead.attach({ port: deadPort, token: deadBridge.token });

    const deadResponse = await get(dead.app, dead.conversation.id, dead.headers);
    expect(deadResponse.statusCode).toBe(200);
    expect(deadResponse.json().data).toMatchObject({ available: false, modes: null });
    // The mutating route uses the refusal code reserved for "I could not ask".
    const refused = await post(dead.app, dead.conversation.id, dead.headers);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("bridge_unavailable");
    await dead.app.close();
  });

  it("reports the live state, and returns OMP's own refusal verbatim", async () => {
    const { app, conversation, headers, attach } = await fixture();
    const bridge = await startBridge();
    cleanup.push(bridge.stop);
    await attach(bridge);

    const live = await get(app, conversation.id, headers);
    expect(live.statusCode).toBe(200);
    expect(live.json().data).toEqual({ available: true, reason: null, modes: state, tools: ["read"], model: "test/model", thinkingLevel: "medium", workerIds: [] });
    await app.close();

    // The bridge is up but the native runtime refuses the transition. The exchange
    // succeeded, so the answer travels as data — `ok: false` plus the code and the
    // state that explain it. An HTTP error here would discard both, and the client
    // would have to invent a reason.
    const refusing = await fixture();
    const refusal = { ok: false, code: "conflict", message: "Plan mode is active", state };
    const stub = await startBridge({ modeResult: refusal });
    cleanup.push(stub.stop);
    await refusing.attach(stub);
    const outcome = await post(refusing.app, refusing.conversation.id, refusing.headers);
    expect(outcome.statusCode).toBe(200);
    expect(outcome.json()).toEqual({ ok: true, data: refusal });
    await refusing.app.close();
  });

  it("refuses a duplicate concurrent request instead of queueing it", async () => {
    const { app, conversation, headers, attach } = await fixture();
    const stub = await startBridge({ hold: true });
    cleanup.push(stub.stop);
    await attach(stub);

    // The race is constructed, not timed: the first request is held open inside the
    // bridge, so the second provably arrives while the first is still in flight.
    const first = post(app, conversation.id, headers);
    await stub.arrived;
    const second = await post(app, conversation.id, headers);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict_owner");

    stub.release();
    expect((await first).statusCode).toBe(200);
    // Exactly one transition reached the session; the refusal came before the
    // second call, not after it.
    expect(stub.modeRequests()).toBe(1);
    await app.close();
  });

  it("rejects a malformed action without contacting the bridge", async () => {
    const { app, conversation, headers, attach } = await fixture();
    const stub = await startBridge();
    cleanup.push(stub.stop);
    await attach(stub);
    expect((await post(app, conversation.id, headers, { action: "toggle" })).statusCode).toBe(400);
    // `mode` is not part of this route's contract: the bridge only drives vibe, so
    // naming another mode here is a body we do not accept rather than a silent
    // passthrough.
    expect((await post(app, conversation.id, headers, { action: "enter", mode: "plan" })).statusCode).toBe(400);
    expect(stub.modeRequests()).toBe(0);
    await app.close();
  });

  it("answers 404 for a conversation that does not exist", async () => {
    const { app, headers } = await fixture();
    const response = await get(app, "00000000-0000-0000-0000-000000000000", headers);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
    await app.close();
  });
});

describe("bridge discovery", () => {
  it("allocates a free loopback port, writes a 0600 config, and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "caw-bridge-config-"));
    cleanup.push(async () => { await rm(dir, { recursive: true, force: true }); });

    // Nothing configured yet: `null`, which is what the route turns into
    // `bridge_unavailable` rather than a guess.
    expect(await readBridgeConfig(dir, "conv-1")).toBeNull();

    const prepared = await prepareBridge(dir, "conv-1");
    expect(prepared.extensionPath.endsWith("extension.mjs")).toBe(true);
    // Only the file's path travels on the command line; the token stays on disk.
    expect(prepared.env[BRIDGE_CONFIG_ENV]).toBe(bridgeConfigPath(dir, "conv-1"));
    expect(JSON.stringify(prepared.env)).not.toContain(prepared.config.token);
    expect(prepared.config.port).toBeGreaterThan(0);

    // Two conversations get two ports: a fixed port would let one session answer
    // for another.
    const other = await prepareBridge(dir, "conv-2");
    expect(other.config.port).not.toBe(prepared.config.port);
    expect(other.config.token).not.toBe(prepared.config.token);

    expect(await readBridgeConfig(dir, "conv-1")).toEqual(prepared.config);
    // The file is the bearer token's home, so it is owner-only.
    const mode = (await stat(bridgeConfigPath(dir, "conv-1"))).mode & 0o777;
    expect(mode).toBe(0o600);

    // A truncated or nonsense file is "no bridge", never a bind on a guessed port.
    await writeFile(bridgeConfigPath(dir, "conv-3"), "{\"port\":", { mode: 0o600 });
    expect(await readBridgeConfig(dir, "conv-3")).toBeNull();
    await writeFile(bridgeConfigPath(dir, "conv-4"), JSON.stringify({ port: 99999, token: "t" }), { mode: 0o600 });
    expect(await readBridgeConfig(dir, "conv-4")).toBeNull();
    await writeFile(bridgeConfigPath(dir, "conv-5"), JSON.stringify({ port: 1234 }), { mode: 0o600 });
    expect(await readBridgeConfig(dir, "conv-5")).toBeNull();
  });
});
