// @vitest-environment jsdom
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { CollabUiRequest, HostFrame, SessionEntry } from "../../packages/guest/src/vendor/wire";
import type { AgentSnapshot } from "../../packages/guest/src/vendor/wire";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentDrawer } from "../../packages/guest/src/components/agents/AgentDrawer";
import { GuestClient } from "../../packages/guest/src/lib/client";
import { generateRoomKey, importRoomKey } from "../../packages/guest/src/lib/codec";
import { CollabSocket } from "../../packages/guest/src/lib/socket";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);

describe("CAW-06 welcome timeout lifecycle", () => {
  it("ends when first socket never opens", () => {
    vi.useFakeTimers();
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(() => {});
    const client = new GuestClient(link, "tester");
    client.connect();
    vi.advanceTimersByTime(30_001);
    expect(client.getSnapshot().phase).toBe("ended");
    expect(client.getSnapshot().endedReason).toMatch(/welcome/i);
  });

  it("bounds each reconnect handshake and cancels a stale timeout after a later welcome", () => {
    vi.useFakeTimers();
    let client: GuestClient;
    let connects = 0;
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
      connects += 1;
      this.onOpen?.();
      if (connects === 3) {
        this.onFrame?.({
          t: "welcome", proto: 3, header: {},
          state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
          agents: [], entryCount: 0,
        }, 0);
      }
    });
	vi.spyOn(CollabSocket.prototype, "close").mockImplementation(function (this: CollabSocket) {
		this.onClose?.("network drop", true);
	});
    client = new GuestClient(link, "tester");
    client.connect();
    vi.advanceTimersByTime(29_000);
    client.close();
    client.connect();
    vi.advanceTimersByTime(29_000);
    client.close();
    client.connect();
    expect(client.getSnapshot().phase).toBe("live");
    vi.advanceTimersByTime(60_000);
    expect(client.getSnapshot().phase).toBe("live");
  });

  it("ends when a reconnect opens but host never greets", () => {
    vi.useFakeTimers();
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { this.onOpen?.(); });
    vi.spyOn(CollabSocket.prototype, "close").mockImplementation(function (this: CollabSocket) { this.onClose?.("network drop", true); });
    const client = new GuestClient(link, "tester");
    client.connect();
    client.applyFrameForTest({
      t: "welcome", proto: 3, header: {},
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] },
      agents: [], entryCount: 0,
    } as unknown as HostFrame);
    client.close();
    client.connect();
    vi.advanceTimersByTime(30_001);
    expect(client.getSnapshot().phase).toBe("ended");
    expect(client.getSnapshot().endedReason).toMatch(/welcome/i);
  });
});


const agent: AgentSnapshot = {
  id: "agent-1", displayName: "worker", kind: "sub", status: "running",
  hasSessionFile: false, createdAt: 0, lastActivity: 0,
};

describe("CAW-04 lifecycle controls are live-only", () => {
  it("hides kill while reconnecting and shows it live", () => {
    const client = { sendAgentCmd: async () => false } as unknown as GuestClient;
    const props = { agent, client, onClose: () => {} };
    const view = render(<AgentDrawer {...props} phase="reconnecting" />);
    expect(screen.queryByRole("button", { name: /kill/i })).toBeNull();
    view.rerender(<AgentDrawer {...props} phase="live" />);
    expect(screen.getByRole("button", { name: /kill/i })).toBeTruthy();
  });
});

/** `"pending"` when the promise has not settled inside `ms` — a bounded, fast probe. */
function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([
    promise,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

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

describe("CAW-04 socket refuses stale lifecycle frames", () => {
  it("refuses kill/revive/abort on an open-but-ungreeted link while prompt still queues", async () => {
    // A live socket that never receives `welcome` is exactly the window the
    // defect buffers stale destructive frames into.
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const key = await importRoomKey(generateRoomKey());

    const socket = new CollabSocket({ wsUrl: `ws://127.0.0.1:${port}/r/room`, role: "guest", key });
    sockets.push(socket);
    const connected = once(server, "connection");
    socket.connect();
    await connected;
    await vi.waitFor(() => expect(socket.isOpen).toBe(true), { timeout: 5000 });
    expect(socket.isGreeted).toBe(false);

    expect(await settlesWithin(socket.send({ t: "agent-cmd", cmd: "kill", agentId: "agent-1" }), 500)).toBe(false);
    expect(await settlesWithin(socket.send({ t: "agent-cmd", cmd: "revive", agentId: "agent-1" }), 500)).toBe(false);
    expect(await settlesWithin(socket.send({ t: "abort" }), 500)).toBe(false);

    // The prompt is the one frame that must still be held for the next welcome.
    expect(await settlesWithin(socket.send({ t: "prompt", text: "queued" }), 500)).toBe("pending");
  });
});

describe("CAW-05 chat draft refusal", () => {
  it("retains draft and displays refusal", async () => {
    const client = { sendAgentCmd: async () => false } as unknown as GuestClient;
    const view = render(<AgentDrawer agent={agent} client={client} phase="live" onClose={() => {}} />);
    const input = view.getByPlaceholderText(/message worker/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "preserve this" } });
    fireEvent.click(view.getByRole("button", { name: "send" }));
    await waitFor(() => expect(view.getByRole("status").textContent).toMatch(/not sent/i));
    expect(input.value).toBe("preserve this");
  });
});

