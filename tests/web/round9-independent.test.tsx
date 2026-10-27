// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CollabSocket, encodeBase64Url, importRoomKey, open, unpackEnvelope, type GuestFrame, type HostFrame } from "@caw/collab-protocol";
import { webcrypto } from "node:crypto";
import { api } from "../../apps/web/src/api.js";
import { ConversationView, autosizeComposer } from "../../apps/web/src/components/ConversationView.js";
import { MarkdownCodeBlock, renderMarkdown } from "../../apps/web/src/sanitize.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: { setConversationModel: vi.fn(), restartConversation: vi.fn(), getConversation: vi.fn(), getAttachInstructions: vi.fn(), getConversationLink: vi.fn(), getConversationHistory: vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } }), getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }) },
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

async function mountConversation(initiallyRunning = false, onDraftChange?: (draft: string) => void) {
  sent = [];
  socket = null;
  spy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => { sent.push(frame); return Promise.resolve(true); });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  const view = render(<ConversationView conversationId="c-1" onDraftChange={onDraftChange} onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  await act(async () => { socket?.onFrame?.(welcome(initiallyRunning)); });
  return view;
}

function promptFrames() {
  return sent.filter((frame): frame is Extract<GuestFrame, { t: "prompt" }> => frame.t === "prompt");
}

