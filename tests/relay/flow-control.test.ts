/**
 * Relay flow control.
 *
 * The defect this pins: a guest whose TCP receive window fills while the host is
 * pushing a large session snapshot used to be closed with 1013 the moment the
 * relay's send buffer crossed a ceiling. Both guests read that close as an
 * interrupted snapshot — `packages/guest/src/lib/client.ts` and the web reducer
 * keep entries private until the snapshot completes — so the client reconnected,
 * was closed again, and the conversation stayed blank forever. Observed in
 * production: guests 32–40 each lived seconds and reconnected ~25s later, in a
 * loop, while the owner's session was 3238 entries / ~10.2 MB.
 *
 * These tests drive a real relay over real TCP and stall the guest's own socket,
 * because the bug is about socket backlog and cannot be reproduced by inspecting
 * the relay's state. A stalled peer cannot complete a WebSocket close handshake,
 * so "the relay dropped it" is asserted on the relay's own evidence rather than
 * on the client's close code — waiting for that handshake takes `ws`'s 30s
 * close timeout, which would make the suite slow and the assertion about the
 * wrong thing.
 */
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createRelay, type Relay } from "@caw/relay";

const ROOM = "room-flowcontrol12";
const ORIGIN = "https://laptop.tailnet-example.ts.net";
const CHUNK_BYTES = 512 * 1024;
/** Well past the ~4 MiB ceiling that used to drop the peer. */
const CONTENDED_BYTES = 12 * 1024 * 1024;
/** Past the queued-backlog ceiling, so a peer that never drains must be closed. */
const NEVER_DRAINS_BYTES = 64 * 1024 * 1024;

const relays: Relay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

interface Stoppable {
  pause(): void;
  resume(): void;
}

/** True when `value` exposes the two stream controls this test needs. */
function isStoppable(value: unknown): value is Stoppable {
  if (typeof value !== "object" || value === null) return false;
  return (
    "pause" in value &&
    typeof (value as { pause: unknown }).pause === "function" &&
    "resume" in value &&
    typeof (value as { resume: unknown }).resume === "function"
  );
}

/**
 * The underlying TCP socket, so a test can stop reading without stopping the
 * event loop. `ws` does not publish this, but it is the only way to fill the
 * send window deterministically; a `pause()` on the WebSocket itself does not
 * stop the kernel from accepting bytes.
 */
function tcpSocket(ws: WebSocket): Stoppable {
  if (!("_socket" in ws)) throw new Error("ws socket internals unavailable; cannot stall the peer");
  const socket = ws._socket;
  if (!isStoppable(socket)) throw new Error("ws socket does not expose pause/resume; cannot stall the peer");
  return socket;
}

interface Harness {
  url: string;
  warnings: string[];
}

async function startRelay(): Promise<Harness> {
  const warnings: string[] = [];
  const relay = createRelay({
    port: 0,
    host: "127.0.0.1",
    allowedOrigin: ORIGIN,
    logger: {
      info: () => {},
      warn: (message) => warnings.push(message),
      error: () => {},
    },
  });
  relays.push(relay);
  const { url } = await relay.start();
  return { url, warnings };
}

interface Client {
  ws: WebSocket;
  frames: number;
  sendChunk(): void;
}

function connect(url: string, role: "host" | "guest"): Promise<Client> {
  const ws = new WebSocket(`${url}/r/${ROOM}?role=${role}`, { origin: ORIGIN });
  const client: Client = {
    ws,
    frames: 0,
    sendChunk: () => {
      // peerId 0 = broadcast to every guest. The prefix must be a real uint32;
      // filling the whole buffer with the payload byte would address a guest
      // that does not exist and the relay would drop the frame as untargeted.
      const frame = Buffer.alloc(4 + CHUNK_BYTES, 7);
      frame.writeUInt32BE(0, 0);
      ws.send(frame);
    },
  };
  ws.on("message", () => {
    client.frames += 1;
  });
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve(client));
    ws.on("error", reject);
  });
}

/** Push `bytes` from the host in 512 KiB frames, yielding so the relay can forward. */
async function blast(host: Client, bytes: number): Promise<void> {
  const frames = bytes / CHUNK_BYTES;
  for (let i = 0; i < frames; i += 1) {
    host.sendChunk();
    if (i % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Poll until `check` holds, or fail with `message` after `timeoutMs`. */
async function eventually(check: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (check()) return;
  throw new Error(message);
}

describe("relay flow control under a stalled guest", () => {
  it("pauses a slow guest instead of closing it, then delivers the whole snapshot", async () => {
    const { url, warnings } = await startRelay();
    const host = await connect(url, "host");
    const guest = await connect(url, "guest");

    // Stall the guest's reads so the relay's send window fills up.
    const socket = tcpSocket(guest.ws);
    socket.pause();

    await blast(host, CONTENDED_BYTES);
    // Let the backlog build against the stalled peer.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    // The peer must survive: a slow phone is not a dead one. No close, no drop.
    expect(warnings).toEqual([]);
    expect(guest.ws.readyState).toBe(WebSocket.OPEN);

    // Let it drain; every frame must arrive, none lost and none reordered.
    const expected = CONTENDED_BYTES / CHUNK_BYTES;
    socket.resume();
    await eventually(() => guest.frames >= expected, `only ${guest.frames}/${expected} frames arrived`);

    expect(guest.frames).toBe(expected);
    expect(warnings).toEqual([]);

    host.ws.close();
    guest.ws.close();
  }, 60_000);

  it("still closes a guest that never drains at all", async () => {
    const { url, warnings } = await startRelay();
    const host = await connect(url, "host");
    const guest = await connect(url, "guest");

    // Never resume: the backlog must be bounded, not held forever.
    tcpSocket(guest.ws).pause();
    await blast(host, NEVER_DRAINS_BYTES);
    await eventually(
      () => warnings.some((message) => message.includes("never drains")),
      "the relay held a never-draining peer's backlog instead of bounding it",
    );

    // The peer is refused its remaining frames, which is the bound being enforced.
    expect(guest.frames).toBeLessThan(NEVER_DRAINS_BYTES / CHUNK_BYTES);
    host.ws.close();
  }, 60_000);
});
