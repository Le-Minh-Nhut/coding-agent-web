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


 it("audit10: a pending prompt does not permanently block the same text after reconnect",async()=>{
  const view=await mountConversation();
  let finish!:(sent:boolean)=>void;
  const prompts:GuestFrame[]=[];
  vi.mocked(CollabSocket.prototype.send).mockImplementation(frame=>{
    if(frame.t!=="prompt")return Promise.resolve(true);
    prompts.push(frame);
    return prompts.length===1?new Promise<boolean>(resolve=>{finish=resolve}):Promise.resolve(true);
  });
  let input=view.container.querySelector("textarea")!;
  fireEvent.change(input,{target:{value:"retry after reconnect"}});
  fireEvent.submit(input.closest("form")!);
  await waitFor(()=>expect(prompts).toHaveLength(1));
  const previous=socket;
  await act(async()=>{previous!.onClose?.("lost",false);});
  fireEvent.click(view.getByText("Retry"));
  await waitFor(()=>expect(socket).not.toBe(previous));
  await act(async()=>{socket!.onFrame?.(welcome());finish(false);});
  input=view.container.querySelector("textarea")!;
  fireEvent.submit(input.closest("form")!);
  await new Promise(resolve=>setTimeout(resolve,20));
  console.log("AUDIT10 prompt retry",JSON.stringify({attempts:prompts.length,draft:input.value}));
  expect(prompts).toHaveLength(2);
 });

 it("audit10: pending approval can be answered after reconnect",async()=>{
  const view=await mountConversation();
  let finish!:(sent:boolean)=>void;
  const replies:GuestFrame[]=[];
  vi.mocked(CollabSocket.prototype.send).mockImplementation(frame=>{
    if(frame.t!=="ui-response")return Promise.resolve(true);
    replies.push(frame);
    return replies.length===1?new Promise<boolean>(resolve=>{finish=resolve}):Promise.resolve(true);
  });
  const request:HostFrame={t:"ui-request",request:{reqId:101,kind:"select",title:"Permission",options:["Approve Once","Deny"]}};
  await act(async()=>{socket!.onFrame?.(request);});
  fireEvent.click(view.getByRole("button", {name:/Deny/}));
  await waitFor(()=>expect(replies).toHaveLength(1));
  const previous=socket;
  await act(async()=>{previous!.onClose?.("lost",false);});
  fireEvent.click(view.getByText("Retry"));
  await waitFor(()=>expect(socket).not.toBe(previous));
  await act(async()=>{socket!.onFrame?.(welcome());socket!.onFrame?.(request);finish(false);});
  fireEvent.click(view.getByRole("button", {name:/Deny/}));
  await new Promise(resolve=>setTimeout(resolve,20));
  console.log("AUDIT10 approval retry",JSON.stringify({attempts:replies.length,requestStillVisible:!!view.queryByText("Permission")}));
  expect(replies).toHaveLength(2);
 });
});