describe("CAW-13 transcript cursor rewind", () => {
  /** One `message` row the compact transcript renders as visible text. */
  function row(id: string, text: string): SessionEntry {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: text, timestamp: 0 },
    } as SessionEntry;
  }

  it("drops the previous generation's rows when the host cursor rewinds", async () => {
    // Generation 1: cursor advances to 400. Generation 2: the file was truncated,
    // so the host answers with a SMALLER cursor (200) and rows from a new run.
    let calls = 0;
    const client = {
      fetchTranscript: async () => {
        calls += 1;
        if (calls === 1) return { kind: "rows" as const, text: `${JSON.stringify(row("gen1", "generation-one-row"))}\n`, newSize: 400 };
        if (calls === 2) return { kind: "rows" as const, text: `${JSON.stringify(row("gen2", "generation-two-row"))}\n`, newSize: 200 };
        return { kind: "rows" as const, text: "", newSize: 200 };
      },
      sendAgentCmd: async () => true,
    } as unknown as GuestClient;

    const view = render(
      <AgentDrawer agent={{ ...agent, status: "running", hasSessionFile: true }} client={client} phase="live" onClose={() => {}} />,
    );

    // Wait for the rewound reply to be applied, then let any later idle polls settle.
    await waitFor(() => expect(view.getByText("generation-two-row")).toBeTruthy(), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(view.queryByText("generation-one-row")).toBeNull();
    expect(view.getByText("generation-two-row")).toBeTruthy();
  });
});

describe("CAW-18 ended transcript polling", () => {
  it("resolves transcript fetch promptly once client ended", async () => {
    const client = new GuestClient(link, "tester");
    client.close();
	client.applyFrameForTest({ t: "bye", reason: "ended" });
    await expect(client.fetchTranscript("agent-1", 0)).resolves.toBeNull();
  });
});
describe("CAW-12 WebSocket constructor failure", () => {
  it("keeps connect screen usable, shows error, and retries", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const { App } = await import("../../packages/guest/src/app");
    const original = globalThis.WebSocket;
    let attempts = 0;
    globalThis.WebSocket = function (this: unknown) {
      attempts += 1;
      throw new Error("WebSocket constructor refused URL");
    } as unknown as typeof WebSocket;
    window.history.replaceState(null, "", `/#${link}`);
    const view = render(<App />);
    expect(await screen.findByText(/WebSocket constructor refused URL/i)).toBeTruthy();
    const joinLink = view.getByPlaceholderText("ws://host:port/r/room.key");
    fireEvent.change(joinLink, { target: { value: link } });
    fireEvent.click(view.getByRole("button", { name: /connect/i }));
    await waitFor(() => expect(attempts).toBeGreaterThan(1));
    expect(view.getByPlaceholderText("ws://host:port/r/room.key")).toBeTruthy();
    view.unmount();
    globalThis.WebSocket = original;
    window.history.replaceState(null, "", "/");
  });
});

describe("CAW-18 rejected transcript poll", () => {
  it("surfaces rejected fetch in drawer instead of leaking it", async () => {
    const client = { fetchTranscript: () => Promise.reject(new Error("transcript socket failed")) } as unknown as GuestClient;
    render(<AgentDrawer agent={{ ...agent, hasSessionFile: true }} client={client} phase="live" onClose={() => {}} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("transcript socket failed");
  });
});
describe("CAW-03 sendUiResponse refusal handling", () => {
  it("keeps uiRequest visible and surfaces error notice when sendUiResponse is refused", async () => {
    const client = new GuestClient(link, "tester");
    const req: CollabUiRequest = { reqId: 101, title: "Approve bash execution?", kind: "select", options: ["Allow", "Deny"] };
    client.applyFrameForTest({ t: "ui-request", request: req });
    expect(client.getSnapshot().uiRequest?.reqId).toBe(101);
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(false);
    const accepted = await client.sendUiResponse(101, "Allow");
    expect(accepted).toBe(false);
    expect(client.getSnapshot().uiRequest?.reqId).toBe(101);
    expect(client.getSnapshot().notices.some((n) => n.level === "error" && n.message.includes("response not sent"))).toBe(true);
  });
});
