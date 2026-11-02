// @vitest-environment jsdom
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { HostFrame } from "../../packages/guest/src/vendor/wire";
import { packEnvelope } from "../../packages/guest/src/lib/link";
import { generateRoomKey, importRoomKey, seal } from "../../packages/guest/src/lib/codec";
import { CollabSocket } from "../../packages/guest/src/lib/socket";


class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instance: FakeWebSocket;
	readyState = FakeWebSocket.CONNECTING;
	binaryType = "";
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	send = vi.fn();
	close = vi.fn();
	constructor(_url: string) { FakeWebSocket.instance = this; }
	open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
	receive(data: ArrayBuffer): void { this.onmessage?.({ data } as MessageEvent); }
}

afterEach(() => vi.unstubAllGlobals());
describe("R32-09 CollabSocket welcome gate", () => {
	it("does not dispatch prompts before welcome; hello and welcomed prompt reach wire", async () => {
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const key = await importRoomKey(generateRoomKey());
		const socket = new CollabSocket({ wsUrl: "ws://fake/r/room", role: "guest", key });
		socket.connect();
		const ws = FakeWebSocket.instance;
		ws.open();
		await expect(socket.send({ t: "hello", proto: 3, name: "test" })).resolves.toBe(true);
		expect(ws.send).toHaveBeenCalledTimes(1);
		const attempts = await Promise.all(Array.from({ length: 300 }, () => socket.send({ t: "prompt", text: "x" })));
		expect(attempts).toEqual(Array(300).fill(false));
		expect(ws.send).toHaveBeenCalledTimes(1);
		const welcome = await seal(key, { t: "welcome" } as HostFrame);
		ws.receive(packEnvelope(0, welcome).buffer as ArrayBuffer);
		await vi.waitFor(() => expect(socket.isGreeted).toBe(true));
		await expect(socket.send({ t: "prompt", text: "x" })).resolves.toBe(true);
		expect(ws.send).toHaveBeenCalledTimes(2);
		socket.close();
	});
});
const servers: WebSocketServer[] = [];
const sockets: CollabSocket[] = [];
afterEach(async () => {
	for (const socket of sockets) socket.close();
	sockets.length = 0;
	await Promise.all(servers.splice(0).map(async server => {
		for (const client of server.clients) client.terminate();
		server.close();
		await once(server, "close");
	}));
});
async function startServer(): Promise<{ server: WebSocketServer; port: number }> {
	const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	servers.push(server);
	return { server, port: address.port };
}
function sendFrame(ws: WsWebSocket, key: CryptoKey, frame: HostFrame): void {
	void seal(key, frame).then(sealed => ws.send(packEnvelope(0, sealed)));
}
describe("R32-09 pre-welcome refusal", () => {
	it("refuses prompts before welcome and sends nothing", async () => {
		const key = await importRoomKey(generateRoomKey());
		const { server, port } = await startServer();
		const gotHello = new Promise<void>(resolve => server.once("connection", ws => ws.once("message", () => resolve())));
		const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
		sockets.push(client);
		client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" });
		client.connect();
		await gotHello;
		await expect(client.send({ t: "prompt", text: "keep draft" })).resolves.toBe(false);
	});
	it("sends prompt after welcome acknowledgement", async () => {
		const key = await importRoomKey(generateRoomKey());
		const { server, port } = await startServer();
		server.on("connection", ws => ws.once("message", () => sendFrame(ws, key, { t: "welcome" } as HostFrame)));
		const client = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
		sockets.push(client);
		client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" });
		client.connect();
		await new Promise<void>(resolve => { client.onFrame = frame => { if (frame.t === "welcome") resolve(); }; });
		await expect(client.send({ t: "prompt", text: "after welcome" })).resolves.toBe(true);
	});
});
