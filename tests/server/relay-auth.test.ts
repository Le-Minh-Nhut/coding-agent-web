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

async function createServerFixture() {
  const dir = await mkdtemp(join(tmpdir(), "caw-relay-auth-"));
  dirs.push(dir);
  const auth = createAuthenticationService({ stateDir: dir, setupOutput: () => undefined });
  await auth.initAuth();
  const session = auth.createSession();
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, stateDir: dir, allowedRoots: [dir], relayPort: 0,
    relayAllowedOrigins: [], maxActiveAgents: 3, authTokenTtlHours: 720, trustTailscaleOrigin: false,
    logLevel: "silent", insecureCookies: false,
  };
  const app = buildApp({ config, auth, store: createMetadataStore(dir) });
  await app.ready();
  const hostServer = createServer();
  let hostPort = 0;
  const relay = createRelay({
    server: app.server,
    attachOnly: true,
    allowHost: false,
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
  await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, auth, session, port: (app.server.address() as AddressInfo).port, hostPort };
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

