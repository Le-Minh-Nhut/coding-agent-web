// @vitest-environment jsdom
/**
 * SEC leak + handshake-gate regressions.
 *
 * - A: a failed link parse must not echo the submitted link (it carries the room key).
 * - B: no frame other than `hello` may reach the wire before the host's `welcome`,
 *   queued frames flush only after that welcome, a 4004 after a 4001 retry is
 *   terminal, and queue overflow surfaces instead of silently dropping.
 */
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { GuestFrame, HostFrame } from "../../packages/guest/src/vendor/wire";
import {
  formatCollabLink,
  packEnvelope,
  parseCollabLink,
} from "../../packages/guest/src/lib/link";
import {
  generateRoomKey,
  importRoomKey,
  open,
  seal,
} from "../../packages/guest/src/lib/codec";
import { CollabSocket } from "../../packages/guest/src/lib/socket";

const servers: WebSocketServer[] = [];
const sockets: CollabSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.terminate();
      // jsdom's Promise lacks withResolvers; `once` keeps the await event-driven.
      server.close();
      await once(server, "close");
    }),
  );
});

async function startServer(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr !== "object" || !("port" in addr)) {
    throw new Error("invalid server address");
  }
  servers.push(server);
  return { server, port: addr.port };
}

/** Server-side reply: seal the frame and prefix the envelope header. */
function sendFrame(ws: WsWebSocket, key: CryptoKey, frame: HostFrame): void {
  void seal(key, frame).then((sealed) => ws.send(packEnvelope(0, sealed)));
}

describe("collab link errors do not echo the submitted link", () => {
  const SECRET_KEY_PART = "B".repeat(43);

  it("parseCollabLink reports a static error for an unparsable link", () => {
    const link = `wss://exa mple.com/r/AAAAAAAAAAAAAAAA.${SECRET_KEY_PART}`;
    const parsed = parseCollabLink(link);
    expect("error" in parsed).toBe(true);
    if (!("error" in parsed)) return;
    expect(parsed.error).not.toContain(SECRET_KEY_PART);
    expect(parsed.error).not.toContain("exa mple.com");
    expect(parsed.error).not.toContain(link);
  });

  it("formatCollabLink reports a static error for a malformed relay URL", () => {
    const attempt = (): void => {
      formatCollabLink("ht tp://relay", "A".repeat(16), new Uint8Array(32));
    };
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain("ht tp://relay");
      expect(message).toBe("Invalid relay URL");
    }
  });

  it("formatCollabLink reports a static error for an unsupported relay scheme", () => {
    const submitted = "ftp://relay.example/r/AAAAAAAAAAAAAAAA";
    const attempt = (): void => {
      formatCollabLink(submitted, "A".repeat(16), new Uint8Array(32));
    };
    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      const message = (error as Error).message;
      // No fragment of the caller's input: not the scheme, not the host.
      expect(message).not.toContain("ftp");
      expect(message).not.toContain("relay.example");
      expect(message).not.toContain(submitted);
      expect(message).toBe("Unsupported relay URL scheme");
    }
  });
});

describe("collab socket handshake gate", () => {
  it("sends hello first and withholds every other frame until welcome", async () => {
    const key = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    const received: string[] = [];

    server.on("connection", (ws) => {
      ws.on("message", (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        const payload = bytes.subarray(4);
        void open(key, payload).then((frame) => {
          if (!("t" in frame)) return;
          received.push(frame.t);
          if (frame.t === "hello") sendFrame(ws, key, { t: "welcome" } as HostFrame);
        });
      });
    });

    const client = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key,
    });
    sockets.push(client);
    client.onOpen = () => client.send({ t: "hello" } as GuestFrame);
    // Queued while the socket is still closed: must not precede hello, and must
    // not reach the wire until the host has answered hello with a welcome.
    client.send({ t: "prompt", text: "hi" } as GuestFrame);

    client.connect();
    await vi.waitFor(() => expect(received.length).toBe(2), { timeout: 5000 });
    // hello went first; the queued prompt waited for the host's welcome.
    expect(received).toEqual(["hello", "prompt"]);
  });

  it("treats a 4004 after a 4001 retry as terminal instead of retrying forever", async () => {
    const key = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    let connections = 0;

    server.on("connection", (ws) => {
      connections += 1;
      if (connections === 1) ws.close(4001, "room closed");
      else ws.close(4004, "no such room");
    });

    const client = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key,
    });
    sockets.push(client);
    const closes: Array<{ reason: string; willReconnect: boolean }> = [];
    client.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });

    client.connect();
    // Real backoff timer (1s base) against a real server — deterministic timers
    // cannot drive a live WebSocket handshake.
    await vi.waitFor(() => expect(closes.length).toBe(2), { timeout: 8000 });

    expect(closes[0]).toEqual({ reason: "room closed", willReconnect: true });
    expect(closes[1]?.willReconnect).toBe(false);
    const connectionsAfterTerminalClose = connections;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(connections).toBe(connectionsAfterTerminalClose);
  });

  it("refuses frames past the queue cap without dropping queued frames silently", async () => {
    const key = await importRoomKey(generateRoomKey());
    // Never connects: every frame queues.
    const client = new CollabSocket({
      wsUrl: "ws://127.0.0.1:1/r/room",
      role: "guest",
      key,
    });
    sockets.push(client);
    const closes: Array<{ reason: string; willReconnect: boolean }> = [];
    client.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });

    const sends: Array<Promise<boolean>> = [];
    for (let i = 0; i < 400; i++) sends.push(client.send({ t: "abort" } as GuestFrame));

    // The first 256 fit and stay queued (their answer is pending until they reach
    // the wire); every frame past the cap is refused with `false`. A full queue is
    // not evidence that the connection is unrecoverable, so the socket survives.
    await expect(Promise.all(sends.slice(256))).resolves.toEqual(Array.from({ length: 144 }, () => false));
    expect(closes).toEqual([]);
    expect(client.isOpen).toBe(false);
  });
});
