/**
 * Relay contract tests. Every assertion here is wire behaviour verified against real OMP clients;
 * the upstream citations for each rule live in the package README.
 *
 * Tests are event-driven: they await the exact message they need instead of sleeping, and a
 * "nothing else arrived" claim is proved by pushing a marker frame through the same path afterwards
 * and asserting the unexpected frame is absent from the ordered stream (WebSocket frames on one
 * connection arrive in send order, so the marker is a real barrier, not a guessed delay).
 */
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRelay,
  MAX_FRAME_BYTES,
  MAX_GUESTS_PER_ROOM,
  RELAY_CLOSE,
  type Relay,
} from "@caw/relay";

const ORIGIN = "https://laptop.tailnet-example.ts.net";
const OTHER_ORIGIN = "https://evil.example";
const ROOM = "room-abcdefghijkl";
const OTHER_ROOM = "room-mnopqrstuvwx";

/** Guard for a message that should have arrived; never used as a wait. */
const SIGNAL_TIMEOUT_MS = 5_000;

const relays: Relay[] = [];

afterEach(async () => {
  await Promise.all(relays.splice(0).map((relay) => relay.stop()));
});

async function startRelay(staticDir?: string): Promise<string> {
  const relay = createRelay({
    port: 0,
    host: "127.0.0.1",
    allowedOrigin: ORIGIN,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...(staticDir === undefined ? {} : { staticDir }),
  });
  relays.push(relay);
  return (await relay.start()).url;
}

interface Peer {
  ws: WebSocket;
  binary: Buffer[];
  text: Array<Record<string, unknown>>;
  closed: { code: number; reason: string } | undefined;
  send(frame: Buffer | string): void;
  /** Resolve when `binary` holds at least `count` frames. */
  awaitBinary(count: number): Promise<void>;
  /** Resolve when `text` holds at least `count` control frames. */
  awaitControl(count: number): Promise<void>;
  /** Resolve when the socket closes. */
  awaitClose(): Promise<void>;
}

function nextFrame(
  peer: Peer,
  name: "binary" | "text",
  count: number,
): Promise<void> {
  if (peer[name].length >= count) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.ws.off("message", check);
      reject(new Error(`timed out waiting for ${count} ${name} frame(s)`));
    }, SIGNAL_TIMEOUT_MS);
    const check = (): void => {
      if (peer[name].length < count) return;
      clearTimeout(timer);
      peer.ws.off("message", check);
      resolve();
    };
    peer.ws.on("message", check);
  });
}

async function openPeer(
  url: string,
  room: string,
  role: string,
  origin: string | null = ORIGIN,
  options: Record<string, unknown> = {},
): Promise<Peer> {
  const ws = new WebSocket(
    `${url}/r/${room}?role=${role}`,
    origin === null ? options : { origin, ...options },
  );
  const binary: Buffer[] = [];
  const text: Array<Record<string, unknown>> = [];
  const peer: Peer = {
    ws,
    binary,
    text,
    closed: undefined,
    send: (frame) => {
      ws.send(frame);
    },
    awaitBinary: (count) => nextFrame(peer, "binary", count),
    awaitControl: (count) => nextFrame(peer, "text", count),
    awaitClose: async () => {
      if (peer.closed) return;
      await once(ws, "close");
    },
  };
  ws.on("message", (data, isBinary) => {
    const buffer = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);
    if (isBinary) binary.push(buffer);
    else
      text.push(JSON.parse(buffer.toString("utf8")) as Record<string, unknown>);
  });
  ws.on("close", (code, reason) => {
    peer.closed = { code, reason: reason.toString() };
  });
  await once(ws, "open");
  return peer;
}

/** Envelope `[4B uint32 BE peerId][payload]`. */
function envelope(peerId: number, payload: Buffer): Buffer {
  const out = Buffer.alloc(4 + payload.length);
  out.writeUInt32BE(peerId, 0);
  payload.copy(out, 4);
  return out;
}

function payloadOf(frame: Buffer): Buffer {
  return frame.subarray(4);
}

async function openFailure(
  url: string,
  room: string,
  role: string,
): Promise<{ code: number; reason: string }> {
  const ws = new WebSocket(`${url}/r/${room}?role=${role}`, { origin: ORIGIN });
  const [code, reason] = (await once(ws, "close")) as [number, Buffer];
  return { code, reason: reason.toString() };
}

async function upgradeRejection(
  url: string,
  target: string,
  options: Record<string, unknown>,
): Promise<string> {
  const ws = new WebSocket(target, options);
  const [error] = (await once(ws, "error")) as [Error];
  return error.message;
}