describe("mobile reading behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: {
      id: "c-1", projectId: "p-1", nativeSessionId: null, nativeSessionPath: null, title: "Test", model: "model",
      ownership: "managed", state: "idle", tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null,
      tmuxPanePid: null, hostInstanceId: null, hostGeneration: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), lastActivityAt: null, statusDetail: null, modelPreference: "model-a",
    } });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: ["model-a", "model-b"], source: "omp", reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
  });

  afterEach(() => { cleanup(); vi.restoreAllMocks(); socket=null; });

  it("audit: completion from an unmounted send cannot erase a remounted draft", async () => {
    let finish!: (sent:boolean)=>void;
    vi.spyOn(CollabSocket.prototype,"send").mockImplementation(frame=>frame.t==="prompt" ? new Promise<boolean>(resolve=>{finish=resolve}) : Promise.resolve(true));
    vi.spyOn(CollabSocket.prototype,"connect").mockImplementation(function(this:CollabSocket){ socket=this; this.onOpen?.(); });
    function Harness(){
      const [visible,setVisible]=React.useState(true);
      const [draft,setDraft]=React.useState("");
      return <><button onClick={()=>setVisible(v=>!v)}>toggle conversation</button>{visible && <ConversationView conversationId="c-1" draft={draft} onDraftChange={setDraft} onBack={()=>{}}/>}</>;
    }
    const view=render(<Harness/>);
    await waitFor(()=>expect(socket).not.toBeNull());
    await act(async()=>{socket!.onFrame?.(welcome());});
    let input=view.container.querySelector("textarea")!;
    fireEvent.change(input,{target:{value:"old prompt"}});
    fireEvent.submit(input.closest("form")!);
    await waitFor(()=>expect(finish).toBeTypeOf("function"));
    fireEvent.click(view.getByText("toggle conversation"));
    socket=null;
    fireEvent.click(view.getByText("toggle conversation"));
    await waitFor(()=>expect(socket).not.toBeNull());
    await act(async()=>{socket!.onFrame?.(welcome());});
    input=view.container.querySelector("textarea")!;
    fireEvent.change(input,{target:{value:"new unsent draft"}});
    expect(input.value).toBe("new unsent draft");
    await act(async()=>{finish(true);});
    console.log("AUDIT remounted draft",JSON.stringify(input.value));
    expect(input.value).toBe("new unsent draft");
  });

  it("audit: finishing restart after unmount does not open an orphan socket",async()=>{
    vi.spyOn(window,"confirm").mockReturnValue(true);
    const result=await api.getConversation("c-1");
    vi.mocked(api.setConversationModel).mockResolvedValue(result);
    let finish!: (value:typeof result)=>void;
    vi.mocked(api.restartConversation).mockImplementation(()=>new Promise(resolve=>{finish=resolve}));
    const view=await mountConversation();
    const connects=vi.mocked(CollabSocket.prototype.connect);
    fireEvent.click(view.getByText("Save & restart agent"));
    await waitFor(()=>expect(finish).toBeTypeOf("function"));
    view.unmount();
    const before=connects.mock.calls.length;
    await act(async()=>{finish(result);});
    await new Promise(resolve=>setTimeout(resolve,40));
    console.log("AUDIT restart after unmount",JSON.stringify({before,after:connects.mock.calls.length}));
    expect(connects.mock.calls.length).toBe(before);
    socket?.close();
  });

  it("audit: live host state updates the effective model label",async()=>{
    const view=await mountConversation();
    const frame=welcome();
    if(frame.t!=="welcome") throw new Error("unexpected frame");
    frame.state.model={id:"actual-model",name:"Actual model",provider:"provider",contextWindow:100000};
    await act(async()=>{socket!.onFrame?.(frame);});
    const label=view.getByText(/Effective model reported now/);
    console.log("AUDIT effective model",label.textContent);
    expect(label.textContent).toContain("actual-model");
  });

  it("audit: late prompt refusal cannot mutate remounted draft", async () => {
    let finish!: (sent: boolean) => void;
    vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => frame.t === "prompt" ? new Promise<boolean>((resolve) => { finish = resolve; }) : Promise.resolve(true));
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    const onDraftChange = vi.fn();
    const view = render(<ConversationView conversationId="c-1" onDraftChange={onDraftChange} onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome()); });
    let input = view.container.querySelector("textarea")!;
    fireEvent.change(input, { target: { value: "old pending" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.unmount();
    const remounted = render(<ConversationView conversationId="c-1" draft="new draft" onDraftChange={onDraftChange} onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome()); });
    input = remounted.container.querySelector("textarea")!;
    await act(async () => { finish(false); });
    expect(input.value).toBe("new draft");
    expect(onDraftChange).not.toHaveBeenLastCalledWith("");
  });

  it("offers a read-only link when control is refused", async () => {
    vi.mocked(api.getConversationLink).mockImplementation(async (_id, access = "control") => access === "control"
      ? { ok: false, error: { code: "capability_missing", message: "host offers view only" } }
      : { ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "view", instanceId: "i", generation: 1 } });
    socket = null;
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await waitFor(() => expect(view.getByRole("button", { name: "Open read-only" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Open read-only" }));

    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome(false, true)); });
    expect(view.getByText(/Read-only view/)).toBeTruthy();
    expect(view.container.querySelector("textarea.composer-input")).toBeNull();
    expect(api.getConversationLink).toHaveBeenLastCalledWith("c-1", "view");
  });

  it("ignores late send failure after switching conversation and preserves new draft", async () => {
    let finish!: (sent: boolean) => void;
    vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => frame.t === "prompt" ? new Promise<boolean>((resolve) => { finish = resolve; }) : Promise.resolve(true));
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    const onDraftChange = vi.fn();
    const view = render(<ConversationView conversationId="c-1" draft="old" onDraftChange={onDraftChange} onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome()); });
    let input = view.container.querySelector("textarea")!;
    fireEvent.change(input, { target: { value: "old request" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    view.rerender(<ConversationView conversationId="c-2" draft="new conversation" onDraftChange={onDraftChange} onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket!.onFrame?.(welcome()); });
    input = view.container.querySelector("textarea")!;
    fireEvent.change(input, { target: { value: "new chat draft" } });
    await act(async () => { finish(false); });
    expect(input.value).toBe("new chat draft");
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.container.querySelector(".message-card.user")).toBeNull();
  });

  it("clears previous live model when conversation changes", async () => {
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    const firstSocket = socket;
    const first = welcome();
    if (first.t !== "welcome") throw new Error("unexpected frame");
    first.state.model = { id: "first-model", name: "First", provider: "test", contextWindow: 100000 };
    await act(async () => { firstSocket!.onFrame?.(first); });
    expect(view.getByText(/Effective model reported now/).textContent).toContain("first-model");

    view.rerender(<ConversationView conversationId="c-2" onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBe(firstSocket));
    await act(async () => { socket!.onFrame?.(welcome()); });
    expect(view.getByText(/Effective model reported now/).textContent).toContain("not reported");
  });

  it("hides lifecycle and prompt controls for externally owned sessions", async () => {
    const result = await api.getConversation("c-1");
    if (!result.ok) throw new Error("conversation fixture unavailable");
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...result.data, ownership: "external" } });
    const view = await mountConversation(true);
    await act(async () => { socket?.onFrame?.(welcome(true)); });
    fireEvent.click(view.getByText("Conversation model settings"));
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(view.queryByRole("button", { name: "Save & restart agent" })).toBeNull();
    expect(view.queryByRole("button", { name: "Save model" })).toBeNull();
    expect(view.container.querySelector("textarea.composer-input")).not.toBeNull();
    expect(view.getByText(/Saved preference for app-launched chats/)).toBeTruthy();
  });

  it("keeps same-mount edits made while a send is pending", async () => {
    let finish!: (sent: boolean) => void;
    const onDraftChange = vi.fn();
    const view = await mountConversation(false, onDraftChange);
    spy?.mockImplementation((frame) => frame.t === "prompt" ? new Promise<boolean>((resolve) => { finish = resolve; }) : Promise.resolve(true));
    const input = view.container.querySelector("textarea")!;
    fireEvent.change(input, { target: { value: "pending prompt" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    fireEvent.change(input, { target: { value: "new same-view draft" } });
    await act(async () => { finish(true); });
    expect(input.value).toBe("new same-view draft");
    expect(onDraftChange).not.toHaveBeenLastCalledWith("");
  });
});
