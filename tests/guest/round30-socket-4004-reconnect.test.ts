import { afterEach, expect, it, vi } from "vitest";
import { CollabSocket } from "../../packages/guest/src/lib/socket";

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static sockets: FakeWebSocket[] = [];
	readyState = FakeWebSocket.CONNECTING;
	binaryType = "";
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) { FakeWebSocket.sockets.push(this); }
	open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
	serverClose(code: number): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code, reason: "" } as CloseEvent);
	}
	close(): void { this.readyState = FakeWebSocket.CLOSED; }
	send(): void {}
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	FakeWebSocket.sockets = [];
});

it("retries 4004 after 4001 until room returns", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const closeEvents: boolean[] = [];
	const socket = new CollabSocket({ wsUrl: "ws://127.0.0.1/r/fixture", role: "guest", key: {} as CryptoKey });
	socket.onClose = (_reason, willReconnect) => closeEvents.push(willReconnect);
	try {
		socket.connect();
		FakeWebSocket.sockets[0]!.open();
		FakeWebSocket.sockets[0]!.serverClose(4001);
		await vi.advanceTimersByTimeAsync(40_000);
		FakeWebSocket.sockets[1]!.open();
		FakeWebSocket.sockets[1]!.serverClose(4004);
		await vi.advanceTimersByTimeAsync(40_000);
		expect(FakeWebSocket.sockets).toHaveLength(3);
		expect(closeEvents).toEqual([true, true]);
	} finally {
		socket.close();
	}
});
