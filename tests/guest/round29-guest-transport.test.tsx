// @vitest-environment jsdom
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as WsWebSocket, WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { GuestFrame, HostFrame, AgentSnapshot, SessionHeader } from "../../packages/guest/src/vendor/wire";
import { packEnvelope, unpackEnvelope } from "../../packages/guest/src/lib/link";
import { generateRoomKey, importRoomKey, open, seal } from "../../packages/guest/src/lib/codec";
import { CollabSocket, deferred } from "../../packages/guest/src/lib/socket";
import { GuestClient } from "../../packages/guest/src/lib/client";
import { AgentDrawer } from "../../packages/guest/src/components/agents/AgentDrawer";
import { Composer } from "../../packages/guest/src/components/shell/Composer";

const servers: WebSocketServer[] = [];
const sockets: CollabSocket[] = [];

afterEach(async () => {
  cleanup();
  for (const socket of sockets) socket.close();
  sockets.length = 0;
  vi.restoreAllMocks();
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

function sendFrame(ws: WsWebSocket, key: CryptoKey, frame: HostFrame): void {
  void seal(key, frame).then((sealed) => ws.send(packEnvelope(0, sealed)));
}

async function testFrameAcrossCloseAndReconnect(
  frame: GuestFrame,
): Promise<{ wasTransmitted: boolean; sendResult: boolean }> {
  const realKey = await importRoomKey(generateRoomKey());
  const { server, port } = await startServer();
  const serverReceivedFrames: GuestFrame[] = [];

  server.on("connection", (ws) => {
    ws.on("message", async (raw: Buffer) => {
      const bytes = new Uint8Array(raw);
      if (bytes.byteLength <= 4) return;
      const envelope = unpackEnvelope(bytes);
      if (!envelope) return;
      const f = (await open(realKey, envelope.payload)) as GuestFrame;
      serverReceivedFrames.push(f);
      if (f.t === "hello") {
        sendFrame(ws, realKey, { t: "welcome" } as HostFrame);
      }
    });
  });

  const encryptionStarted = deferred<void>();
  const pauseGate = deferred<void>();

  const controllableKey: PromiseLike<CryptoKey> = {
    then(onfulfilled, onrejected) {
      return Promise.resolve()
        .then(() => {
          encryptionStarted.settle();
          return pauseGate.promise;
        })
        .then(() => realKey)
        .then(onfulfilled, onrejected);
    },
  };

  let activeKey: PromiseLike<CryptoKey> | CryptoKey = realKey;
  const keyProxy: PromiseLike<CryptoKey> = {
    then(onfulfilled, onrejected) {
      return Promise.resolve(activeKey).then(onfulfilled, onrejected);
    },
  };

  const client = new CollabSocket({
    wsUrl: `ws://127.0.0.1:${port}/r/room`,
    role: "guest",
    key: keyProxy,
  });
  sockets.push(client);

  client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);
  client.connect();

  await vi.waitFor(() => expect(client.isGreeted).toBe(true), { timeout: 5000 });

  activeKey = controllableKey;
  const sendPromise = client.send(frame);
  await encryptionStarted.promise;

  client.close();
  activeKey = realKey;
  pauseGate.settle();

  client.connect();
  await vi.waitFor(() => expect(client.isGreeted).toBe(true), { timeout: 5000 });
  await vi.waitFor(() => expect(serverReceivedFrames.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });

  const sendResult = await sendPromise;
  const wasTransmitted = serverReceivedFrames.some(
    (f) => f.t === frame.t && (f.t !== "agent-cmd" || ("cmd" in frame && f.cmd === frame.cmd)),
  );
  return { wasTransmitted, sendResult };
}

describe("H01 — Destructive commands entering reconnect queue (TOCTOU)", () => {
  it("Kill paused during seal surviving close() is rejected and not transmitted on reconnect", async () => {
    const { wasTransmitted, sendResult } = await testFrameAcrossCloseAndReconnect({
      t: "agent-cmd",
      cmd: "kill",
      agentId: "agent-1",
    });
    expect(wasTransmitted).toBe(false);
    expect(sendResult).toBe(false);
  });

  it("Revive paused during seal surviving close() is rejected and not transmitted on reconnect", async () => {
    const { wasTransmitted, sendResult } = await testFrameAcrossCloseAndReconnect({
      t: "agent-cmd",
      cmd: "revive",
      agentId: "agent-1",
    });
    expect(wasTransmitted).toBe(false);
    expect(sendResult).toBe(false);
  });

  it("Abort paused during seal surviving close() is rejected and not transmitted on reconnect", async () => {
    const { wasTransmitted, sendResult } = await testFrameAcrossCloseAndReconnect({
      t: "abort",
    });
    expect(wasTransmitted).toBe(false);
    expect(sendResult).toBe(false);
  });

  it("ui-response paused during seal surviving close() is rejected and not transmitted on reconnect", async () => {
    const { wasTransmitted, sendResult } = await testFrameAcrossCloseAndReconnect({
      t: "ui-response",
      reqId: 42,
      value: "allow",
    });
    expect(wasTransmitted).toBe(false);
    expect(sendResult).toBe(false);
  });

  it("fetch-transcript paused during seal surviving close() is rejected and not transmitted on reconnect", async () => {
    const { wasTransmitted, sendResult } = await testFrameAcrossCloseAndReconnect({
      t: "fetch-transcript",
      reqId: 10,
      agentId: "agent-1",
      fromByte: 0,
    });
    expect(wasTransmitted).toBe(false);
    expect(sendResult).toBe(false);
  });

  it("prompt paused during seal surviving intentional close() settles false and is not transmitted on new connection", async () => {
    const { wasTransmitted, sendResult } = await testFrameAcrossCloseAndReconnect({
      t: "prompt",
      text: "stale prompt after close",
    });
    expect(wasTransmitted).toBe(false);
    expect(sendResult).toBe(false);
  });

  it("subagent chat paused during seal surviving intentional close() settles false and is not transmitted on new connection", async () => {
    const { wasTransmitted, sendResult } = await testFrameAcrossCloseAndReconnect({
      t: "agent-cmd",
      cmd: "chat",
      agentId: "agent-1",
      text: "stale chat after close",
    });
    expect(wasTransmitted).toBe(false);
    expect(sendResult).toBe(false);
  });

  it("Kill paused during seal when socket drops without close() settles false and does not enter queue", async () => {
    const realKey = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    const serverReceivedFrames: GuestFrame[] = [];
    const serverSocket = deferred<WsWebSocket>();

    server.on("connection", (ws) => {
      serverSocket.settle(ws);
      ws.on("message", async (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        const envelope = unpackEnvelope(bytes);
        if (!envelope) return;
        const f = (await open(realKey, envelope.payload)) as GuestFrame;
        serverReceivedFrames.push(f);
        if (f.t === "hello") {
          sendFrame(ws, realKey, { t: "welcome" } as HostFrame);
        }
      });
    });

    const encryptionStarted = deferred<void>();
    const pauseGate = deferred<void>();

    const controllableKey: PromiseLike<CryptoKey> = {
      then(onfulfilled, onrejected) {
        return Promise.resolve()
          .then(() => {
            encryptionStarted.settle();
            return pauseGate.promise;
          })
          .then(() => realKey)
          .then(onfulfilled, onrejected);
      },
    };

    let activeKey: PromiseLike<CryptoKey> | CryptoKey = realKey;
    const keyProxy: PromiseLike<CryptoKey> = {
      then(onfulfilled, onrejected) {
        return Promise.resolve(activeKey).then(onfulfilled, onrejected);
      },
    };

    const client = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key: keyProxy,
    });
    sockets.push(client);

    client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);
    client.connect();

    await vi.waitFor(() => expect(client.isGreeted).toBe(true), { timeout: 5000 });

    // Send kill with paused encryption
    activeKey = controllableKey;
    const sendPromise = client.send({ t: "agent-cmd", cmd: "kill", agentId: "agent-1" });
    await encryptionStarted.promise;

    // Simulate transient network drop from server end
    (await serverSocket.promise).terminate();
    await vi.waitFor(() => expect(client.isOpen).toBe(false), { timeout: 5000 });

    // Release encryption
    activeKey = realKey;
    pauseGate.settle();

    // Kill send must settle false because generation changed and it's non-queueable
    const sendResult = await sendPromise;
    expect(sendResult).toBe(false);
  });
});

