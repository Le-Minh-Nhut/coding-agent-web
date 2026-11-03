// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SessionHeader } from "../../packages/guest/src/vendor/wire";
import { GuestClient, PromptRecoveryStore } from "../../packages/guest/src/lib/client";
import { CollabSocket } from "../../packages/guest/src/lib/socket";
import { AgentDrawer } from "../../packages/guest/src/components/agents/AgentDrawer";

let App: () => React.ReactNode;
const link = "wss://example.com/r/AAAAAAAAAAAAAAAA." + "B".repeat(43);
const state = (isStreaming: boolean) => ({ isStreaming, queuedMessageCount: 0, cwd: "", participants: [] });
function welcome(client: GuestClient, isStreaming = false): void {
  client.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "session" } as unknown as SessionHeader, state: state(isStreaming), agents: [], entryCount: 0 });
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeAll(async () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  ({ App } = await import("../../packages/guest/src/app"));
});

describe("Round 36 guest fixes", () => {
  it("syncs working state on welcome in both directions", () => {
    const store = new PromptRecoveryStore();
    const client = new GuestClient(link, "guest", store);
    welcome(client, true);
    expect(client.getSnapshot().working).toBe(true);
    client.applyFrameForTest({ t: "welcome", proto: 3, header: { id: "session" } as unknown as SessionHeader, state: state(false), agents: [], entryCount: 0 });
    expect(client.getSnapshot().working).toBe(false);
    expect(client.getSnapshot().loading).toBeFalsy();
    client.close();
  });

  it("reconciles old approval UI against reconnect replay", () => {
    const client = new GuestClient(link, "guest", new PromptRecoveryStore());
    welcome(client);
    const request = { reqId: 41, kind: "editor" as const, title: "Approve?", prefill: "" };
    client.applyFrameForTest({ t: "ui-request", request });
    expect(client.getSnapshot().uiRequest?.reqId).toBe(41);
    welcome(client);
    expect(client.getSnapshot().uiRequest).toBeNull();
    client.applyFrameForTest({ t: "ui-request", request });
    expect(client.getSnapshot().uiRequest?.reqId).toBe(41);
    client.applyFrameForTest({ t: "ui-request", request });
    expect(client.getSnapshot().uiRequest?.reqId).toBe(41);
    client.applyFrameForTest({ t: "ui-request-end", reqId: 41 });
    expect(client.getSnapshot().uiRequest).toBeNull();
    client.close();
  });

  it("shows a newly recorded prompt in the real App ConnectScreen after leave", async () => {
    const clients: GuestClient[] = [];
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    vi.spyOn(GuestClient.prototype, "connect").mockImplementation(function (this: GuestClient) { clients.push(this); });
    window.history.replaceState(null, "", `${window.location.pathname}#${link}`);
    render(<App />);
    await waitFor(() => expect(clients).toHaveLength(1));
    welcome(clients[0]);
    act(() => { clients[0].recordPrompt("recover me after new link"); });
    expect(screen.getByTitle("recover me after new link")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    fireEvent.click(screen.getByTitle("leave session"));
    expect(screen.getByText("recover me after new link")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("recover me after new link")).toBeNull();
  });

  it("notifies recovery subscribers when creating a prompt", () => {
    const store = new PromptRecoveryStore();
    const client = new GuestClient(link, "guest", store);
    const listener = vi.fn();
    store.subscribe(listener);
    client.recordPrompt("x");
    expect(listener).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("notifies recovery subscribers when refusing a prompt", () => {
    const store = new PromptRecoveryStore();
    const client = new GuestClient(link, "guest", store);
    const prompt = client.recordPrompt("x");
    const listener = vi.fn();
    store.subscribe(listener);
    client.markPromptRefused(prompt.id, "err");
    expect(listener).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("reflects refusal status in ConnectScreen after leaving", async () => {
    const clients: GuestClient[] = [];
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    vi.spyOn(GuestClient.prototype, "connect").mockImplementation(function (this: GuestClient) { clients.push(this); });
    window.history.replaceState(null, "", `${window.location.pathname}#${link}`);
    render(<App />);
    await waitFor(() => expect(clients).toHaveLength(1));
    welcome(clients[0]);
    act(() => { clients[0].recordPrompt("recover status"); });
    act(() => { clients[0].markPromptRefused(1, "refused"); });
    fireEvent.click(screen.getByTitle("leave session"));
    expect(screen.getByRole("status").textContent).toContain("refused");
    expect(screen.getByText("recover status")).toBeTruthy();
  });

  it("keeps accepted chat draft and explains host execution is unconfirmed", async () => {
    const client = { sendAgentCmd: vi.fn().mockResolvedValue(true), fetchTranscript: vi.fn() } as unknown as GuestClient;
    render(<AgentDrawer agent={{ id: "a", displayName: "worker", kind: "sub", status: "parked", hasSessionFile: false, createdAt: 0, lastActivity: 0 }} client={client} phase="live" onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/message worker/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "chat text" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect((await screen.findByRole("status")).textContent).toContain("sent to socket; host execution unconfirmed");
    expect(input.value).toBe("chat text");
  });

  it.each([
    ["refuses", () => Promise.resolve(false)],
    ["rejects", () => Promise.reject(new Error("offline"))],
  ])("keeps draft when chat send %s", async (_label, send) => {
    const client = { sendAgentCmd: vi.fn(send), fetchTranscript: vi.fn() } as unknown as GuestClient;
    render(<AgentDrawer agent={{ id: "a", displayName: "worker", kind: "sub", status: "parked", hasSessionFile: false, createdAt: 0, lastActivity: 0 }} client={client} phase="live" onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/message worker/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep text" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    expect((await screen.findByRole("status")).textContent).toContain("message not sent — press send to retry");
    expect(input.value).toBe("keep text");
  });

  it("preserves newer typing after earlier chat send settles", async () => {
    let settle!: (value: boolean) => void;
    const client = { sendAgentCmd: vi.fn(() => new Promise<boolean>(resolve => { settle = resolve; })), fetchTranscript: vi.fn() } as unknown as GuestClient;
    render(<AgentDrawer agent={{ id: "a", displayName: "worker", kind: "sub", status: "parked", hasSessionFile: false, createdAt: 0, lastActivity: 0 }} client={client} phase="live" onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/message worker/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));
    fireEvent.change(input, { target: { value: "new draft" } });
    await act(async () => { settle(true); });
    expect(input.value).toBe("new draft");
  });

  it("does not carry drawer draft across remount or agent switch", () => {
    const client = { sendAgentCmd: vi.fn(), fetchTranscript: vi.fn() } as unknown as GuestClient;
    const agent = { id: "a", displayName: "worker", kind: "sub" as const, status: "parked" as const, hasSessionFile: false, createdAt: 0, lastActivity: 0 };
    const view = render(<AgentDrawer agent={agent} client={client} phase="live" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/message worker/i), { target: { value: "private draft" } });
    view.rerender(<AgentDrawer agent={{ ...agent, id: "b", displayName: "other" }} client={client} phase="live" onClose={() => {}} />);
    expect((screen.getByPlaceholderText(/message other/i) as HTMLInputElement).value).toBe("");
    view.unmount();
    render(<AgentDrawer agent={agent} client={client} phase="live" onClose={() => {}} />);
    expect((screen.getByPlaceholderText(/message worker/i) as HTMLInputElement).value).toBe("");
  });
});