describe("relay routing", () => {
  it("broadcasts host peerId 0 to every guest, byte-identical", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest1 = await openPeer(url, ROOM, "guest");
    const guest2 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(2);

    const frame = envelope(0, Buffer.from("sealed-broadcast"));
    host.send(frame);
    await Promise.all([guest1.awaitBinary(1), guest2.awaitBinary(1)]);

    expect(guest1.binary[0]!.equals(frame)).toBe(true);
    expect(guest2.binary[0]!.equals(frame)).toBe(true);
    expect(guest2.binary[0]!.readUInt32BE(0)).toBe(0);
    expect(guest1.binary).toHaveLength(1);
    guest1.ws.close();
    guest2.ws.close();
  });

  it("targets only the guest named by a nonzero peerId", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest1 = await openPeer(url, ROOM, "guest");
    const guest2 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(2);

    host.send(envelope(2, Buffer.from("sealed-for-guest-2")));
    await guest2.awaitBinary(1);
    // Barrier: guest 1 must see the broadcast that follows the targeted frame, and nothing before it.
    host.send(envelope(0, Buffer.from("barrier")));
    await guest1.awaitBinary(1);
    await guest2.awaitBinary(2);

    expect(guest2.binary[0]!.readUInt32BE(0)).toBe(2);
    expect(payloadOf(guest2.binary[0]!).toString("utf8")).toBe(
      "sealed-for-guest-2",
    );
    expect(guest1.binary).toHaveLength(1);
    expect(payloadOf(guest1.binary[0]!).toString("utf8")).toBe("barrier");
    expect(host.text.map((message) => message.peer)).toEqual([1, 2]);
    guest1.ws.close();
    guest2.ws.close();
  });

  it("rewrites only the 4-byte prefix of a guest frame on its way to the host", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest1 = await openPeer(url, ROOM, "guest");
    const guest2 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(2);

    // Guest 2 sends a zero prefix and a payload whose first bytes look like a prefix themselves.
    const payload = Buffer.from("00ff0000deadbeefcafe", "hex");
    const sent = envelope(0, payload);
    guest2.send(sent);
    await host.awaitBinary(1);

    const received = host.binary[0]!;
    expect(received.readUInt32BE(0)).toBe(2);
    expect(payloadOf(received).equals(payload)).toBe(true);
    expect(received.length).toBe(sent.length);

    // Guest 1 is peerId 1; its rewrite is independent.
    guest1.send(envelope(0, Buffer.from("from-guest-1")));
    await host.awaitBinary(2);
    expect(host.binary[1]!.readUInt32BE(0)).toBe(1);
    expect(payloadOf(host.binary[1]!).toString("utf8")).toBe("from-guest-1");
    guest1.ws.close();
    guest2.ws.close();
  });

  it("drops frames shorter than the envelope header instead of crashing", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest = await openPeer(url, ROOM, "guest");
    await host.awaitControl(1);

    host.send(Buffer.from([0, 0, 1]));
    guest.send(Buffer.from([0]));
    guest.send(Buffer.alloc(0));
    // Barrier through both directions.
    guest.send(envelope(0, Buffer.from("barrier")));
    await host.awaitBinary(1);

    expect(payloadOf(host.binary[0]!).toString("utf8")).toBe("barrier");
    expect(host.binary).toHaveLength(1);
    expect(guest.binary).toHaveLength(0);
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    expect(guest.ws.readyState).toBe(WebSocket.OPEN);
    guest.ws.close();
  });
});

