import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelay, type Relay } from "@caw/relay";
import { buildApp } from "../../apps/server/src/app.js";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import type { ServerConfig } from "../../apps/server/src/config.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];
const relays: Relay[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createServerFixture(configOverrides: Partial<ServerConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "caw-relay-auth-"));
  dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const session = auth.createSession();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, stateDir: dir, allowedRoots: [dir], relayPort: 0,
    relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false,
    logLevel: "silent", insecureCookies: false,
    ...configOverrides,
  };
  const store = createMetadataStore(dir);
  const app = buildApp({
    config,
    auth,
    store,
    mintLink: async () => ({
      url: `${config.publicOrigin ?? "http://127.0.0.1:8791"}/#/r/room-1234567890.secretkey1234567890123456789012345678901234567890123`,
      access: "full",
      instanceId: "fixture-instance",
      generation: 1,
    }),
  });
  await app.ready();
  await app.listen({ host: "127.0.0.1", port: 0 });
  const appPort = (app.server.address() as AddressInfo).port;
  const hostServer = createServer();
  let hostPort = 0;
  const loopbackOrigins = [
    `http://localhost:${appPort}`, `http://127.0.0.1:${appPort}`, `http://[::1]:${appPort}`,
    `https://localhost:${appPort}`, `https://127.0.0.1:${appPort}`, `https://[::1]:${appPort}`,
  ];
  const customOrigins = [
    ...(config.publicOrigin ? [config.publicOrigin] : []),
    ...config.relayAllowedOrigins,
  ];
  const relayOrigins = customOrigins.length > 0
    ? [...loopbackOrigins, ...customOrigins]
    : undefined;
  const relay = createRelay({
    server: app.server,
    attachOnly: true,
    allowHost: false,
    allowedOrigin: relayOrigins,
    authorizeHost: (req: IncomingMessage) => req.socket.localPort === hostPort &&
      (req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1" || req.socket.remoteAddress === "::ffff:127.0.0.1"),
  });
  relay.attach(hostServer, { allowHost: true });
  const hostListening = once(hostServer, "listening");
  hostServer.listen(0, "127.0.0.1");
  await hostListening;
  hostPort = (hostServer.address() as AddressInfo).port;
  expect((hostServer.address() as AddressInfo).address).toBe("127.0.0.1");
  await relay.start();
  relays.push(relay);
  return { app, auth, session, store, dir, port: appPort, hostPort };
}
async function websocketFailure(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise<string>((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => resolve("unexpected websocket upgrade success"));
    ws.once("error", (error: Error) => resolve(error.message));
  });
}
async function websocketOpen(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  await once(ws, "open");
  return ws;
}

