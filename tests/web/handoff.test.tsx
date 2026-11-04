// @vitest-environment jsdom
/**
 * `/handoff` behaviour: OMP's native builtin delivered as keystrokes.
 *
 * These assert what the user observes — that `/handoff` never leaves as a prompt,
 * which sentence each refusal produces, and that the draft survives — never that
 * a particular function ran.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CollabSocket, importRoomKey, type GuestFrame, type HostFrame } from "@caw/collab-protocol";
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
  readonly sent: Uint8Array[] = [];

  constructor(readonly url: string) {
    RecordingWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: ArrayBufferLike | ArrayBufferView | Blob | string): void {
    if (data instanceof Uint8Array) this.sent.push(data);
    else throw new Error("Expected encrypted Collab envelope");
  }

  close(): void {
    this.readyState = 3;
  }
}

const welcome = (isStreaming = false, readOnly = false): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "session", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
  ...(readOnly ? { readOnly: true } : {}),
});

function conversationRecord(ownership: "managed" | "external") {
  return {
    id: "c-1", projectId: "p-1", nativeSessionId: "native-1", nativeSessionPath: null, title: "Test", model: "model",
    ownership, state: "idle", tmuxSessionId: "caw-1", tmuxSessionName: "caw-1", tmuxServerIdentity: "ident",
    tmuxPanePid: 42, hostInstanceId: null, hostGeneration: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastActivityAt: null,
    statusDetail: null, modelPreference: "model-a",
  };
}

async function mountConversation(onDraftChange?: (draft: string) => void) {
  sent = [];
  socket = null;
  spy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => { sent.push(frame); return Promise.resolve(true); });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  const view = render(<ConversationView conversationId="c-1" onDraftChange={onDraftChange} onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  await act(async () => { socket?.onFrame?.(welcome()); });
  return view;
}

function promptFrames() {
  return sent.filter((frame): frame is Extract<GuestFrame, { t: "prompt" }> => frame.t === "prompt");
}

async function sendFromComposer(view: ReturnType<typeof render>, text: string) {
  const textarea = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  await act(async () => { fireEvent.click(view.getByRole("button", { name: "Send" })); });
  return textarea;
}

describe("/handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: RecordingWebSocket as unknown as typeof WebSocket });
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: conversationRecord("managed") as never });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: ["model-a"], source: "omp", reason: null } });
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: true, data: { delivered: true, paneId: "pane-1" } });
  });

  afterEach(() => {
    cleanup();
    spy?.mockRestore();
    vi.restoreAllMocks();
    socket = null;
  });

  it("intercepts /handoff instead of sending it as a prompt", async () => {
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");

    expect(promptFrames()).toEqual([]);
    expect(view.container.querySelectorAll(".message-card.user")).toHaveLength(0);
    expect(view.container.querySelector(".slash-command-intercept")).not.toBeNull();
    expect(view.getByRole("button", { name: "Run handoff" })).toBeTruthy();
    expect(vi.mocked(api.requestHandoff)).not.toHaveBeenCalled();
  });

  it("does not offer autocomplete for an operand form", async () => {
    const view = await mountConversation();
    const textarea = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/handoff focus on compaction" } });
    // A word after the command is a focus argument, which the server refuses; the
    // UI must not suggest it, and sending it must not take the handoff path.
    expect(view.container.querySelector(".composer-suggestions")).toBeNull();
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Send" })); });
    expect(vi.mocked(api.requestHandoff)).not.toHaveBeenCalled();
  });

  it("reports the committed handoff in the user's terms", async () => {
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    await waitFor(() => expect(view.getByText("Handoff committed — context compacted in place; session unchanged.")).toBeTruthy());
    expect(vi.mocked(api.requestHandoff)).toHaveBeenCalledTimes(1);
  });

  it("renders the terminal-specific guidance when a terminal holds the session", async () => {
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: false, error: { code: "terminal_attached", message: "A terminal is attached." } });
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    await waitFor(() => expect(view.getByText("A terminal is attached to this session. Run /handoff there instead.")).toBeTruthy());
  });

  it("keeps the unsent draft when the handoff is refused, and never sends it", async () => {
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: false, error: { code: "conflict_owner", message: "The recorded tmux server identity is not the live one." } });
    const onDraftChange = vi.fn();
    const view = await mountConversation(onDraftChange);
    const textarea = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "unsent draft text" } });

    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Handoff context" })); });
    await act(async () => { fireEvent.click(view.getAllByRole("button", { name: "Run handoff" })[0]!); });

    await waitFor(() => expect(view.getByText("The recorded tmux server identity is not the live one.")).toBeTruthy());
    expect(textarea.value).toBe("unsent draft text");
    expect(promptFrames()).toEqual([]);
    expect(onDraftChange).toHaveBeenLastCalledWith("unsent draft text");
  });

  it("issues one request when the action is clicked twice in flight", async () => {
    let release: ((value: { ok: true; data: { delivered: true; paneId: string } }) => void) | null = null;
    vi.mocked(api.requestHandoff).mockImplementation(() => new Promise((resolve) => { release = resolve as never; }));
    const view = await mountConversation();
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Handoff context" })); });
    const run = view.getAllByRole("button", { name: "Run handoff" })[0]!;

    await act(async () => {
      fireEvent.click(run);
      fireEvent.click(run);
    });
    // Observable in-flight state: the label reports the work and the control is
    // inert, so the second click was never an action the user could take.
    expect(view.getAllByText("Generating handoff…").length).toBeGreaterThan(0);
    expect((view.getAllByRole("button", { name: "Generating handoff…" })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(api.requestHandoff)).toHaveBeenCalledTimes(1);
    await act(async () => { release?.({ ok: true, data: { delivered: true, paneId: "pane-1" } }); });
    await waitFor(() => expect(view.getByText("Handoff committed — context compacted in place; session unchanged.")).toBeTruthy());
  });

  it("offers no enabled handoff control for a conversation this app does not manage", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: conversationRecord("external") as never });
    const view = await mountConversation();
    const button = view.getByRole("button", { name: "Handoff context" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.getByText(/Handoff unavailable: Handoff requires a session this app manages/)).toBeTruthy();
  });

  it("disables the control with a reason in a read-only view", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(false, true)); });

    const button = view.getByRole("button", { name: "Handoff context" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.getByText(/Handoff needs a writable link/)).toBeTruthy();
  });
});
