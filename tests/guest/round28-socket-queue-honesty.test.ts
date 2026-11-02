// @vitest-environment jsdom
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { HostFrame } from "../../packages/guest/src/vendor/wire";
import { packEnvelope } from "../../packages/guest/src/lib/link";
import { generateRoomKey, importRoomKey, seal } from "../../packages/guest/src/lib/codec";
import { CollabSocket } from "../../packages/guest/src/lib/socket";
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