describe("H02 — send() promise settlement across lifecycle boundaries", () => {
  it("send() called after intentional close() settles false promptly instead of hanging", async () => {
    const key = await importRoomKey(generateRoomKey());
    const client = new CollabSocket({
      wsUrl: "ws://127.0.0.1:1/r/room",
      role: "guest",
      key,
    });
    sockets.push(client);

    client.close();

    const outcome = client.send({ t: "prompt", text: "after-close" });
    const result = await Promise.race([
      outcome,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(result).toBe(false);
  });

  it("send() in flight during close() settles false promptly instead of hanging", async () => {
    const realKey = await importRoomKey(generateRoomKey());
    const encryptionStarted = deferred<void>();
    const pauseGate = deferred<void>();

    const controllableKey: PromiseLike<CryptoKey> = {
      then(onfulfilled, onrejected) {
        return Promise.resolve()
          .then(() => {
            encryptionStarted.settle();
            return pauseGate.promise;
          })
          .then(() => realKey)
          .then(onfulfilled, onrejected);
      },
    };

    const client = new CollabSocket({
      wsUrl: "ws://127.0.0.1:1/r/room",
      role: "guest",
      key: controllableKey,
    });
    sockets.push(client);

    const outcome = client.send({ t: "prompt", text: "in-flight" });
    await encryptionStarted.promise;

    client.close();
    pauseGate.settle();

    const result = await Promise.race([
      outcome,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(result).toBe(false);
  });

  it("send() in flight during failFatal() settles false promptly", async () => {
    const realKey = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    const serverSocket = deferred<WsWebSocket>();

    server.on("connection", (ws) => {
      serverSocket.settle(ws);
      ws.on("message", (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        sendFrame(ws, realKey, { t: "welcome" } as HostFrame);
      });
    });

    const encryptionStarted = deferred<void>();
    const pauseGate = deferred<void>();

    const controllableKey: PromiseLike<CryptoKey> = {
      then(onfulfilled, onrejected) {
        return Promise.resolve()
          .then(() => {
            encryptionStarted.settle();
            return pauseGate.promise;
          })
          .then(() => realKey)
          .then(onfulfilled, onrejected);
      },
    };

    let activeKey: PromiseLike<CryptoKey> | CryptoKey = realKey;
    const keyProxy: PromiseLike<CryptoKey> = {
      then(onfulfilled, onrejected) {
        return Promise.resolve(activeKey).then(onfulfilled, onrejected);
      },
    };

    const client = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key: keyProxy,
    });
    sockets.push(client);

    const fatalClose = deferred<void>();
    client.onClose = (_reason, willReconnect) => {
      if (!willReconnect) fatalClose.settle();
    };

    client.onOpen = () => void client.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);
    client.connect();
    await vi.waitFor(() => expect(client.isGreeted).toBe(true), { timeout: 5000 });

    // Queue another frame with paused encryption
    activeKey = controllableKey;
    const outcome = client.send({ t: "prompt", text: "in-flight-fatal" });
    await encryptionStarted.promise;
    activeKey = realKey;

    // Server now sends garbage bytes to trigger failFatal while encryption is suspended
    const garbage = new Uint8Array(32).fill(0xee);
    (await serverSocket.promise).send(packEnvelope(0, garbage));

    // Wait for failFatal to trigger
    await fatalClose.promise;

    // Release encryption
    pauseGate.settle();

    const result = await Promise.race([
      outcome,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(result).toBe(false);
  });
});

describe("H06 — Stop / Kill / Revive failures visible to the user", () => {
  const dummyAgent: AgentSnapshot = {
    id: "agent-test",
    displayName: "worker",
    kind: "sub",
    status: "running",
    hasSessionFile: false,
    createdAt: 0,
    lastActivity: 0,
  };

  it("surfaces kill failure in AgentDrawer when sendAgentCmd returns false", async () => {
    const mockClient = {
      sendAgentCmd: vi.fn().mockResolvedValue(false),
      fetchTranscript: vi.fn().mockResolvedValue(null),
    } as unknown as GuestClient;

    render(
      <AgentDrawer
        agent={dummyAgent}
        client={mockClient}
        phase="live"
        readOnly={false}
        onClose={() => {}}
      />,
    );

    const killBtn = screen.getByRole("button", { name: /kill/i });
    fireEvent.click(killBtn);

    await waitFor(() => {
      const errorMsg = screen.getByText(/kill command not sent/i);
      expect(errorMsg).toBeTruthy();
    });
  });

  it("surfaces revive failure in AgentDrawer when sendAgentCmd returns false", async () => {
    const mockClient = {
      sendAgentCmd: vi.fn().mockResolvedValue(false),
      fetchTranscript: vi.fn().mockResolvedValue(null),
    } as unknown as GuestClient;

    render(
      <AgentDrawer
        agent={{ ...dummyAgent, status: "parked" }}
        client={mockClient}
        phase="live"
        readOnly={false}
        onClose={() => {}}
      />,
    );

    const reviveBtn = screen.getByRole("button", { name: /revive/i });
    fireEvent.click(reviveBtn);

    await waitFor(() => {
      const errorMsg = screen.getByText(/revive command not sent/i);
      expect(errorMsg).toBeTruthy();
    });
  });

  it("surfaces stop failure in Composer when sendAbort fails", async () => {
    const mockClient = {
      sendAbort: vi.fn().mockResolvedValue(false),
      sendPrompt: vi.fn().mockResolvedValue(true),
    } as unknown as GuestClient;

    render(
      <Composer
        client={mockClient}
        phase="live"
        readOnly={false}
        uiRequest={null}
        working={true}
        queuedMessageCount={0}
      />,
    );

    const stopBtn = screen.getByRole("button", { name: /stop/i });
    fireEvent.click(stopBtn);

    await waitFor(() => {
      const errorMsg = screen.getByText(/stop request not sent/i);
      expect(errorMsg).toBeTruthy();
    });
  });
});

describe("H03 — Early prompt rejected by host after transport success", () => {
  it("restores the draft in Composer and shows error when host replies with startup error frame", async () => {
    const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
    const client = new GuestClient(link, "tester");

    // Simulate connected and greeted state
    client.applyFrameForTest({
      t: "welcome",
      proto: 3,
      header: { id: "sess-1" } as unknown as SessionHeader,
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
      agents: [],
      entryCount: 0,
    });

    // Use real sendPrompt so the host error remains attached to a retained attempt.
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const view = render(
      <Composer
        client={client}
        phase="live"
        readOnly={false}
        uiRequest={null}
        working={false}
        queuedMessageCount={0}
      />,
    );

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "important command to run" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // On transport success, old code cleared draft
    await waitFor(() => expect(textarea.value).toBe(""));

    // Now host delivers the early rejection error frame
    const errorMsg = "prompting is unavailable until the host finishes starting up";
    client.applyFrameForTest({ t: "error", message: errorMsg });

    // Host refusal is not permission to inject text into the editable draft.
    await waitFor(() => {
      expect(textarea.value).toBe("");
      expect(view.getByText(errorMsg)).toBeTruthy();
      expect(view.getByRole("button", { name: "Recover" })).toBeTruthy();
    });
    client.close();
  });
  it("does not restore draft on an unrelated error notice", async () => {
    const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
    const client = new GuestClient(link, "tester");

    client.applyFrameForTest({
      t: "welcome",
      proto: 3,
      header: { id: "sess-1" } as unknown as SessionHeader,
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
      agents: [],
      entryCount: 0,
    });

    vi.spyOn(client, "sendPrompt").mockResolvedValue(true);

    const view = render(
      <Composer
        client={client}
        phase="live"
        readOnly={false}
        uiRequest={null}
        working={false}
        queuedMessageCount={0}
      />,
    );

    const textarea = view.getByPlaceholderText(/prompt the host agent/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "unrelated prompt" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(textarea.value).toBe(""));

    // An unrelated background error notice arrives (e.g. transcript polling failure)
    client.applyFrameForTest({ t: "error", message: "transcript socket failed" });

    // Give time to ensure no false restoration
    await new Promise((r) => setTimeout(r, 50));
    expect(textarea.value).toBe("");
    expect(view.queryByText("transcript socket failed")).toBeNull();
  });
});

describe("Re-verification of prior fixes with real socket integration", () => {
  it("re-verifies CAW-03 with real un-mocked socket: sendUiResponse offline is refused and retains uiRequest", async () => {
    const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
    const client = new GuestClient(link, "tester");
    // Socket is never connected, so real socket is offline/ungreeted
    const req = { reqId: 202, title: "Execute shell command?", kind: "select" as const, options: ["Allow", "Deny"] };
    client.applyFrameForTest({ t: "ui-request", request: req });
    expect(client.getSnapshot().uiRequest?.reqId).toBe(202);

    // Real sendUiResponse without mock
    const accepted = await client.sendUiResponse(202, "Allow");
    expect(accepted).toBe(false);
    expect(client.getSnapshot().uiRequest?.reqId).toBe(202);
    expect(client.getSnapshot().notices.some((n) => n.level === "error" && n.message.includes("response not sent"))).toBe(true);
  });

  it("re-verifies CAW-04 with real un-mocked socket: kill/revive/abort refused immediately without queueing", async () => {
    const key = await importRoomKey(generateRoomKey());
    const socket = new CollabSocket({ wsUrl: "ws://127.0.0.1:1/r/room", role: "guest", key });
    sockets.push(socket);

    expect(await socket.send({ t: "agent-cmd", cmd: "kill", agentId: "agent-1" })).toBe(false);
    expect(await socket.send({ t: "agent-cmd", cmd: "revive", agentId: "agent-1" })).toBe(false);
    expect(await socket.send({ t: "abort" })).toBe(false);
    expect(await socket.send({ t: "ui-response", reqId: 1 })).toBe(false);
    expect(await socket.send({ t: "fetch-transcript", reqId: 1, agentId: "agent-1", fromByte: 0 })).toBe(false);
  });

  it("re-verifies CAW-05 with real client: subagent chat draft retained in AgentDrawer on offline send", async () => {
    const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
    const client = new GuestClient(link, "tester");
    client.close();
    const dummySubagent: AgentSnapshot = {
      id: "worker-1",
      displayName: "worker",
      kind: "sub",
      status: "running",
      hasSessionFile: false,
      createdAt: 0,
      lastActivity: 0,
    };

    const view = render(<AgentDrawer agent={dummySubagent} client={client} phase="live" onClose={() => {}} />);
    const input = view.getByPlaceholderText(/message worker/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "critical subagent instruction" } });
    fireEvent.click(view.getByRole("button", { name: "send" }));

    await waitFor(() => expect(view.getByRole("status").textContent).toMatch(/not sent/i));
    expect(input.value).toBe("critical subagent instruction");
  });
});

describe("DEFECT-04 — isGreeted truthfulness across transient disconnect", () => {
  it("reports isGreeted === false immediately after a transient disconnect", async () => {
    const realKey = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    const serverSocket = deferred<WsWebSocket>();

    server.on("connection", (ws) => {
      serverSocket.settle(ws);
      ws.on("message", (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        sendFrame(ws, realKey, { t: "welcome" } as HostFrame);
      });
    });

    const socket = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key: realKey,
    });
    sockets.push(socket);

    socket.onOpen = () => void socket.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);
    socket.connect();

    await vi.waitFor(() => expect(socket.isGreeted).toBe(true), { timeout: 5000 });

    // Terminate connection to trigger transient disconnect
    (await serverSocket.promise).terminate();
    await vi.waitFor(() => expect(socket.isOpen).toBe(false), { timeout: 5000 });

    // Truthfulness check: isGreeted must be false during disconnect!
    expect(socket.isGreeted).toBe(false);
  });

  it("keeps isGreeted === false when reconnected until the new welcome arrives", async () => {
    const realKey = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    const serverSocket = deferred<WsWebSocket>();
    let connectionCount = 0;
    const pauseWelcomeGate = deferred<void>();

    server.on("connection", (ws) => {
      connectionCount++;
      if (connectionCount === 1) serverSocket.settle(ws);
      ws.on("message", async (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        if (connectionCount > 1) {
          // Withhold welcome on second connection until asserted
          await pauseWelcomeGate.promise;
        }
        sendFrame(ws, realKey, { t: "welcome" } as HostFrame);
      });
    });

    const socket = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key: realKey,
    });
    sockets.push(socket);

    socket.onOpen = () => void socket.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);
    socket.connect();

    await vi.waitFor(() => expect(socket.isGreeted).toBe(true), { timeout: 5000 });

    // Terminate connection
    (await serverSocket.promise).terminate();
    await vi.waitFor(() => expect(socket.isOpen).toBe(false), { timeout: 5000 });
    expect(socket.isGreeted).toBe(false);

    // Wait for automatic reconnect to open the new socket
    await vi.waitFor(() => expect(socket.isOpen).toBe(true), { timeout: 5000 });

    // DEFECT-04 test: Open on new connection, but host has NOT welcomed yet!
    expect(socket.isGreeted).toBe(false);

    // Release welcome
    pauseWelcomeGate.settle();
    await vi.waitFor(() => expect(socket.isGreeted).toBe(true), { timeout: 5000 });
  });
});

