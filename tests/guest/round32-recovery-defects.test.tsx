// @vitest-environment jsdom
import React, { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SessionHeader } from "@oh-my-pi/pi-wire";
import { Composer } from "../../packages/guest/src/components/shell/Composer";
import { CollabSocket } from "../../packages/guest/src/lib/socket";
import { GuestClient, PromptRecoveryStore, type UnconfirmedPrompt } from "../../packages/guest/src/lib/client";

let App: () => React.ReactNode;
const roomA = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
const roomC = "wss://example.com/r/CCCCCCCCCCCCCCCC." + "D".repeat(43);
const welcome = (client: GuestClient, id = "session") => client.applyFrameForTest({ t: "welcome", proto: 3, header: { id } as unknown as SessionHeader, state: { isStreaming: false, queuedMessageCount: 0, cwd: "", participants: [] }, agents: [], entryCount: 0 });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
beforeAll(async () => { vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))); ({ App } = await import("../../packages/guest/src/app")); });
function compose(client: GuestClient, initial = "") {
  function Harness() { const [draft, setDraft] = useState(initial); return <Composer client={client} phase="live" readOnly={false} uiRequest={null} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} />; }
  return render(<Harness />);
}
function textEntry(text: string, id = "entry") { return { t: "entry" as const, entry: { type: "message" as const, id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user" as const, content: text, timestamp: Date.now() } } }; }

describe("Round 32 recovery regressions", () => {
  it("R32-09 refuses prompt before welcome without dispatch or record", async () => {
    const sent = vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(false);
    const client = new GuestClient(roomA, "tester");
    expect(await client.sendPrompt("x")).toBe(false);
    expect(client.getSnapshot().unconfirmedPrompts).toHaveLength(0);
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ t: "prompt" }));
    client.close();
  });

  it("R32-01 echoes one attempt non-destructively, excludes it from refusal, and exposes Copy/Dismiss", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const client = new GuestClient(roomA, "tester"); welcome(client);
    await client.sendPrompt("same");
    const first = client.getSnapshot().unconfirmedPrompts[0];
    const second = client.recordPrompt("same");
    client.applyFrameForTest(textEntry("same"));
    expect(client.getSnapshot().unconfirmedPrompts.find(p => p.id === first.id)?.status).toBe("echoed");
    expect(client.getSnapshot().unconfirmedPrompts.some(p => p.id === second.id)).toBe(true);
    client.applyFrameForTest(textEntry("same", "entry-2"));
    expect(client.getSnapshot().unconfirmedPrompts.find(p => p.id === second.id)?.status).toBe("echoed");
    client.applyFrameForTest({ t: "error", message: "Prompt was not submitted. Please resend it when the host is ready." });
    const view = compose(client);
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Recover" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Recover" })[0]);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("same");
    expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
    view.unmount(); client.close();
  });

  it("R32-03 capacity is per-room; stable-id dismiss frees a foreign slot", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const a = new GuestClient(roomA, "a", store); welcome(a);
    let first = 0;
    for (let i = 0; i < 256; i++) { const p = a.recordPrompt(`a${i}`); if (!i) first = p.id; }
    const view = compose(a, "preserved draft");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("preserved draft");
    const c = new GuestClient(roomC, "c", store); welcome(c);
    const cRecord = c.recordPrompt("room C");
    c.dismissPrompt(first);
    expect(store.records.has(first)).toBe(false);
    expect(store.records.has(cRecord.id)).toBe(true);
    expect(await c.sendPrompt("new room C prompt")).toBe(true);
    a.applyFrameForTest(textEntry("room C"));
    expect(store.records.get(cRecord.id)?.status).toBe("queued_local");
    view.unmount(); a.close(); c.close();
  });

  it("R32-04 close unsubscribes once across 100 client lifetimes", () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); let active = 0; let peak = 0;
    const subscribe = vi.spyOn(store, "subscribe").mockImplementation(listener => {
      const unsubscribe = PromptRecoveryStore.prototype.subscribe.call(store, listener);
      active++; peak = Math.max(peak, active); let done = false;
      return () => { if (done) return; done = true; active--; unsubscribe(); };
    });
    for (let i = 0; i < 100; i++) { const c = new GuestClient(roomA, "tester", store); expect(active).toBe(1); c.close(); expect(active).toBe(0); c.close(); }
    expect(subscribe).toHaveBeenCalledTimes(100); expect(peak).toBe(1); expect(active).toBe(0);
  });

  it("R32-14 stale recovery release and R32-15 superseded writes are fenced", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore(); const a = new GuestClient(roomA, "a", store); welcome(a);
    const p = a.recordPrompt("owned"); a.markPromptRecovered(p.id);
    const b = new GuestClient(roomA, "b", store); welcome(b); b.markPromptRecovered(p.id);
    a.releaseRecoveredPrompts([p.id]);
    expect(store.records.get(p.id)?.status).toBe("recovered");
    expect(await a.sendPrompt("stale")).toBe(false);
    expect(a.recordPrompt("stale").id).toBe(0);
    expect([...store.records.values()].filter(x => x.text === "stale")).toHaveLength(0);
    a.close(); b.close();
  });

  it("R32-18 refuses beyond UTF-8 1 MiB without truncating or dispatching", async () => {
    const sent = vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const c = new GuestClient(roomA, "tester"); welcome(c);
    const large = "x".repeat(1_048_575); c.recordPrompt(large);
    const view = compose(c, "zz"); fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(c.getSnapshot().notices.some(n => n.message.includes("1 MiB"))).toBe(true));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("zz");
    expect(c.getSnapshot().unconfirmedPrompts.find(p => p.text === large)?.text).toHaveLength(1_048_575);
    expect(sent).not.toHaveBeenCalledWith(expect.objectContaining({ t: "prompt", text: "zz" }));
    view.unmount(); c.close();
  });

  it("R32-05 multiline recovered blocks survive unrelated edits and substring is not presence", () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const c = new GuestClient(roomA, "tester"); welcome(c);
    const p = c.recordPrompt("line one\nline two"); c.markPromptRecovered(p.id);
    const view = compose(c, "prefix\nline one\nline two\nsuffix");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited prefix\nline one\nline two\nsuffix" } });
    expect(c.getSnapshot().unconfirmedPrompts.find(x => x.id === p.id)?.status).toBe("recovered");
    expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "edited prefix\nsuffix" } });
    expect(screen.getByRole("button", { name: "Recover" })).toBeTruthy();
    expect(c.getSnapshot().unconfirmedPrompts.find(x => x.id === p.id)?.status).toBe("unconfirmed");
    view.unmount();
    const q = c.recordPrompt("bug"); const v2 = compose(c, "debug");
    expect(screen.getByTitle("bug")).toBeTruthy(); expect(q.id).not.toBe(0); v2.unmount(); c.close();
  });
  it("ADV-03 stale send settlement cannot release replacement client's send lock", async () => {
    let settleA!: (value: boolean) => void;
    let settleB!: (value: boolean) => void;
    const a = { sendPrompt: vi.fn(() => new Promise<boolean>(resolve => { settleA = resolve; })), sendUiResponse: vi.fn(), sendAbort: vi.fn(), getSnapshot: () => ({ notices: [], unconfirmedPrompts: [] }), subscribe: () => () => {} } as unknown as GuestClient;
    const b = { ...a, sendPrompt: vi.fn(() => new Promise<boolean>(resolve => { settleB = resolve; })) } as unknown as GuestClient;
    function Harness() { const [client, setClient] = useState(a); const [draft, setDraft] = useState(""); return <><button onClick={() => setClient(b)}>replace</button><Composer client={client} phase="live" readOnly={false} uiRequest={null} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} /></>; }
    render(<Harness />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "prompt" } }); fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(screen.getByText("replace")); fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(b.sendPrompt).toHaveBeenCalledTimes(1);
    await act(async () => { settleA(true); await Promise.resolve(); });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(b.sendPrompt).toHaveBeenCalledTimes(1);
    await act(async () => { settleB(false); await Promise.resolve(); });
  });

  it("ADV-01 displays labeled foreign recovery; host frames stay room-scoped and Dismiss targets one id", () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const store = new PromptRecoveryStore();
    const a = new GuestClient(roomA, "a", store); welcome(a, "session-A");
    const old = a.recordPrompt("foreign text");
    const b = new GuestClient(roomC, "b", store); welcome(b, "session-C");
    const local = b.recordPrompt("local text");
    const view = compose(b);
    expect(screen.getByText(/room AAAAAAAAAAAAAAAA \/ session session-A/)).toBeTruthy();
    act(() => b.applyFrameForTest(textEntry("foreign text")));
    expect(store.records.get(old.id)?.status).toBe("queued_local");
    act(() => b.applyFrameForTest({ t: "error", message: "Prompt was not submitted. Please resend it when the host is ready." }));
    expect(store.records.get(old.id)?.status).toBe("queued_local");
    expect(store.records.get(local.id)?.status).toBe("refused");
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(store.records.has(old.id)).toBe(false);
    expect(store.records.has(local.id)).toBe(true);
    view.unmount(); a.close(); b.close();
  });

  it("failed connect disposes each attempted client's recovery subscription", async () => {
    const active = new Set<() => void>(); let peak = 0;
    const originalSubscribe = PromptRecoveryStore.prototype.subscribe;
    const subscribe = vi.spyOn(PromptRecoveryStore.prototype, "subscribe").mockImplementation(function (this: PromptRecoveryStore, listener) {
      const unsubscribe = originalSubscribe.call(this, listener);
      const token = () => {}; active.add(token); peak = Math.max(peak, active.size);
      return () => { active.delete(token); unsubscribe(); };
    });
    vi.spyOn(GuestClient.prototype, "connect").mockImplementation(() => { throw new Error("connect failed"); });
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    render(<App />);
    const input = screen.getByPlaceholderText("ws://host:port/r/room.key");
    await waitFor(() => expect(active.size).toBe(1));
    for (let i = 0; i < 8; i++) {
      fireEvent.change(input, { target: { value: roomA } });
      fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
      await screen.findByText("connect failed");
      await waitFor(() => expect(active.size).toBe(1));
    }
    expect(subscribe).toHaveBeenCalledTimes(9);
    expect(active.size).toBe(1); expect(peak).toBe(2);
  });

  it("R32-10 ignores stale rejection from replaced Composer client", async () => {
    let rejectA!: (error: Error) => void;
    const a = { sendPrompt: vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectA = reject; })), sendUiResponse: vi.fn(), sendAbort: vi.fn(), getSnapshot: () => ({ notices: [], unconfirmedPrompts: [] }), subscribe: () => () => {} } as unknown as GuestClient;
    const b = { ...a, sendPrompt: vi.fn().mockResolvedValue(false) } as unknown as GuestClient;
    function Harness() { const [client, setClient] = useState(a); const [draft, setDraft] = useState(""); return <><button onClick={() => setClient(b)}>replace</button><Composer client={client} phase="live" readOnly={false} uiRequest={null} working={false} queuedMessageCount={0} draft={draft} onDraftChange={setDraft} /></>; }
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A text" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.click(screen.getByText("replace"));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "B draft" } });
    await act(async () => { rejectA(new Error("A failed")); await Promise.resolve(); });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("B draft");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores stale UI response rejection from replaced Composer client", async () => {
    let rejectA!: (error: Error) => void;
    const request = { reqId: 7, title: "Allow?", kind: "select" as const, options: ["Yes", "No"] };
    const a = { sendPrompt: vi.fn(), sendUiResponse: vi.fn(() => new Promise<boolean>((_resolve, reject) => { rejectA = reject; })), sendAbort: vi.fn(), getSnapshot: () => ({ notices: [], unconfirmedPrompts: [] }), subscribe: () => () => {} } as unknown as GuestClient;
    const b = { ...a, sendUiResponse: vi.fn().mockResolvedValue(false) } as unknown as GuestClient;
    function Harness() { const [client, setClient] = useState(a); return <><button onClick={() => setClient(b)}>replace</button><Composer client={client} phase="live" readOnly={false} uiRequest={request} working={false} queuedMessageCount={0} draft="" onDraftChange={() => {}} /></>; }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Yes/ }));
    fireEvent.click(screen.getByText("replace"));
    await act(async () => { rejectA(new Error("A failed")); await Promise.resolve(); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("R32-12 ConnectScreen shows, copies, dismisses saved prompt without exposing link secret", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    const clients: GuestClient[] = [];
    vi.spyOn(GuestClient.prototype, "connect").mockImplementation(function (this: GuestClient) { clients.push(this); });
    window.history.replaceState(null, "", `${window.location.pathname}#${roomA}`);
    render(<App />); await waitFor(() => expect(clients).toHaveLength(1)); welcome(clients[0]);
    clients[0].recordPrompt("saved copy text"); fireEvent.click(screen.getByTitle("leave session"));
    expect(screen.getByText("saved copy text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy(); expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("B".repeat(43));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" })); await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); expect(screen.queryByText("saved copy text")).toBeNull();
  });
  it("R32-13 keeps room drafts through leave/rejoin but isolates rooms", async () => {
    const clients: GuestClient[] = [];
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    vi.spyOn(GuestClient.prototype, "connect").mockImplementation(function (this: GuestClient) { clients.push(this); });
    window.history.replaceState(null, "", `${window.location.pathname}#${roomA}`);
    render(<App />); await waitFor(() => expect(clients).toHaveLength(1)); welcome(clients[0]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "room A draft" } });
    fireEvent.click(screen.getByTitle("leave session"));
    await waitFor(() => expect(screen.getByPlaceholderText("ws://host:port/r/room.key")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("ws://host:port/r/room.key"), { target: { value: roomA } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    await waitFor(() => expect(clients).toHaveLength(2));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("room A draft");
    fireEvent.click(screen.getByTitle("leave session"));
    await waitFor(() => expect(screen.getByPlaceholderText("ws://host:port/r/room.key")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("ws://host:port/r/room.key"), { target: { value: roomC } });
    fireEvent.click(screen.getByRole("button", { name: /Connect/ }));
    await waitFor(() => expect(clients).toHaveLength(3));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
});
