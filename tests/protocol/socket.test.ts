import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { AddressInfo } from "node:net";
import {
  CollabSocket,
  importRoomKey,
  generateRoomKey,
  seal,
  packEnvelope,
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
});