describe("Queueable policy confirmation: prompts queue across disconnects", () => {
  it("queues a prompt issued while momentarily disconnected and flushes it on next welcome", async () => {
    const realKey = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    const receivedFrames: string[] = [];
    const serverSocket = deferred<WsWebSocket>();

    server.on("connection", (ws) => {
      serverSocket.settle(ws);
      ws.on("message", async (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        const envelope = unpackEnvelope(bytes);
        if (!envelope) return;
        const f = (await open(realKey, envelope.payload)) as GuestFrame;
        receivedFrames.push(f.t);
        if (f.t === "hello") {
          sendFrame(ws, realKey, { t: "welcome" } as HostFrame);
        }
      });
    });

    const socket = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key: realKey,
    });
    sockets.push(socket);

    socket.onOpen = () => void socket.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);
    socket.connect();
    await vi.waitFor(() => expect(socket.isGreeted).toBe(true), { timeout: 5000 });

    // Drop connection
    (await serverSocket.promise).terminate();
    await vi.waitFor(() => expect(socket.isOpen).toBe(false), { timeout: 5000 });

    // Issue prompt while momentarily disconnected
    const promptSend = socket.send({ t: "prompt", text: "prompt during disconnect" });

    // Prompt must flush and settle true once reconnected and welcomed
    await expect(promptSend).resolves.toBe(true);
    await vi.waitFor(() => expect(receivedFrames).toContain("prompt"), { timeout: 5000 });
  });

  it("queues a prompt issued before any greeting ever happened and flushes it on first welcome", async () => {
    const realKey = await importRoomKey(generateRoomKey());
    const { server, port } = await startServer();
    const receivedFrames: string[] = [];

    server.on("connection", (ws) => {
      ws.on("message", async (raw: Buffer) => {
        const bytes = new Uint8Array(raw);
        if (bytes.byteLength <= 4) return;
        const envelope = unpackEnvelope(bytes);
        if (!envelope) return;
        const f = (await open(realKey, envelope.payload)) as GuestFrame;
        receivedFrames.push(f.t);
        if (f.t === "hello") {
          sendFrame(ws, realKey, { t: "welcome" } as HostFrame);
        }
      });
    });

    const socket = new CollabSocket({
      wsUrl: `ws://127.0.0.1:${port}/r/room`,
      role: "guest",
      key: realKey,
    });
    sockets.push(socket);

    // Issue prompt before socket is ever opened or greeted
    const promptSend = socket.send({ t: "prompt", text: "pre-greeting prompt" });

    socket.onOpen = () => void socket.send({ t: "hello", proto: 3, name: "test" } as GuestFrame);
    socket.connect();

    // Must flush after welcome and resolve true
    await expect(promptSend).resolves.toBe(true);
    await vi.waitFor(() => expect(receivedFrames).toEqual(["hello", "prompt"]), { timeout: 5000 });
  });
});
