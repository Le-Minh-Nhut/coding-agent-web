// @vitest-environment jsdom
/**
 * D4/D5 (round 28 post-fix audit): `send()` resolved `true` for a frame that was
 * only QUEUED, and every terminal path (`#failFatal`, the 4004-terminal branch,
 * `close()`) then cleared the queue — so a caller told its frame was sent had it
 * silently discarded, and the composer's draft-retention fix never fired for the
 * case it was written for. Separately, a full queue killed the whole socket
 * instead of refusing the frame that overflowed it.
 *
 * Contract under test: `send()` resolves `true` only when the envelope actually
 * reaches the wire (immediately, or later from the flush after the host's welcome)
 * and `false` when it will never be sent — refused because the queue is full, or
 * discarded by a terminal close — and a full queue refuses frames without
 * destroying an otherwise-recoverable socket.
 */
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { GuestFrame, HostFrame } from "../../packages/guest/src/vendor/wire";
import { packEnvelope } from "../../packages/guest/src/lib/link";
import { generateRoomKey, importRoomKey, seal } from "../../packages/guest/src/lib/codec";
import { CollabSocket } from "../../packages/guest/src/lib/socket";

const servers: WebSocketServer[] = [];
const sockets: CollabSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  await Promise.all(
    servers.splice(0).map(async (server) => {
      for (const client of server.clients) client.terminate();
      server.close();
      await once(server, "close");
    }),
  );
});

async function startServer(): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr !== "object" || !("port" in addr)) throw new Error("invalid server address");
  servers.push(server);
  return { server, port: addr.port };
}

/** Server-side reply: seal the frame and prefix the envelope header. */
function sendFrame(ws: WsWebSocket, key: CryptoKey, frame: HostFrame): void {
  void seal(key, frame).then((sealed) => ws.send(packEnvelope(0, sealed)));
}

/** A server that greets every `hello` with a `welcome`, counting the frames it saw. */
async function greetingServer(key: CryptoKey): Promise<{ port: number; frames: string[] }> {
  const { server, port } = await startServer();
  const frames: string[] = [];
  server.on("connection", (ws) => {
    ws.on("message", (raw: Buffer) => {
      const bytes = new Uint8Array(raw);
      if (bytes.byteLength <= 4) return;
      frames.push(String(bytes.byteLength));
      sendFrame(ws, key, { t: "welcome" } as HostFrame);
    });
  });
  return { port, frames };
}

describe("D4 a queued frame's caller learns it was dropped by a terminal path", () => {
  it("resolves send(false) when the terminal 4004 close discards the queue", async () => {
    const key = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    let connections = 0;

    server.on("connection", (ws) => {
      connections += 1;
      // First connection: the room is closed (4001 → reconnect). Second: the room
      // never came back (4004 after a 4001 retry → terminal).
      if (connections === 1) ws.close(4001, "room closed");
      else ws.close(4004, "no such room");
    });

    const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
    sockets.push(client);
    const closes: boolean[] = [];
    client.onClose = (_reason, willReconnect) => closes.push(willReconnect);
    // The real client seeds the handshake on open; without it the queue could never
    // flush, so mirror that.
    client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);

    // Queued before any connection exists (the same shape as the audit probe).
    const queued = client.send({ t: "prompt", text: "important prompt" } as GuestFrame);
    client.connect();

    await vi.waitFor(() => expect(closes.length).toBeGreaterThanOrEqual(2), { timeout: 8000 });
    expect(closes[1]).toBe(false);

    // The caller must learn the frame it queued was never delivered.
    await expect(queued).resolves.toBe(false);
  });

  it("resolves send(false) for frames dropped by an intentional close()", async () => {
    const key = await importRoomKey(generateRoomKey());
    // A server that accepts the connection but never greets: the frames stay queued.
    const { server, port } = await startServer();
    server.on("connection", () => {});
    const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
    sockets.push(client);
    client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);

    const queued = client.send({ t: "prompt", text: "never sent" } as GuestFrame);
    client.connect();
    await vi.waitFor(() => expect(client.isOpen).toBe(true), { timeout: 5000 });
    client.close();

    await expect(queued).resolves.toBe(false);
  });

  it("resolves send(true) only once the queued frame reaches the wire", async () => {
    const key = await importRoomKey(generateRoomKey());
    const { port, frames } = await greetingServer(key);

    const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
    sockets.push(client);
    client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);

    const queued = client.send({ t: "prompt", text: "hi" } as GuestFrame);
    client.connect();

    await expect(queued).resolves.toBe(true);
    // hello + the flushed prompt reached the server.
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  });
});

describe("D5 a full queue refuses the frame without destroying the socket", () => {
  it("refuses only the overflowing frames, then flushes once the host welcomes", async () => {
    const key = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    let hellos = 0;

    server.on("connection", (ws) => {
      ws.on("message", (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        hellos += 1;
        // Greet the handshake only; the queued backlog is appended to the same
        // connection afterwards. A second hello (a reconnect) is welcomed too.
        sendFrame(ws, key, { t: "welcome" } as HostFrame);
      });
    });

    const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
    sockets.push(client);
    const closes: boolean[] = [];
    client.onClose = (_reason, willReconnect) => closes.push(willReconnect);
    // The greeting must reach the wire immediately, which the handshake allowance
    // gives `hello`; the backlog below it stays queued until the welcome.
    client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);

    // Fill and overflow the queue while the socket is still closed.
    const sends: Array<Promise<boolean>> = [];
    for (let i = 0; i < 300; i++) sends.push(client.send({ t: "abort" } as GuestFrame));

    client.connect();
    // The 256 that fit flush with `true` once the host welcomes; the 44 refused
    // frames, and only those, resolve `false`.
    const results = await Promise.all(sends);
    expect(results.filter(Boolean).length).toBe(256);
    expect(results.filter((value) => !value).length).toBe(44);
    await vi.waitFor(() => expect(hellos).toBeGreaterThan(0), { timeout: 5000 });

    // The overflow refuses frames without killing the socket: a full queue is not
    // evidence that the connection is unrecoverable, so no terminal close is
    // reported. Asserted only after every terminal path above has had its chance to
    // run — a close reported from a `.then()` is invisible to a synchronous check.
    expect(closes.filter((willReconnect) => !willReconnect)).toEqual([]);
  });

  it("keeps accepting frames after the queue flushes", async () => {
    const key = await importRoomKey(generateRoomKey());
    const { port } = await greetingServer(key);

    const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
    sockets.push(client);
    const closes: boolean[] = [];
    client.onClose = (_reason, willReconnect) => closes.push(willReconnect);
    client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);

    for (let i = 0; i < 256; i++) void client.send({ t: "abort" } as GuestFrame);
    await expect(client.send({ t: "abort" } as GuestFrame)).resolves.toBe(false);
    // Refusing the overflowing frame must not have ended the socket.
    expect(closes).toEqual([]);

    client.connect();
    await vi.waitFor(async () => expect(await client.send({ t: "abort" } as GuestFrame)).toBe(true), {
      timeout: 5000,
    });
  });
});
