import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  CollabSocket,
  importRoomKey,
  generateRoomKey,
  seal,
  open,
  packEnvelope,
  unpackEnvelope,
  type GuestFrame,
  type HostFrame,
} from "../../packages/collab-protocol/src/index.js";

function withResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function startServer(): Promise<{ server: WebSocketServer; port: number }> {
  const { promise, resolve, reject } = withResolvers<{ server: WebSocketServer; port: number }>();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => {
    const addr = server.address();
    if (addr && typeof addr === "object" && "port" in addr) {
      resolve({ server, port: (addr as AddressInfo).port });
      return;
    }
    reject(new Error("Invalid server address"));
  });
  return promise;
}

const WS = WsWebSocket as unknown as typeof WebSocket;

describe("CollabSocket against real WebSocket server", () => {
  let wss: WebSocketServer | undefined;
  const activeSockets: CollabSocket[] = [];

  afterEach(async () => {
    for (let i = 0; i < activeSockets.length; i++) {
      activeSockets[i]!.close();
    }
    activeSockets.length = 0;
    if (wss) {
      const { promise, resolve } = withResolvers<void>();
      wss.close(() => resolve());
      await promise;
      wss = undefined;
    }
  });

  it("delivers frames in exact arrival order", async () => {
    const rawKey = generateRoomKey();
    const { key } = await importRoomKey(rawKey);

    const started = await startServer();
    wss = started.server;
    const port = started.port;

    const received: number[] = [];

    wss.on("connection", async (serverWs) => {
      for (let i = 1; i <= 5; i++) {
        const frame: HostFrame = { t: "error", message: `msg-${i}` };
        const sealed = await seal(key, frame);
        const env = packEnvelope(0, sealed);
        serverWs.send(env);
      }
    });

    const client = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/testroom`,
      role: "guest",
      key,
      WebSocketClass: WS,
    });
    activeSockets.push(client);

    const { promise, resolve } = withResolvers<void>();
    client.onFrame = (frame) => {
      if (frame.t === "error") {
        const num = parseInt(frame.message.replace("msg-", ""), 10);
        received.push(num);
        if (received.length === 5) {
          resolve();
        }
      }
    };
    client.connect();
    await promise;

    expect(received).toEqual([1, 2, 3, 4, 5]);
  });

  it("terminates with non-retryable close on decryption failure", async () => {
    const rawKey = generateRoomKey();
    const { key } = await importRoomKey(rawKey);

    const started = await startServer();
    wss = started.server;
    const port = started.port;

    wss.on("connection", (serverWs) => {
      const garbagePayload = new Uint8Array(32).fill(0xee);
      const env = packEnvelope(0, garbagePayload);
      serverWs.send(env);
    });

    const client = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/testroom`,
      role: "guest",
      key,
      WebSocketClass: WS,
    });
    activeSockets.push(client);

    const { promise, resolve } = withResolvers<{ reason: string; willReconnect: boolean }>();
    client.onClose = (reason, willReconnect) => {
      resolve({ reason, willReconnect });
    };
    client.connect();

    const closeInfo = await promise;
    expect(closeInfo.willReconnect).toBe(false);
    expect(closeInfo.reason).toBe("bad key or corrupted frame");
  });

  it("reconnects with backoff after forced socket drop", async () => {
    const rawKey = generateRoomKey();
    const { key } = await importRoomKey(rawKey);

    const started = await startServer();
    wss = started.server;
    const port = started.port;

    let connectionCount = 0;
    wss.on("connection", (serverWs) => {
      connectionCount++;
      if (connectionCount === 1) {
        serverWs.terminate();
      }
    });

    const client = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/testroom`,
      role: "guest",
      key,
      WebSocketClass: WS,
    });
    activeSockets.push(client);

    let closes = 0;
    let opens = 0;

    const { promise, resolve } = withResolvers<void>();

    client.onOpen = () => {
      opens++;
      if (opens === 2) {
        resolve();
      }
    };

    client.onClose = (_reason, willReconnect) => {
      if (_reason !== "closed") {
        closes++;
        expect(willReconnect).toBe(true);
      }
    };

    client.connect();
    await promise;

    expect(connectionCount).toBeGreaterThanOrEqual(2);
    expect(closes).toBeGreaterThanOrEqual(1);
    expect(opens).toBe(2);
  });

  it("refuses sends before open and until hello is acknowledged", async () => {
    const rawKey = generateRoomKey();
    const { key } = await importRoomKey(rawKey);
    const started = await startServer();
    wss = started.server;
    const { port } = started;
    const received: GuestFrame[] = [];
    const welcomeFrame: HostFrame = {
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "native", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" },
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] },
      agents: [],
      entryCount: 0,
    };
    wss.on("connection", (serverWs) => {
      serverWs.on("message", async (data) => {
        const envelope = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        const parsed = unpackEnvelope(envelope)!;
        const frame = await open<GuestFrame>(key, parsed.payload);
        received.push(frame);
        if (frame.t === "hello") serverWs.send(packEnvelope(0, await seal(key, welcomeFrame)));
      });
    });
    const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/testroom`, role: "guest", key, WebSocketClass: WS });
    activeSockets.push(client);
    expect(await client.send({ t: "prompt", text: "too early" })).toBe(false);
    const opened = withResolvers<void>();
    client.onOpen = () => opened.resolve();
    client.connect();
    await opened.promise;
    expect(await client.send({ t: "prompt", text: "before hello" })).toBe(false);
    expect(await client.send({ t: "hello", proto: 3, name: "test" })).toBe(true);
    const welcomed = withResolvers<void>();
    client.onFrame = (frame) => { if (frame.t === "welcome") welcomed.resolve(); };
    await welcomed.promise;
    expect(await client.send({ t: "prompt", text: "after hello" })).toBe(true);
    await vi.waitFor(() => expect(received.map((frame) => frame.t)).toEqual(["hello", "prompt"]));
    expect(received[1]).toEqual({ t: "prompt", text: "after hello" });
  });
  it("reports pre-hello sends as unsent after reconnect", async () => {
    const rawKey = generateRoomKey();
    const { key } = await importRoomKey(rawKey);
    const started = await startServer();
    wss = started.server;
    const received: GuestFrame[] = [];
    let firstConnection: WsWebSocket | undefined;
    const welcomeFrame: HostFrame = {
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "native", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" },
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] },
      agents: [],
      entryCount: 0,
    };
    wss.on("connection", (serverWs) => {
      if (!firstConnection) firstConnection = serverWs;
      serverWs.on("message", async (data) => {
        const envelope = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        const frame = await open<GuestFrame>(key, unpackEnvelope(envelope)!.payload);
        received.push(frame);
        if (frame.t === "hello") serverWs.send(packEnvelope(0, await seal(key, welcomeFrame)));
      });
    });

    const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${started.port}/r/testroom`, role: "guest", key, WebSocketClass: WS });
    activeSockets.push(client);
    const firstWelcome = withResolvers<void>();
    const secondWelcome = withResolvers<void>();
    const secondOpen = withResolvers<Promise<boolean>>();
    let openCount = 0;
    client.onOpen = () => {
      openCount++;
      if (openCount === 2) {
        const unsent = client.send({ t: "prompt", text: "must not vanish" });
        void client.send({ t: "hello", proto: 3, name: "test" });
        secondOpen.resolve(unsent);
      } else {
        void client.send({ t: "hello", proto: 3, name: "test" });
      }
    };
    client.onFrame = (frame) => {
      if (frame.t !== "welcome") return;
      if (openCount === 1) firstWelcome.resolve();
      else secondWelcome.resolve();
    };

    client.connect();
    await firstWelcome.promise;
    firstConnection!.terminate();
    expect(await (await secondOpen.promise)).toBe(false);
    await secondWelcome.promise;
    expect(await client.send({ t: "prompt", text: "sent after welcome" })).toBe(true);
    await vi.waitFor(() => expect(received.map((frame) => frame.t)).toEqual(["hello", "hello", "prompt"]));
    expect(received.at(-1)).toEqual({ t: "prompt", text: "sent after welcome" });
  });
});
