import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "@caw/relay";
import { buildApp } from "../../apps/server/src/app.js";
import { createAuthenticationService } from "../../apps/server/src/auth.js";
import type { ServerConfig } from "../../apps/server/src/config.js";
import { renderOverlay, writeOverlay } from "../../apps/server/src/server.js";
import { createMetadataStore } from "../../apps/server/src/store.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createFixture() {
  const dir = await mkdtemp(join(tmpdir(), "caw-single-origin-"));
  dirs.push(dir);
  const webDir = join(dir, "web-dist");
  const guestDir = join(dir, "guest-dist");
  await mkdir(webDir, { recursive: true });
  await mkdir(guestDir, { recursive: true });
  await writeFile(
    join(webDir, "index.html"),
    "<!doctype html><html><head><title>Product UI</title></head><body>Product UI</body></html>",
    "utf-8",
  );
  await writeFile(
    join(guestDir, "index.html"),
    "<!doctype html><html><head><title>Guest Viewer</title></head><body>Guest Viewer</body></html>",
    "utf-8",
  );

  const auth = createAuthenticationService({
    stateDir: dir,
    setupOutput: () => undefined,
  });
  await auth.initAuth();

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 8791,
    stateDir: dir,
    allowedRoots: [dir],
    relayPort: 8792, relayAllowedOrigins: [],
    webDistDir: webDir,
    guestDistDir: guestDir,
    maxActiveAgents: 3,
    authTokenTtlHours: 720,
    trustTailscaleOrigin: false,
    logLevel: "silent",
    insecureCookies: false,
  };

  return { dir, webDir, guestDir, auth, config, store: createMetadataStore(dir) };
}