describe("SEC-2: host relay is reachable only through internal loopback listener", () => {
  it("refuses a simulated Tailscale Serve hop on app origin despite loopback peer, forwarded address, and valid cookie", async () => {
    const { app, auth, session, port } = await createServerFixture();
    const error = await websocketFailure(`ws://127.0.0.1:${port}/r/test-proxy-host-001?role=host`, {
      cookie: `${auth.cookieName}=${session.token}`,
      "x-forwarded-for": "100.64.0.5",
    });
    expect(error).toContain("401");
    await app.close();
  });

  it("accepts managed agent host on loopback relay and lets phone guest join through app origin", async () => {
    const { app, port, hostPort } = await createServerFixture();
    const room = "test-shared-room-001";
    const host = await websocketOpen(`ws://127.0.0.1:${hostPort}/r/${room}?role=host`);
    const joined = once(host, "message");
    const guest = await websocketOpen(`ws://127.0.0.1:${port}/r/${room}?role=guest`);
    const [data, binary] = await joined;
    expect(binary).toBe(false);
    expect(JSON.parse(data.toString())).toMatchObject({ t: "peer-joined", peer: 1 });
    const hostClosed = once(host, "close");
    const guestClosed = once(guest, "close");
    guest.close();
    host.close();
    await Promise.all([hostClosed, guestClosed]);
    await app.close();
  });
});
describe("H09: Tailscale WebSocket Origin handling with simulated production HTTPS Origin", () => {
  const prodOrigin = "https://my-workstation.tailnet-name.ts.net";

  it("handles full lifecycle under documented publicOrigin setup and rejects disallowed origins", async () => {
    const { app, auth, session, store, dir, port, hostPort } = await createServerFixture({
      publicOrigin: prodOrigin,
      relayAllowedOrigins: [],
    });

    const project = await store.createProject({ path: dir });
    const conv = await store.createConversation({ projectId: project.id });

    // 1. App HTTP access & auth with production Origin
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: {
        cookie: `${auth.cookieName}=${session.token}`,
        origin: prodOrigin,
      },
    });
    expect(meRes.statusCode).toBe(200);

    // 2. POST /api/conversations/:id/link with production Origin & CSRF
    const linkRes = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/link`,
      headers: {
        cookie: `${auth.cookieName}=${session.token}`,
        origin: prodOrigin,
        "x-caw-csrf": session.csrfToken,
      },
    });
    expect(linkRes.statusCode).toBe(200);
    const linkBody = linkRes.json().data;
    expect(linkBody.url).toContain(prodOrigin);

    const room = "test-prod-room-001";
    const host = await websocketOpen(`ws://127.0.0.1:${hostPort}/r/${room}?role=host`);

    // 3. Browser guest WebSocket upgrade with correct allowlisted Origin
    const joined = once(host, "message");
    const guest = await websocketOpen(`ws://127.0.0.1:${port}/r/${room}?role=guest`, {
      origin: prodOrigin,
    });
    const [joinData] = await joined;
    expect(JSON.parse(joinData.toString())).toMatchObject({ t: "peer-joined", peer: 1 });

    // 4. Live guest operation: frame exchange between guest and host
    const hostFrameReceived = once(host, "message");
    const payload = Buffer.from("hello agent");
    const guestEnvelope = Buffer.concat([Buffer.alloc(4), payload]);
    guest.send(guestEnvelope);
    const [hostMsg, isBinary] = await hostFrameReceived;
    expect(isBinary).toBe(true);
    // Peer ID 1 prefixed to payload
    expect(toBuffer(hostMsg).subarray(4).toString()).toBe("hello agent");
    guest.close();
    host.close();
    await app.close();
  });

  it("regression: accepts local browser with Origin: http://127.0.0.1:<port> and http://localhost:<port> when publicOrigin is set", async () => {
    const { app, port, hostPort } = await createServerFixture({
      publicOrigin: prodOrigin,
      relayAllowedOrigins: [],
    });
    const room1 = "test-loopback-ip-room";
    const host1 = await websocketOpen(`ws://127.0.0.1:${hostPort}/r/${room1}?role=host`);
    const joined1 = once(host1, "message");
    const guestIp = await websocketOpen(`ws://127.0.0.1:${port}/r/${room1}?role=guest`, {
      origin: `http://127.0.0.1:${port}`,
    });
    const [joinData1] = await joined1;
    expect(JSON.parse(joinData1.toString())).toMatchObject({ t: "peer-joined", peer: 1 });
    guestIp.close();
    host1.close();

    const room2 = "test-loopback-host-room";
    const host2 = await websocketOpen(`ws://127.0.0.1:${hostPort}/r/${room2}?role=host`);
    const joined2 = once(host2, "message");
    const guestLocalhost = await websocketOpen(`ws://127.0.0.1:${port}/r/${room2}?role=guest`, {
      origin: `http://localhost:${port}`,
    });
    const [joinData2] = await joined2;
    expect(JSON.parse(joinData2.toString())).toMatchObject({ t: "peer-joined", peer: 1 });
    guestLocalhost.close();
    host2.close();

    await app.close();
  });

  it("rejects unexpected Origin with 403 Forbidden", async () => {
    const { app, port } = await createServerFixture({
      publicOrigin: prodOrigin,
    });
    const error = await websocketFailure(`ws://127.0.0.1:${port}/r/test-room-reject?role=guest`, {
      origin: "https://evil-attacker.example.com",
    });
    expect(error).toContain("403");
    await app.close();
  });

  it("accepts native OMP client with missing Origin header", async () => {
    const { app, port, hostPort } = await createServerFixture({
      publicOrigin: prodOrigin,
    });
    const room = "test-native-room-001";
    const host = await websocketOpen(`ws://127.0.0.1:${hostPort}/r/${room}?role=host`);
    const joined = once(host, "message");
    // Native client sends no Origin
    const guest = await websocketOpen(`ws://127.0.0.1:${port}/r/${room}?role=guest`);
    const [data] = await joined;
    expect(JSON.parse(data.toString())).toMatchObject({ t: "peer-joined", peer: 1 });
    guest.close();
    host.close();
    await app.close();
  });

  it("handles separate public web origin via relayAllowedOrigins", async () => {
    const customOrigin = "https://web.custom-domain.net";
    const { app, port, hostPort } = await createServerFixture({
      publicOrigin: prodOrigin,
      relayAllowedOrigins: [customOrigin],
    });
    const room = "test-custom-origin-room";
    const host = await websocketOpen(`ws://127.0.0.1:${hostPort}/r/${room}?role=host`);
    const joined = once(host, "message");
    const guest = await websocketOpen(`ws://127.0.0.1:${port}/r/${room}?role=guest`, {
      origin: customOrigin,
    });
    const [data] = await joined;
    expect(JSON.parse(data.toString())).toMatchObject({ t: "peer-joined", peer: 1 });
    guest.close();
    host.close();
    await app.close();
  });

  it("rejects when Origin does not match wrong publicOrigin or allowlist", async () => {
    const { app, port } = await createServerFixture({
      publicOrigin: "https://other-machine.ts.net",
      relayAllowedOrigins: [],
    });
    const error = await websocketFailure(`ws://127.0.0.1:${port}/r/test-wrong-origin?role=guest`, {
      origin: prodOrigin,
    });
    expect(error).toContain("403");
    await app.close();
  });
});

function toBuffer(data: any): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