describe("relay control frames", () => {
  it("emits peer-joined and peer-left with the assigned ids", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest1 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(1);
    const guest2 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(2);

    expect(host.text[0]).toEqual({ t: "peer-joined", peer: 1 });
    expect(host.text[1]).toEqual({ t: "peer-joined", peer: 2 });

    guest1.ws.close();
    await host.awaitControl(3);
    expect(host.text[2]).toEqual({ t: "peer-left", peer: 1 });

    // Ids are not reused while the room lives: the next guest is 3.
    const guest3 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(4);
    expect(host.text[3]).toEqual({ t: "peer-joined", peer: 3 });
    guest2.ws.close();
    guest3.ws.close();
  });

  it("sends room-closed to guests and closes them with 4001 when the host leaves", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest1 = await openPeer(url, ROOM, "guest");
    const guest2 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(2);

    host.ws.close();
    await Promise.all([guest1.awaitClose(), guest2.awaitClose()]);

    expect(guest1.text).toEqual([{ t: "room-closed" }]);
    expect(guest2.text).toEqual([{ t: "room-closed" }]);
    expect(guest1.closed).toEqual({
      code: RELAY_CLOSE.roomClosed,
      reason: "room closed",
    });
    expect(guest2.closed).toEqual({
      code: RELAY_CLOSE.roomClosed,
      reason: "room closed",
    });

    // The room is gone: a later guest is refused with 4004, and the id is free for a new host.
    expect(await openFailure(url, ROOM, "guest")).toEqual({
      code: RELAY_CLOSE.noSuchRoom,
      reason: "no such room",
    });
    const newHost = await openPeer(url, ROOM, "host");
    expect(newHost.ws.readyState).toBe(WebSocket.OPEN);
    newHost.ws.close();
  });

  it("ignores TEXT frames from clients in both directions", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest = await openPeer(url, ROOM, "guest");
    await host.awaitControl(1);

    host.send("plaintext-from-host");
    guest.send(JSON.stringify({ t: "peer-joined", peer: 999 }));
    // Barriers: a real frame in each direction must arrive, and the TEXT frames must not.
    guest.send(envelope(0, Buffer.from("barrier")));
    await host.awaitBinary(1);

    expect(payloadOf(host.binary[0]!).toString("utf8")).toBe("barrier");
    expect(guest.binary).toHaveLength(0);
    expect(guest.text).toHaveLength(0);
    expect(host.text).toHaveLength(1);
    guest.ws.close();
  });
});

describe("relay admission", () => {
  it("rejects a second host for a live room with 4009 without disturbing the first", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    expect(await openFailure(url, ROOM, "host")).toEqual({
      code: RELAY_CLOSE.hostConflict,
      reason: "a host is already connected for this room",
    });

    // The first host still owns the room: guest admission and control still work.
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    const guest = await openPeer(url, ROOM, "guest");
    await host.awaitControl(1);
    expect(host.text[0]).toEqual({ t: "peer-joined", peer: 1 });
    guest.ws.close();
  });

  it("rejects a guest on a missing room with 4004", async () => {
    const url = await startRelay();
    expect(await openFailure(url, OTHER_ROOM, "guest")).toEqual({
      code: RELAY_CLOSE.noSuchRoom,
      reason: "no such room",
    });
  });

  it("rejects bad room ids and roles with 4000", async () => {
    const url = await startRelay();
    const badRequests: Array<[string, string]> = [
      ["short", "host"],
      ["x".repeat(65), "guest"],
      [`${ROOM}.`, "guest"],
      [ROOM, "evil"],
      [ROOM, ""],
      [`${ROOM}%20`, "guest"],
    ];
    for (const [room, role] of badRequests) {
      const failure = await openFailure(url, room, role);
      expect({
        room,
        role,
        code: failure.code,
        reason: failure.reason,
      }).toEqual({
        room,
        role,
        code: RELAY_CLOSE.badRequest,
        reason: "bad request",
      });
    }
  });

  it("refuses the upgrade for non-relay paths", async () => {
    const url = await startRelay();
    expect(
      await upgradeRejection(url, `${url}/nope?role=host`, { origin: ORIGIN }),
    ).toContain("404");
    expect(
      await upgradeRejection(url, `${url}/`, { origin: ORIGIN }),
    ).toContain("404");
  });

  it("caps guests per room and closes the extra guest with 4029", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guests: Peer[] = [];
    for (let i = 0; i < MAX_GUESTS_PER_ROOM; i += 1)
      guests.push(await openPeer(url, ROOM, "guest"));
    await host.awaitControl(MAX_GUESTS_PER_ROOM);

    expect(await openFailure(url, ROOM, "guest")).toEqual({
      code: RELAY_CLOSE.roomFull,
      reason: "room is full",
    });

    // Freeing one slot admits the next guest.
    guests[0]!.ws.close();
    await host.awaitControl(MAX_GUESTS_PER_ROOM + 1);
    const latecomer = await openPeer(url, ROOM, "guest");
    expect(latecomer.ws.readyState).toBe(WebSocket.OPEN);
    for (const guest of guests.slice(1)) guest.ws.close();
    latecomer.ws.close();
  });

  it("closes an oversized frame with 1009 and keeps serving", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest = await openPeer(url, ROOM, "guest");
    await host.awaitControl(1);

    guest.ws.send(Buffer.alloc(MAX_FRAME_BYTES + 1));
    await guest.awaitClose();
    expect(guest.closed!.code).toBe(1009);

    // The host is unaffected and can still serve a fresh guest.
    expect(host.ws.readyState).toBe(WebSocket.OPEN);
    const replacement = await openPeer(url, ROOM, "guest");
    replacement.ws.close();
  });

  it("enforces the browser Origin allowlist and lets native clients without Origin through", async () => {
    const url = await startRelay();
    expect(
      await upgradeRejection(url, `${url}/r/${ROOM}?role=host`, {
        origin: OTHER_ORIGIN,
      }),
    ).toContain("403");
    expect(
      await upgradeRejection(url, `${url}/r/${ROOM}?role=host`, {
        origin: ORIGIN,
        headers: { "sec-fetch-site": "cross-site" },
      }),
    ).toContain("403");

    // OMP's own client sends no Origin header at all.
    const native = await openPeer(url, ROOM, "host", null);
    expect(native.ws.readyState).toBe(WebSocket.OPEN);
    native.ws.close();
  });
});