describe("Single Origin & Static Web Serving", () => {
  it("GET / returns 200 and HTML when webDistDir contains index.html, and 404 when missing", async () => {
    const { auth, config, store, dir } = await createFixture();
    const app = buildApp({ config, auth, store });

    const okResponse = await app.inject({ method: "GET", url: "/" });
    expect(okResponse.statusCode).toBe(200);
    expect(okResponse.headers["content-type"]).toContain("text/html");
    expect(okResponse.headers["referrer-policy"]).toBe("no-referrer");
    expect(okResponse.headers["x-content-type-options"]).toBe("nosniff");
    expect(okResponse.headers["cache-control"]).toBe("no-cache");
    expect(okResponse.body).toContain("Product UI");

    // Clear 404 when web directory does not exist
    const missingApp = buildApp({
      config: { ...config, webDistDir: join(dir, "does-not-exist") },
      auth,
      store,
    });
    const missingResponse = await missingApp.inject({ method: "GET", url: "/" });
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.body).toContain("Web build missing");

    await app.close();
    await missingApp.close();
  });
  it("serves same-origin standalone PWA metadata and icons", async () => {
    const { auth, config, store, webDir } = await createFixture();
    const sourceDir = new URL("../../apps/web/", import.meta.url);
    const html = await readFile(new URL("index.html", sourceDir), "utf8");
    const manifestText = await readFile(new URL("public/manifest.webmanifest", sourceDir), "utf8");
    await writeFile(join(webDir, "index.html"), html, "utf8");
    await writeFile(join(webDir, "manifest.webmanifest"), manifestText, "utf8");
    await mkdir(join(webDir, "icons"), { recursive: true });
    for (const name of ["apple-touch-icon.png", "app-icon-192.png", "app-icon-512.png"]) {
      await writeFile(join(webDir, "icons", name), await readFile(new URL(`public/icons/${name}`, sourceDir)));
    }
    const app = buildApp({ config, auth, store });
    const origin = "https://workspace.test";
    const index = await app.inject({ method: "GET", url: "/" });
    const references = [...index.body.matchAll(/\b(?:href|src)=["']([^"']+)["']/gu)].map((match) => match[1]!);
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(index.body).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) expect(new URL(reference, origin).origin).toBe(origin);
    const response = await app.inject({ method: "GET", url: "/manifest.webmanifest" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/manifest+json");
    const manifest = response.json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBe("Coding Agent Web");
    expect(new URL(manifest.start_url, origin).origin).toBe(origin);
    expect(new URL(manifest.scope, origin).origin).toBe(origin);
    for (const icon of manifest.icons) {
      expect(new URL(icon.src, origin).origin).toBe(origin);
      expect((await app.inject({ method: "GET", url: icon.src })).statusCode).toBe(200);
    }
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual(["192x192", "512x512"]);
    const touchIcon = await app.inject({ method: "GET", url: "/icons/apple-touch-icon.png" });
    expect(touchIcon.statusCode).toBe(200);
    expect(touchIcon.rawPayload.readUInt32BE(16)).toBe(180);
    expect(touchIcon.rawPayload.readUInt32BE(20)).toBe(180);
    await app.close();
  });

  it("SPA fallback: GET /some/route returns index.html; GET /api/nope returns API 404 semantics", async () => {
    const { auth, config, store } = await createFixture();
    const app = buildApp({ config, auth, store });

    // SPA fallback returns index.html with 200
    const spaResponse = await app.inject({ method: "GET", url: "/some/route" });
    expect(spaResponse.statusCode).toBe(200);
    expect(spaResponse.headers["content-type"]).toContain("text/html");
    expect(spaResponse.headers["cache-control"]).toBe("no-cache");
    expect(spaResponse.body).toContain("Product UI");

    // Deep SPA route also returns index.html
    const deepSpaResponse = await app.inject({
      method: "GET",
      url: "/projects/123/conversations/456",
    });
    expect(deepSpaResponse.statusCode).toBe(200);
    expect(deepSpaResponse.body).toContain("Product UI");

    // Nonexistent API route returns API 404 JSON semantics, never HTML
    const apiNope = await app.inject({ method: "GET", url: "/api/nope" });
    expect(apiNope.statusCode).toBe(404);
    expect(apiNope.headers["content-type"]).toContain("application/json");
    expect(apiNope.body).not.toContain("<!doctype");
    expect(apiNope.json()).toMatchObject({
      error: "Not Found",
      statusCode: 404,
    });

    await app.close();
  });

  it("Traversal: /../etc/passwd, %2e%2e%2f, NUL, backslash, and absolute segments are refused", async () => {
    const { auth, config, store } = await createFixture();
    const app = buildApp({ config: { ...config, port: 0 }, auth, store });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    const rawPaths = ["/../etc/passwd", "/foo\\bar"];
    for (const rawPath of rawPaths) {
      const rawResponse = await new Promise<string>((resolve) => {
        const client = net.connect({ host: "127.0.0.1", port }, () => {
          client.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        });
        let data = "";
        client.on("data", (chunk) => { data += chunk.toString(); });
        client.on("close", () => resolve(data));
      });
      expect(rawResponse, `Testing raw path ${rawPath}`).not.toContain("200 OK");
      expect(rawResponse, `Testing raw path ${rawPath}`).not.toContain("root:");
    }

    const traversalRequests = [
      "/%2e%2e%2fetc/passwd",
      "/..%2fetc/passwd",
      "/foo/%00/bar",
      "/foo%5cbar",
      "//etc/passwd",
      "/%2fetc/passwd",
      "/c:/windows/win.ini",
      "/C:%5Cwindows",
    ];
    for (const url of traversalRequests) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, `Testing traversal URL ${url}`).not.toBe(200);
      expect(response.body, `Body should not contain root: for ${url}`).not.toContain("root:");
    }

    await app.close();
  });

  it("/guest/ serves the guest index.html when present", async () => {
    const { auth, config, store, guestDir } = await createFixture();
    const app = buildApp({ config, auth, store });

    // With trailing slash
    const resWithSlash = await app.inject({ method: "GET", url: "/guest/" });
    expect(resWithSlash.statusCode).toBe(200);
    expect(resWithSlash.headers["content-type"]).toContain("text/html");
    expect(resWithSlash.headers["referrer-policy"]).toBe("no-referrer");
    expect(resWithSlash.headers["x-content-type-options"]).toBe("nosniff");
    expect(resWithSlash.body).toContain("Guest Viewer");

    // Without trailing slash
    const resWithoutSlash = await app.inject({ method: "GET", url: "/guest" });
    expect(resWithoutSlash.statusCode).toBe(200);
    expect(resWithoutSlash.body).toContain("Guest Viewer");

    // Non-existent guest asset 404s (no SPA fallback for guest)
    const resGuestMissing = await app.inject({ method: "GET", url: "/guest/missing.js" });
    expect(resGuestMissing.statusCode).toBe(404);
    expect(resGuestMissing.body).not.toContain("Guest Viewer");

    await app.close();
  });

  it("WebSocket upgrade over the same server exchanges binary frames and answers /api/capabilities 401", async () => {
    const { auth, config, store } = await createFixture();
    const app = buildApp({
      config: { ...config, port: 0 },
      auth,
      store,
    });

    await app.ready();

    const internalRelay = createServer();
    const relay = createRelay({
      server: app.server,
      attachOnly: true,
      allowHost: false,
      allowedOrigin: undefined,
    });
    relay.attach(internalRelay, { allowHost: true });
    await relay.start();
    const internalListening = once(internalRelay, "listening");
    internalRelay.listen(0, "127.0.0.1");
    await internalListening;

    const internalPort = (internalRelay.address() as AddressInfo).port;
    expect((internalRelay.address() as AddressInfo).address).toBe("127.0.0.1");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    const port = address.port;

    const hostRoom = "test-single-origin-room-123456";
    const rejectedHost = new WebSocket(`ws://127.0.0.1:${port}/r/${hostRoom}?role=host`);
    const [hostError] = await once(rejectedHost, "error") as [Error];
    expect(hostError.message).toContain("401");
    const hostWs = new WebSocket(`ws://127.0.0.1:${internalPort}/r/${hostRoom}?role=host`);
    await once(hostWs, "open");
    // Host waits for peer-joined control frame when guest connects
    const guestJoinedPromise = new Promise<number>((resolve) => {
      hostWs.on("message", (data: Buffer | string, isBinary: boolean) => {
        if (!isBinary) {
          const parsed = JSON.parse(data.toString());
          if (parsed.t === "peer-joined") resolve(parsed.peer);
        }
      });
    });

    const guestWs = new WebSocket(`ws://127.0.0.1:${port}/r/${hostRoom}?role=guest`);
    await once(guestWs, "open");

    const assignedPeerId = await guestJoinedPromise;
    expect(assignedPeerId).toBe(1);

    // Exchange 1: Host -> Guest
    // Host sends 4-byte peerId (target peer 1) + payload
    const hostPayload = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x11, 0x22, 0x33, 0x44]);
    const guestReceivedPromise = new Promise<Buffer>((resolve) => {
      guestWs.on("message", (data: Buffer) => resolve(Buffer.from(data)));
    });

    hostWs.send(hostPayload);
    const guestReceived = await guestReceivedPromise;
    // Host frame arrived unchanged
    expect(guestReceived.equals(hostPayload)).toBe(true);

    // Exchange 2: Guest -> Host
    // Guest sends 4-byte dummy header + payload
    const guestPayload = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x55, 0x66, 0x77, 0x88]);
    const hostReceivedPromise = new Promise<Buffer>((resolve) => {
      hostWs.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) resolve(Buffer.from(data));
      });
    });

    guestWs.send(guestPayload);
    const hostReceived = await hostReceivedPromise;

    // Relay rewrites prefix in-place with assignedPeerId (1); payload bytes unchanged
    const expectedHostReceived = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x55, 0x66, 0x77, 0x88]);
    expect(hostReceived.equals(expectedHostReceived)).toBe(true);

    hostWs.close();
    guestWs.close();
    await relay.stop();
    await app.close();
  });

  it("Assert generated overlay content contains relayUrl and autoStart", async () => {
    const { dir } = await createFixture();
    const port = 8791;

    // Direct render check
    const rendered = renderOverlay(port);
    expect(rendered).toContain(`relayUrl: ws://127.0.0.1:${port}`);
    expect(rendered).toContain("autoStart: control");

    // Written file check
    const overlayDir = join(dir, "overlays");
    await mkdir(overlayDir, { recursive: true });
    const filePath = await writeOverlay(overlayDir, "test-conv-abc", port);
    const content = await readFile(filePath, "utf-8");

    expect(content).toContain(`relayUrl: ws://127.0.0.1:${port}`);
    expect(content).toContain("autoStart: control");
  });

  it("overlay content contains relayUrl: ws://127.0.0.1:<relayPort> and webUrl: <publicOrigin>", () => {
    const relayPort = 8792;
    const publicOrigin = "http://127.0.0.1:8791";
    const rendered = renderOverlay(relayPort, publicOrigin);
    expect(rendered).toContain(`relayUrl: ws://127.0.0.1:${relayPort}`);
    expect(rendered).toContain(`webUrl: ${publicOrigin}`);
    expect(rendered).toContain("autoStart: control");
  });
});
