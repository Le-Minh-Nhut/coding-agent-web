// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SessionHeader } from "@oh-my-pi/pi-wire";
import { Composer } from "../../packages/guest/src/components/shell/Composer";
import { CollabSocket } from "../../packages/guest/src/lib/socket";
import { GuestClient, PromptRecoveryStore } from "../../packages/guest/src/lib/client";
import { generateRoomKey, importRoomKey, seal } from "../../packages/guest/src/lib/codec";
import { packEnvelope } from "../../packages/guest/src/lib/link";

const sealGate = vi.hoisted(() => ({ promptBarrier: null as null | Promise<void>, release: null as null | (() => void) }));
vi.mock("../../packages/guest/src/lib/codec", async importOriginal => {
  const actual = await importOriginal<typeof import("../../packages/guest/src/lib/codec")>();
  return { ...actual, seal: async (key: CryptoKey, frame: never) => {
    if ("t" in frame && frame.t === "prompt" && sealGate.promptBarrier) await sealGate.promptBarrier;
    return actual.seal(key, frame);
  } };
});

const A = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
const B = "wss://example.com/r/CCCCCCCCCCCCCCCC." + "D".repeat(43);
const welcome = (c: GuestClient, id = "s") => c.applyFrameForTest({ t: "welcome", proto: 3, header: { id } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 });
const entry = (text: string) => ({ t: "entry" as const, entry: { type: "message" as const, id: "e", parentId: null, timestamp: new Date().toISOString(), message: { role: "user" as const, content: text, timestamp: Date.now() } } });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function ComposerHarness({ client, phase = "live" }: { client: GuestClient; phase?: "live" | "ended" }) {
  const [draft, setDraft] = useState("");
  return <Composer client={client} phase={phase} readOnly={false} uiRequest={null} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} />;
}