describe("relay counters and shutdown", () => {
  it("reports rooms, guests and uptime", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest = await openPeer(url, ROOM, "guest");
    const otherHost = await openPeer(url, OTHER_ROOM, "host");
    await host.awaitControl(1);

    const status = relays[0]!.status();
    expect(status).toMatchObject({ host: "127.0.0.1", rooms: 2, guests: 1 });
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.url).toBe(url);

    guest.ws.close();
    await host.awaitControl(2);
    expect(relays[0]!.status().guests).toBe(0);

    // A new host for the same id is admitted only once the old room is gone.
    host.ws.close();
    const replacementHost = await openPeer(url, ROOM, "host");
    expect(relays[0]!.status()).toMatchObject({ rooms: 2, guests: 0 });
    replacementHost.ws.close();
    otherHost.ws.close();
  });

  it("closes every peer with 4001/1001 on stop, and stops idempotently", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest = await openPeer(url, ROOM, "guest");
    await host.awaitControl(1);

    await relays[0]!.stop();
    await relays[0]!.stop();
    expect(guest.closed!.code).toBe(RELAY_CLOSE.roomClosed);
    expect(guest.text).toEqual([{ t: "room-closed" }]);
    expect(host.closed!.code).toBe(1001);
    expect(relays[0]!.status()).toMatchObject({ rooms: 0, guests: 0 });
  });
});

describe("relay fuzz", () => {
  /** Deterministic PRNG so a failure is reproducible. */
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("preserves payload integrity across 100 random frames in both directions", async () => {
    const url = await startRelay();
    const host = await openPeer(url, ROOM, "host");
    const guest1 = await openPeer(url, ROOM, "guest");
    const guest2 = await openPeer(url, ROOM, "guest");
    await host.awaitControl(2);

    const random = mulberry32(0xc0ffee);
    const broadcast: Array<{ target: Peer; payload: Buffer }> = [];
    const targeted: Array<{ guest: number; payload: Buffer; frame: Buffer }> =
      [];
    const fromGuests: Array<{ guest: number; payload: Buffer }> = [];

    for (let i = 0; i < 100; i += 1) {
      const size = 1 + Math.floor(random() * 256);
      const payload = Buffer.alloc(size);
      for (let j = 0; j < size; j += 1) payload[j] = Math.floor(random() * 256);
      const mode = i % 3;
      if (mode === 0) {
        host.send(envelope(0, payload));
        broadcast.push(
          { target: guest1, payload },
          { target: guest2, payload },
        );
      } else if (mode === 1) {
        const target = i % 6 === 1 ? 1 : 2;
        const frame = envelope(target, payload);
        host.send(frame);
        targeted.push({ guest: target, payload, frame });
      } else {
        const sender = i % 2 === 1 ? guest1 : guest2;
        const peerId = i % 2 === 1 ? 1 : 2;
        sender.send(envelope(0, payload));
        fromGuests.push({ guest: peerId, payload });
      }
    }

    const broadcastCount = (target: Peer) =>
      broadcast.filter((entry) => entry.target === target).length;
    const targetedCount = (guest: number) =>
      targeted.filter((entry) => entry.guest === guest).length;
    await Promise.all([
      guest1.awaitBinary(broadcastCount(guest1) + targetedCount(1)),
      guest2.awaitBinary(broadcastCount(guest2) + targetedCount(2)),
      host.awaitBinary(fromGuests.length),
    ]);

    for (const { target, payload } of broadcast) {
      expect(
        target.binary.some(
          (frame) =>
            frame.readUInt32BE(0) === 0 && payloadOf(frame).equals(payload),
        ),
      ).toBe(true);
    }
    for (const { guest, payload, frame } of targeted) {
      const peer = guest === 1 ? guest1 : guest2;
      expect(peer.binary.some((received) => received.equals(frame))).toBe(true);
      expect(
        peer.binary.some((received) => payloadOf(received).equals(payload)),
      ).toBe(true);
    }
    for (const { guest, payload } of fromGuests) {
      expect(
        host.binary.some(
          (frame) =>
            frame.readUInt32BE(0) === guest && payloadOf(frame).equals(payload),
        ),
      ).toBe(true);
    }

    // Nothing crashed, nothing was invented, and no guest frame reached a guest.
    expect(relays[0]!.status()).toMatchObject({ rooms: 1, guests: 2 });
    expect(host.binary).toHaveLength(fromGuests.length);
    expect(host.binary.some((frame) => frame.readUInt32BE(0) === 0)).toBe(
      false,
    );
    expect(guest1.binary).toHaveLength(
      broadcastCount(guest1) + targetedCount(1),
    );
    expect(guest2.binary).toHaveLength(
      broadcastCount(guest2) + targetedCount(2),
    );
    guest1.ws.close();
    guest2.ws.close();
  });
});

