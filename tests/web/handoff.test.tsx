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

/** The header's overflow disclosure: secondary actions are one tap deeper. */
function openMenu(view: { getByRole: (role: "button", options: { name: string }) => HTMLElement }): void {
  fireEvent.click(view.getByRole("button", { name: "More actions" }));
}

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
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: true, data: { state: "delivered", paneId: "pane-1" } });
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

  it("reports delivery as delivery, never as a committed compaction", async () => {
    // The keystroke write only proves the paste landed. OMP may still be
    // generating, may have refused, or may not know the command at all, so the
    // UI must not claim the compaction happened.
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    await waitFor(() => expect(view.getByText("Handoff delivered — OMP may still be generating; the transcript will show the compression when it commits.")).toBeTruthy());
    expect(view.queryByText(/Handoff committed/)).toBeNull();
    expect(vi.mocked(api.requestHandoff)).toHaveBeenCalledTimes(1);
  });

  it("reports a committed handoff with its journal evidence", async () => {
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: true, data: { state: "committed", paneId: "pane-1", compactionEntryId: "compaction-7" } });
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    await waitFor(() => expect(view.getByText("Handoff committed — the journal records the compaction (compaction-7).")).toBeTruthy());
  });

  it("reports an agent-stated refusal distinctly, not as a delivery", async () => {
    // `refused: true` is positive evidence the agent declined, so the user learns
    // nothing was compacted and that retrying is meaningful — a different fact
    // from the ambiguous `delivered`.
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: true, data: { state: "delivered", paneId: "pane-1", refused: true } });
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    const notice = await waitFor(() => view.getByText(/Handoff refused — the agent declined it/));
    expect(notice.textContent).toContain("Nothing was compacted");
    expect(view.queryByText(/Handoff delivered/)).toBeNull();
    expect(view.queryByText(/Handoff committed/)).toBeNull();
    // Painted as a warning, not the green "delivered/streaming" tone.
    expect(notice.className).toContain("warning");
    expect(notice.className).not.toContain("running");
  });

  it("sends no draft-risk confirmation on the first attempt", async () => {
    // The emptiness of the terminal editor is unprovable, so the first request
    // must let the server answer `draft_unconfirmed` rather than pre-confirming.
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    await waitFor(() => expect(vi.mocked(api.requestHandoff)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.requestHandoff).mock.calls[0]![1]).toBe(false);
  });

  it("states the draft risk and re-sends with the flag only on an explicit tap", async () => {
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: false, error: { code: "draft_unconfirmed", message: "Confirm the terminal editor is empty." } });
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    // The risk is spelled out, including that the draft can reach the model.
    await waitFor(() => expect(view.getByText(/destroys that draft and can submit it to the model/)).toBeTruthy());
    // Nothing was auto-confirmed.
    expect(vi.mocked(api.requestHandoff).mock.calls[0]![1]).toBe(false);

    await act(async () => { fireEvent.click(view.getByRole("button", { name: "I checked — the editor is empty" })); });
    await waitFor(() => expect(vi.mocked(api.requestHandoff)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.requestHandoff).mock.calls[1]![1]).toBe(true);
  });

  it("offers no override for a terminal that holds the session", async () => {
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: false, error: { code: "terminal_attached", message: "A terminal is attached." } });
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });

    await waitFor(() => expect(view.getByText("A terminal is attached to this session. Run /handoff there instead.")).toBeTruthy());
    expect(view.queryByRole("button", { name: "I checked — the editor is empty" })).toBeNull();
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

    // The disclosure's state must commit before its contents can be queried.
    openMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Handoff context" })); });
    await act(async () => { fireEvent.click(view.getAllByRole("button", { name: "Run handoff" })[0]!); });

    await waitFor(() => expect(view.getByText("The recorded tmux server identity is not the live one.")).toBeTruthy());
    expect(textarea.value).toBe("unsent draft text");
    expect(promptFrames()).toEqual([]);
    expect(onDraftChange).toHaveBeenLastCalledWith("unsent draft text");
  });

  it("issues one request when the action is clicked twice in flight", async () => {
    let release: ((value: { ok: true; data: { state: "delivered"; paneId: string } }) => void) | null = null;
    vi.mocked(api.requestHandoff).mockImplementation(() => new Promise((resolve) => { release = resolve as never; }));
    const view = await mountConversation();
    // The disclosure's state must commit before its contents can be queried.
    openMenu(view);
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
    await act(async () => { release?.({ ok: true, data: { state: "delivered", paneId: "pane-1" } }); });
    await waitFor(() => expect(view.getByText("Handoff delivered — OMP may still be generating; the transcript will show the compression when it commits.")).toBeTruthy());
  });

  it("offers no enabled handoff control for a conversation this app does not manage", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: conversationRecord("external") as never });
    const view = await mountConversation();
    openMenu(view);
    const button = view.getByRole("button", { name: "Handoff context" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.getByText(/Handoff unavailable: Handoff requires a session this app manages/)).toBeTruthy();
  });

  it("does not carry a draft-risk override across a conversation switch", async () => {
    // P1-5: App renders ConversationView without keying it by conversationId, so
    // React reuses one instance across a switch. Accepting the draft risk on A
    // must never leak into B — otherwise tapping the carried button sends
    // `confirmDraftRisk: true` to a conversation the user never accepted it for.
    vi.mocked(api.requestHandoff).mockResolvedValue({ ok: false, error: { code: "draft_unconfirmed", message: "Confirm the terminal editor is empty." } });
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "Run handoff" })); });
    await waitFor(() => expect(view.getByRole("button", { name: "I checked — the editor is empty" })).toBeTruthy());

    // Switch to another conversation on the SAME component instance.
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...conversationRecord("managed"), id: "c-2" } as never });
    await act(async () => { view.rerender(<ConversationView conversationId="c-2" onBack={() => {}} />); });
    await act(async () => { socket?.onFrame?.(welcome()); });

    expect(view.queryByRole("button", { name: "I checked — the editor is empty" })).toBeNull();
    // And nothing from A's refusal is still on screen.
    expect(view.queryByText("Confirm the terminal editor is empty.")).toBeNull();
    expect(view.queryByText(/Handoff delivered|Handoff committed/)).toBeNull();
  });

  it("does not carry a leftover slash-command intercept across a switch", async () => {
    // Same class: the intercept panel is per-conversation state that renders
    // without its own guard.
    const view = await mountConversation();
    await sendFromComposer(view, "/handoff");
    expect(view.container.querySelector(".slash-command-intercept")).not.toBeNull();

    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...conversationRecord("managed"), id: "c-2" } as never });
    await act(async () => { view.rerender(<ConversationView conversationId="c-2" onBack={() => {}} />); });
    await act(async () => { socket?.onFrame?.(welcome()); });

    expect(view.container.querySelector(".slash-command-intercept")).toBeNull();
  });

  it("disables the control with a reason in a read-only view", async () => {
    const view = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(false, true)); });

    openMenu(view);
    const button = view.getByRole("button", { name: "Handoff context" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.getByText(/Handoff needs a writable link/)).toBeTruthy();
  });
});
