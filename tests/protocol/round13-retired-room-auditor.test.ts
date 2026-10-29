import { afterEach, expect, it, vi } from "vitest";
import { CollabSocket } from "../../packages/collab-protocol/src/socket.js";

class FakeWebSocket {
  static sockets: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeWebSocket.sockets.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  serverClose(code: number) { this.readyState = 3; this.onclose?.({ code, reason: "" } as CloseEvent); }
  close() { this.readyState = 3; }
  send() {}
}

afterEach(() => { vi.useRealTimers(); FakeWebSocket.sockets = []; });

it("stops retrying after room-closed followed by no-such-room", async () => {
  vi.useFakeTimers();
  const closes: Array<{ reason: string; willReconnect: boolean; roomRetired?: boolean }> = [];
  const client = new CollabSocket({ wsUrl: "ws://127.0.0.1/r/retired-fixture", role: "guest", key: {} as CryptoKey, WebSocketClass: FakeWebSocket as unknown as typeof WebSocket });
  client.onClose = (reason, willReconnect, roomRetired) => closes.push({ reason, willReconnect, roomRetired });
  try {
    client.connect();
    FakeWebSocket.sockets[0]!.open();
    FakeWebSocket.sockets[0]!.serverClose(4001);
    await vi.advanceTimersByTimeAsync(40_000);
    FakeWebSocket.sockets[1]!.open();
    FakeWebSocket.sockets[1]!.serverClose(4004);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeWebSocket.sockets).toHaveLength(2);
    expect(closes.map(({ willReconnect, roomRetired }) => ({ willReconnect, roomRetired }))).toEqual([
      { willReconnect: true, roomRetired: undefined },
      { willReconnect: false, roomRetired: true },
    ]);
    expect(new Set(FakeWebSocket.sockets.map((socket) => socket.url)).size).toBe(1);
  } finally {
    client.close();
  }
});