describe("relay security and rate limiting", () => {
  it("SEC-2: with authorizeHost supplied, unauthenticated host is refused 401 while authorized host and guests succeed", async () => {
    const relay = createRelay({
      port: 0,
      host: "127.0.0.1",
      allowedOrigin: ORIGIN,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      authorizeHost: (req) => req.headers.authorization === "Bearer secret-token",
    });
    relays.push(relay);
    const url = (await relay.start()).url;

    // Unauthenticated host is refused with 401
    const unauthErr = await upgradeRejection(
      url,
      `${url}/r/${ROOM}?role=host`,
      { origin: ORIGIN },
    );
    expect(unauthErr).toContain("401");

    // Authorized host succeeds
    const host = await openPeer(url, ROOM, "host", ORIGIN, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(host.ws.readyState).toBe(WebSocket.OPEN);

    // Guest does NOT require authorizeHost and connects
    const guest = await openPeer(url, ROOM, "guest", ORIGIN);
    expect(guest.ws.readyState).toBe(WebSocket.OPEN);

    host.ws.close();
    guest.ws.close();
  });

  it("SEC-2: room cap refuses new room past maxRooms with 503 and existing rooms keep working", async () => {
    const maxRooms = 5;
    const relay = createRelay({
      port: 0,
      host: "127.0.0.1",
      allowedOrigin: ORIGIN,
      maxRooms,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    relays.push(relay);
    const url = (await relay.start()).url;

    const peers: Peer[] = [];
    for (let i = 0; i < maxRooms; i++) {
      const roomName = `room-capacity-test-${i.toString().padStart(5, "0")}`;
      peers.push(await openPeer(url, roomName, "host"));
    }

    expect(relay.status().rooms).toBe(maxRooms);

    // 6th room is refused with 503
    const overflowErr = await upgradeRejection(
      url,
      `${url}/r/room-overflow-test01?role=host`,
      { origin: ORIGIN },
    );
    expect(overflowErr).toContain("503");

    // Existing rooms still work: guest joins room 0
    const guest = await openPeer(url, "room-capacity-test-00000", "guest");
    expect(guest.ws.readyState).toBe(WebSocket.OPEN);

    guest.ws.close();
    for (const p of peers) p.ws.close();
  });

  it("SEC-2: rate limiter refuses burst exceeding 20/s and accepts connection after window", async () => {
    let clock = 1_000_000;
    const relay = createRelay({
      port: 0,
      host: "127.0.0.1",
      allowedOrigin: ORIGIN,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      now: () => clock,
    });
    relays.push(relay);
    const url = (await relay.start()).url;

    // Send 20 connections in the same window
    const peers: Peer[] = [];
    for (let i = 0; i < 20; i++) {
      peers.push(await openPeer(url, `room-rate-limiter-${i.toString().padStart(3, "0")}`, "host"));
    }

    // 21st upgrade within the 1-second window is rejected with 429
    const limitedErr = await upgradeRejection(
      url,
      `${url}/r/room-burst-rate-limit?role=host`,
      { origin: ORIGIN },
    );
    expect(limitedErr).toContain("429");

    // Advance clock past the 1-second window deterministically without sleeping
    clock += 1001;

    // Upgrade now succeeds
    const normalPeer = await openPeer(url, "room-after-window-123", "host");
    expect(normalPeer.ws.readyState).toBe(WebSocket.OPEN);

    normalPeer.ws.close();
    for (const p of peers) p.ws.close();
  });
});
