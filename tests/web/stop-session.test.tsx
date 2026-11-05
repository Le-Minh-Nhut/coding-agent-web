// @vitest-environment jsdom
/**
 * The two stop actions must stay distinguishable: `Stop generating` aborts the
 * Collab turn over the socket, `Stop OMP session` ends the app-managed process
 * over HTTP. These assert the observable difference (which request each one
 * makes, and that neither does the other's job), never that a function ran.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CollabSocket, type GuestFrame, type HostFrame } from "@caw/collab-protocol";
import { webcrypto } from "node:crypto";
import { api } from "../../apps/web/src/api.js";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    getConversationHistory: vi.fn(),
    getModels: vi.fn(),
    requestHandoff: vi.fn(),
    stopConversation: vi.fn(),
    restartConversation: vi.fn(),
  },
}));

let socket: CollabSocket | null = null;
let sent: GuestFrame[] = [];
let spy: ReturnType<typeof vi.spyOn> | null = null;

class RecordingWebSocket {
  static instances: RecordingWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    RecordingWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }

  send(): void {
    throw new Error("Expected the mocked CollabSocket.send");
  }

  close(): void {
    this.readyState = 3;
  }
}

const welcome = (isStreaming = false): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "session", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
});

function conversationRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "c-1", projectId: "p-1", nativeSessionId: "native-1", nativeSessionPath: "/tmp/session.jsonl",
    title: "Test", model: "model", ownership: "managed", state: "idle",
    tmuxSessionId: "caw-1", tmuxSessionName: "caw-1", tmuxServerIdentity: "ident", tmuxPanePid: 42,
    hostInstanceId: null, hostGeneration: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActivityAt: null,
    statusDetail: null, modelPreference: "model-a",
    ...overrides,
  };
}

async function mountConversation() {
  sent = [];
  socket = null;
  spy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => { sent.push(frame); return Promise.resolve(true); });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  return view;
}

const abortFrames = () => sent.filter((frame) => frame.t === "abort");

describe("stop generating vs stop OMP session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: RecordingWebSocket as unknown as typeof WebSocket });
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: conversationRecord() as never });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: ["model-a"], source: "omp", reason: null } });
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: true, data: { delivered: true, paneId: "pane-1" } });
    vi.mocked(api.stopConversation).mockResolvedValue({ ok: true, data: conversationRecord({ state: "stopped" }) as never });
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: conversationRecord({ state: "running" }) as never });
  });

  afterEach(() => {
    cleanup();
    spy?.mockRestore();
    vi.restoreAllMocks();
    socket = null;
  });

  /** The header's overflow menu: secondary actions are one tap away, not absent. */
  function openMenu(view: { getByRole: (r: "button", o: { name: string }) => HTMLElement }): void {
    fireEvent.click(view.getByRole("button", { name: "More actions" }));
  }

  it("offers both actions with distinct labels while a turn is generating", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(true)); });

    // Stop generating stays OUT of the menu and directly tappable: it is the
    // control a user reaches for mid-turn, so one tap is the requirement.
    expect(view.getByRole("button", { name: "Stop generating" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Stop generating" }).getAttribute("title")).toMatch(/process stays alive/i);
    openMenu(view);
    expect(view.getByRole("button", { name: "Stop OMP session" })).toBeTruthy();
  });

  it("stop generating sends an abort frame and never the stop-session action", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(true)); });

    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop generating" })); });

    expect(abortFrames()).toEqual([{ t: "abort" }]);
    expect(vi.mocked(api.stopConversation)).not.toHaveBeenCalled();
  });

  it("stop OMP session calls the stop action and never sends an abort frame", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(true)); });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop OMP session" })); });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop session anyway" })); });

    expect(vi.mocked(api.stopConversation)).toHaveBeenCalledWith("c-1");
    expect(abortFrames()).toEqual([]);
    await waitFor(() => expect(view.getByText("Session stopped. History and the native session are preserved.")).toBeTruthy());
  });

  it("names what will be interrupted when a turn is generating", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(true)); });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop OMP session" })); });

    expect(view.getByText(/This will interrupt the turn that is generating now/)).toBeTruthy();
    expect(view.getByRole("button", { name: "Stop session anyway" })).toBeTruthy();
  });

  it("names a pending approval and running subagents instead of asking a bare are-you-sure", async () => {
    const view = await mountConversation();
    await act(async () => {
      socket?.onFrame?.({ t: "agents", agents: [
        { id: "main", displayName: "Main", kind: "main", status: "running", hasSessionFile: false, createdAt: 1, lastActivity: 2 },
        { id: "sub-1", displayName: "Sub", kind: "sub", parentId: "main", status: "running", hasSessionFile: false, createdAt: 1, lastActivity: 2 },
      ] });
    });
    await act(async () => {
      socket?.onFrame?.({ t: "ui-request", request: { reqId: 91, kind: "select", title: "Approve action?", options: ["Approve"] } });
    });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop OMP session" })); });

    const notice = view.getByText(/This will interrupt/).textContent ?? "";
    expect(notice).toMatch(/approval request waiting on you/);
    expect(notice).toMatch(/running subagents \(1\)/);
  });

  it("uses a plain confirmation when nothing is in flight", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(false)); });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop OMP session" })); });

    expect(view.getByText("No turn is in flight, so nothing is being interrupted.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Confirm stop session" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Stop session anyway" })).toBeNull();
  });

  it("does not offer the action at all for an external session", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: conversationRecord({ ownership: "external" }) as never });
    const view = await mountConversation();

    openMenu(view);
    expect(view.queryByRole("button", { name: "Stop OMP session" })).toBeNull();
    expect(view.getByText(/Stop session unavailable: This session is externally managed/)).toBeTruthy();
    expect(vi.mocked(api.stopConversation)).not.toHaveBeenCalled();
  });

  it("disables the action with a reason when no verified tmux identity is recorded", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: conversationRecord({ tmuxSessionId: null, tmuxServerIdentity: null }) as never });
    const view = await mountConversation();

    openMenu(view);
    const button = view.getByRole("button", { name: "Stop OMP session" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.getByText(/Stop session unavailable: No verified managed tmux session is recorded/)).toBeTruthy();
  });

  it("renders the server's precise refusal and keeps the transcript on screen", async () => {
    vi.mocked(api.stopConversation).mockResolvedValue({ ok: false, error: { code: "agent_not_running", message: "The tmux server identity changed, so this process cannot be safely stopped." } });
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(false)); });
    await act(async () => {
      socket?.onFrame?.({ t: "entry", entry: { type: "message", id: "m-1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "keep me visible", timestamp: 1 } } });
    });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop OMP session" })); });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Confirm stop session" })); });

    await waitFor(() => expect(view.getByText(/Not safe to stop: The tmux server identity changed, so this process cannot be safely stopped\./)).toBeTruthy());
    expect(view.container.querySelectorAll(".message-card.user")).toHaveLength(1);
    expect(view.getByText("keep me visible")).toBeTruthy();
  });

  it("reports a stop that has not completed yet as requested, not as done", async () => {
    vi.mocked(api.stopConversation).mockResolvedValue({ ok: true, data: conversationRecord({ state: "stopping" }) as never });
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(false)); });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop OMP session" })); });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Confirm stop session" })); });

    await waitFor(() => expect(view.getByText(/Stop requested\. The process has not exited yet; history and the native session are preserved\./)).toBeTruthy());
  });

  it("offers Restart beside a stopped session and calls the restart action", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(false)); });
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Stop OMP session" })); });
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Confirm stop session" })); });

    await waitFor(() => expect(view.getByText("Session stopped. History and the native session are preserved.")).toBeTruthy());
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Restart" })); });
    expect(vi.mocked(api.restartConversation)).toHaveBeenCalledWith("c-1");
  });
});
