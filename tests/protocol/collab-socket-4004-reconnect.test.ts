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

it("retries 4004 after 4001 like upstream relay-client.ts:753-760", async () => {
  vi.useFakeTimers();
  const closes: boolean[] = [];
  const client = new CollabSocket({ wsUrl: "ws://127.0.0.1/r/fixture", role: "guest", key: {} as CryptoKey, WebSocketClass: FakeWebSocket as unknown as typeof WebSocket });
  client.onClose = (_reason, willReconnect) => closes.push(willReconnect);
  try {
    client.connect();
    FakeWebSocket.sockets[0]!.open();
    FakeWebSocket.sockets[0]!.serverClose(4001);
    await vi.advanceTimersByTimeAsync(40_000);
    FakeWebSocket.sockets[1]!.open();
    FakeWebSocket.sockets[1]!.serverClose(4004);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeWebSocket.sockets).toHaveLength(3);
    expect(closes).toEqual([true, true]);
  } finally {
    client.close();
  }
});