describe("R35 GUEST findings", () => {
  it("R33 send begun on S1 cannot cross reconnect; close fences late seal; healthy send writes once", async () => {
    class FakeWebSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      static all: FakeWebSocket[] = [];
      readyState = 0; binaryType = ""; onopen: (() => void) | null = null; onmessage: ((e: MessageEvent) => void) | null = null; onclose: ((e: CloseEvent) => void) | null = null; onerror: (() => void) | null = null;
      send = vi.fn(); close = vi.fn(() => { this.readyState = 3; this.onclose?.({ code: 1000, reason: "" } as CloseEvent); });
      constructor() { FakeWebSocket.all.push(this); }
      open() { this.readyState = 1; this.onopen?.(); }
      drop() { this.readyState = 3; this.onclose?.({ code: 1006, reason: "lost" } as CloseEvent); }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.useFakeTimers();
    const key = await importRoomKey(generateRoomKey());
    const sockets: CollabSocket[] = [];
    let target!: CollabSocket;
    const make = () => {
      const socket = new CollabSocket({ wsUrl: "ws://fake/r/x", role: "guest", key });
      sockets.push(socket);
      socket.onOpen = () => { void socket.send({ t: "hello", proto: 3, name: "x" }); };
      socket.connect(); FakeWebSocket.all.at(-1)!.open();
      return socket;
    };
    const acknowledge = async (socket: CollabSocket, ws: FakeWebSocket) => {
      const welcomed = new Promise<void>(resolve => { socket.onFrame = frame => { if (frame.t === "welcome") resolve(); }; });
      ws.onmessage?.({ data: packEnvelope(0, await seal(key, { t: "welcome" } as never)).buffer } as MessageEvent);
      await welcomed;
      expect(socket.isGreeted).toBe(true);
    };
    const first = make(); target = first; const s1 = FakeWebSocket.all[0];
    await acknowledge(first, s1);
    let release!: () => void;
    sealGate.promptBarrier = new Promise<void>(resolve => { release = resolve; });
    const pending = first.send({ t: "prompt", text: "keep draft" });
    await Promise.resolve(); await Promise.resolve();
    s1.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    const s2 = FakeWebSocket.all[1]; s2.open();
    release(); sealGate.promptBarrier = null;
    await expect(pending).resolves.toBe(false);
    expect(s2.send).not.toHaveBeenCalled();
    expect(await first.send({ t: "prompt", text: "keep draft" })).toBe(false);
    expect(s2.send).not.toHaveBeenCalled();
    first.close();

    const closed = make(); target = closed; const closeSocket = FakeWebSocket.all[2];
    await acknowledge(closed, closeSocket);
    sealGate.promptBarrier = new Promise<void>(resolve => { release = resolve; });
    const closePending = closed.send({ t: "prompt", text: "closed draft" });
    await Promise.resolve(); await Promise.resolve();
    closed.close(); release(); sealGate.promptBarrier = null;
    await expect(closePending).resolves.toBe(false);
    expect(closeSocket.send).toHaveBeenCalledTimes(1);

    const healthySocket = make(); target = healthySocket; const healthy = FakeWebSocket.all[3];
    await acknowledge(healthySocket, healthy);
    await expect(healthySocket.send({ t: "prompt", text: "once" })).resolves.toBe(true);
    expect(healthy.send).toHaveBeenCalledTimes(2);
    sockets.forEach(socket => socket.close());
  });

  it("R34 explicit Recover of foreign-room record is room-fenced", () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const a = new GuestClient(A, "a", store); welcome(a);
    const record = a.recordPrompt("foreign text");
    const b = new GuestClient(B, "b", store); welcome(b);
    render(<ComposerHarness client={b} />);
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("foreign text");
    expect(store.records.get(record.id)?.status).toBe("recovered");
    act(() => b.applyFrameForTest(entry("foreign text")));
    expect(store.records.get(record.id)?.status).toBe("recovered");
    a.close(); b.close();
  });

  it("R34 overlay-recovered record is removed after rejoin main-composer successful send", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const old = new GuestClient(A, "a", store); welcome(old);
    const record = old.recordPrompt("line one\n" + "x".repeat(1100) + "\nline three");
    const overlay = render(<ComposerHarness client={old} phase="ended" />);
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    const restored = (screen.getByRole("textbox") as HTMLTextAreaElement).value;
    expect(restored).toBe(record.text);
    overlay.unmount();
    const current = new GuestClient(A, "a", store); welcome(current);
    const main = render(<ComposerHarness client={current} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: restored } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(store.records.has(record.id)).toBe(false);
    main.unmount(); old.close(); current.close();
  });

  it("R34 failed send and unrelated prompt preserve recovered text", async () => {
    const send = vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const client = new GuestClient(A, "a", store); welcome(client);
    const recovered = client.recordPrompt("recover this\nexactly");
    client.markPromptRecovered(recovered.id);
    send.mockResolvedValueOnce(false);
    const view = render(<ComposerHarness client={client} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "different prompt" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(store.records.get(recovered.id)?.status).toBe("recovered");
    expect(store.records.get(recovered.id)?.text).toBe("recover this\nexactly");
    view.unmount(); client.close();
  });
  it("keeps approvals pending until host end, blocks duplicate taps, and settles queue in order", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const client = new GuestClient(A, "approval"); welcome(client);
    const first = { reqId: 1, title: "First?", kind: "select" as const, options: ["Allow", "Deny"] };
    const second = { reqId: 2, title: "Second?", kind: "select" as const, options: ["Allow", "Deny"] };
    act(() => { client.applyFrameForTest({ t: "ui-request", request: first }); client.applyFrameForTest({ t: "ui-request", request: second }); });
    function Harness() {
      const snap = React.useSyncExternalStore(client.subscribe.bind(client), client.getSnapshot.bind(client));
      const [draft, setDraft] = useState("");
      return <Composer client={client} phase="live" readOnly={snap.readOnly} uiRequest={snap.uiRequest} uiResponsePending={snap.uiResponsePending} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} />;
    }
    render(<Harness />);
    const send = vi.mocked(CollabSocket.prototype.send);
    fireEvent.click(screen.getByRole("button", { name: /Allow/ }));
    await act(async () => { await Promise.resolve(); });
    expect(client.getSnapshot().uiRequest?.reqId).toBe(1);
    expect(client.getSnapshot().uiResponsePending).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("awaiting host");
    fireEvent.click(screen.getByRole("button", { name: /Allow/ }));
    expect(send.mock.calls.filter(([frame]) => frame.t === "ui-response")).toHaveLength(1);
    act(() => client.applyFrameForTest({ t: "ui-request-end", reqId: 1 }));
    expect(client.getSnapshot().uiRequest?.reqId).toBe(2);
    expect(client.getSnapshot().uiResponsePending).toBe(false);
    client.close();
  });

  it("keeps refused approvals actionable and read-only peers cannot send", async () => {
    const send = vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(false);
    const client = new GuestClient(A, "approval"); welcome(client);
    const req = { reqId: 3, title: "Approve?", kind: "select" as const, options: ["Allow"] };
    client.applyFrameForTest({ t: "ui-request", request: req });
    await expect(client.sendUiResponse(3, "Allow")).resolves.toBe(false);
    expect(client.getSnapshot().uiRequest?.reqId).toBe(3);
    expect(client.getSnapshot().notices.some(n => n.level === "error" && n.message.includes("response not sent"))).toBe(true);
    client.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "s" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0, readOnly: true });
    send.mockClear();
    await expect(client.sendUiResponse(3, "Allow")).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    client.close();
  });
  it("refuses all read-only mutations before socket dispatch without recording prompts", async () => {
    const send = vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const client = new GuestClient(A, "readonly", store); welcome(client);
    client.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "s" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0, readOnly: true });
    client.applyFrameForTest({ t: "ui-request", request: { reqId: 5, title: "Approve?", kind: "select", options: ["Allow"] } });
    send.mockClear();
    await expect(client.sendPrompt("nope")).resolves.toBe(false);
    await expect(client.sendAbort()).resolves.toBe(false);
    await expect(client.sendAgentCmd("chat", "agent")).resolves.toBe(false);
    await expect(client.sendUiResponse(5, "Allow")).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
    client.close();
  });

  it("keeps writable mutations dispatched", async () => {
    const send = vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const client = new GuestClient(A, "writable"); welcome(client);
    await expect(client.sendPrompt("yes")).resolves.toBe(true);
    await expect(client.sendAbort()).resolves.toBe(true);
    await expect(client.sendAgentCmd("chat", "agent")).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    client.close();
  });

  it("does not settle current client's approval from stale-generation end frame", () => {
    const store = new PromptRecoveryStore();
    const stale = new GuestClient(A, "stale", store); welcome(stale);
    const current = new GuestClient(A, "current", store); welcome(current);
    current.applyFrameForTest({ t: "ui-request", request: { reqId: 4, title: "Approve?", kind: "select", options: ["Allow"] } });
    stale.applyFrameForTest({ t: "ui-request-end", reqId: 4 });
    expect(current.getSnapshot().uiRequest?.reqId).toBe(4);
    stale.close(); current.close();
  });
  it("cancels deferred frame commit on close", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", undefined);
    const client = new GuestClient(A, "close");
    const listener = vi.fn(); client.subscribe(listener);
    client.applyFrameForTest({ t: "event", event: { type: "message_update", message: { role: "assistant", content: "x" } } as never }, { flush: false });
    const commits = listener.mock.calls.length;
    client.close();
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(commits);
  });
  it("re-presents outstanding approval idempotently after welcome", async () => {
    const send = vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const client = new GuestClient(A, "rejoin"); welcome(client);
    const req = { reqId: 9, title: "Again?", kind: "select" as const, options: ["Allow"] };
    client.applyFrameForTest({ t: "ui-request", request: req });
    await client.sendUiResponse(9, "Allow");
    client.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "s" } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 });
    client.applyFrameForTest({ t: "ui-request", request: req });
    expect(client.getSnapshot().uiRequest?.reqId).toBe(9);
    expect(client.getSnapshot().uiResponsePending).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("un-recovers a removed foreign-room draft without allowing host echo mutation", () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const a = new GuestClient(A, "a", store); welcome(a);
    const record = a.recordPrompt("foreign text");
    const b = new GuestClient(B, "b", store); welcome(b);
    function Harness() {
      const [draft, setDraft] = useState("");
      return <Composer client={b} phase="live" readOnly={false} uiRequest={null} uiResponsePending={false} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(store.records.get(record.id)?.status).toBe("recovered");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(store.records.get(record.id)?.status).toBe("unconfirmed");
    expect(screen.getByRole("button", { name: "Recover" })).toBeTruthy();
    act(() => b.applyFrameForTest(entry("foreign text")));
    expect(store.records.get(record.id)?.status).toBe("unconfirmed");
    const newer = new GuestClient(B, "newer", store);
    b.markPromptUnrecovered(record.id);
    expect(store.records.get(record.id)?.status).toBe("unconfirmed");
    a.close(); b.close(); newer.close();
  });
  it("dismisses foreign recovered record after exact successful send", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const a = new GuestClient(A, "a", store); welcome(a);
    const record = a.recordPrompt("foreign exact block");
    const b = new GuestClient(B, "b", store); welcome(b);
    function Harness() {
      const [draft, setDraft] = useState("");
      return <Composer client={b} phase="live" readOnly={false} uiRequest={null} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} />;
    }
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "foreign exact block" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(store.records.has(record.id)).toBe(false);
    view.unmount(); a.close(); b.close();
  });
  it("keeps foreign recovered record when submitted block omits its text", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const a = new GuestClient(A, "a", store); welcome(a);
    const record = a.recordPrompt("foreign exact block");
    const b = new GuestClient(B, "b", store); welcome(b);
    function Harness() {
      const [draft, setDraft] = useState("");
      return <Composer client={b} phase="live" readOnly={false} uiRequest={null} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} />;
    }
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "unrelated" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(store.records.has(record.id)).toBe(true);
    view.unmount(); a.close(); b.close();
  });
});
