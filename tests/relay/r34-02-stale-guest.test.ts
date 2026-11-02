import { randomBytes } from "node:crypto";
import net from "node:net";
import { once } from "node:events";
import { WebSocket } from "ws";
import { afterEach, expect, it } from "vitest";
import { createRelay, type Relay } from "@caw/relay";

const ORIGIN = "https://laptop.tailnet-example.ts.net";
const ROOM = "room-r3402-stale";
const relays: Relay[] = [];
const timeout = (promise: Promise<unknown>) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("signal timeout")), 5000))]);
afterEach(async () => { await Promise.all(relays.splice(0).map((relay) => relay.stop())); });

async function relayUrl() {
  const relay = createRelay({ port: 0, host: "127.0.0.1", allowedOrigin: ORIGIN, logger: { info() {}, warn() {}, error() {} } });
  relays.push(relay);
  return (await relay.start()).url;
}
function client(url: string, role: "host" | "guest") {
  const ws = new WebSocket(`${url}/r/${ROOM}?role=${role}`, { origin: ORIGIN });
  const messages: Buffer[] = [];
  ws.on("message", (data) => messages.push(Buffer.from(data as ArrayBuffer)));
  return { ws, messages };
}
function frame(peer: number, text: string) { const b = Buffer.alloc(4 + Buffer.byteLength(text)); b.writeUInt32BE(peer); b.write(text, 4); return b; }
function maskedBinary(payload: Buffer) {
  const mask = randomBytes(4); const length = payload.length;
  const header = length < 126 ? Buffer.from([0x82, 0x80 | length]) : Buffer.from([0x82, 0xfe, length >> 8, length & 255]);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([header, mask, masked]);
}
async function rawGuest(url: string) {
  const address = new URL(url);
  const socket = net.connect(Number(address.port), address.hostname);
  await once(socket, "connect");
  const key = randomBytes(16).toString("base64");
  socket.write(`GET /r/${ROOM}?role=guest HTTP/1.1\r\nHost: ${address.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`);
  let input = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on("data", (chunk) => { input = Buffer.concat([input, chunk]); wake?.(); wake = undefined; });
  async function take(n: number) { while (input.length < n) await new Promise<void>((resolve) => { wake = resolve; }); const out = input.subarray(0, n); input = input.subarray(n); return out; }
  let headers = Buffer.alloc(0);
  while (!headers.includes("\r\n\r\n")) headers = Buffer.concat([headers, await take(1)]);
  expect(headers.toString()).toContain("101 Switching Protocols");
  const receiveFrame = async () => {
    const h = await take(2); let length = h[1]! & 0x7f;
    if (length === 126) length = (await take(2)).readUInt16BE();
    else if (length === 127) throw new Error("unexpected oversized frame");
    return { opcode: h[0]! & 0x0f, payload: await take(length) };
  };
  const send = (payload: Buffer) => socket.write(maskedBinary(payload));
  const closeFrame = async () => { for (;;) if ((await receiveFrame()).opcode === 8) return; };
  return { socket, send, closeFrame, receiveFrame };
}

it("R34-02: room recreation rejects stale frames and retains normal routing", async () => {
  const url = await relayUrl();
  const host = client(url, "host");
  await once(host.ws, "open");
  const joined = new Promise<void>((resolve) => host.ws.once("message", () => resolve()));
  const old = await rawGuest(url);
  await joined;
  host.ws.close();
  await timeout(once(host.ws, "close"));
  // Hold old guest open after the server sent its close frame; ws waits for the peer close reply.
  await timeout(old.closeFrame());
  const replacement = client(url, "host");
  await once(replacement.ws, "open");
  const received: Buffer[] = [];
  replacement.ws.on("message", (data, binary) => { if (binary) received.push(Buffer.from(data as ArrayBuffer)); });
  old.send(frame(0, "stale"));
  const marker = new Promise<void>((resolve) => replacement.ws.once("message", () => resolve()));
  const current = client(url, "guest");
  await once(current.ws, "open");
  await marker;
  current.ws.send(frame(0, "legitimate"));
  await timeout(new Promise<void>((resolve) => replacement.ws.on("message", (data, binary) => { if (binary && Buffer.from(data as ArrayBuffer).toString("utf8").includes("legitimate")) resolve(); })));
  expect(received.filter((b) => b.subarray(4).toString() === "stale")).toHaveLength(0);
  expect(received.some((b) => b.subarray(4).toString() === "legitimate")).toBe(true);
  old.socket.destroy();
  current.ws.close(); replacement.ws.close();
});

it("R34-02: current guests broadcast and recreated room accepts reused peerId", async () => {
  const url = await relayUrl();
  const host = client(url, "host"); await once(host.ws, "open");
  const bothJoined = new Promise<void>((resolve) => { let n = 0; host.ws.on("message", () => { if (++n === 2) resolve(); }); });
  const first = client(url, "guest"), second = client(url, "guest");
  await Promise.all([once(first.ws, "open"), once(second.ws, "open")]);
  await bothJoined;
  const received = [first, second].map(({ ws }) => new Promise<Buffer>((resolve) => ws.once("message", (data, binary) => { if (binary) resolve(Buffer.from(data as ArrayBuffer)); })));
  host.ws.send(frame(0, "broadcast"));
  expect((await Promise.all(received)).map((b) => b.subarray(4).toString())).toEqual(["broadcast", "broadcast"]);
  first.ws.close(); second.ws.close(); host.ws.close(); await timeout(once(host.ws, "close"));
  const nextHost = client(url, "host"); await once(nextHost.ws, "open");
  const joined = new Promise<void>((resolve) => nextHost.ws.once("message", () => resolve()));
  const reused = client(url, "guest"); await once(reused.ws, "open");
  await joined;
  const routed = new Promise<Buffer>((resolve) => nextHost.ws.on("message", (data, binary) => { if (binary) resolve(Buffer.from(data as ArrayBuffer)); }));
  reused.ws.send(frame(0, "reused-peer"));
  expect((await timeout(routed)).readUInt32BE(0)).toBe(1);
  reused.ws.close(); nextHost.ws.close();
});
