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
  vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => { sent.push(frame); return Promise.resolve(true); });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  const view = render(<ConversationView conversationId="c-1" onDraftChange={onDraftChange} onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  await act(async () => { socket?.onFrame?.(welcome(initiallyRunning), 0); });
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

 it("audit12 control: known live session offers Open live view and reconnects",async()=>{
  vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"Host reconnecting"}});
  vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"conflict_owner",message:"Native session live"}});
  vi.spyOn(CollabSocket.prototype,"connect").mockImplementation(function(this:CollabSocket){socket=this;this.onOpen?.();});
  const view=render(<ConversationView conversationId="c-1" onBack={()=>{}}/>);
  const retry=await view.findByRole("button",{name:"Open live view"});
  vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"recovered",generation:1}});
  fireEvent.click(retry);
  await waitFor(()=>expect(socket).not.toBeNull());
  await act(async()=>{socket!.onFrame?.(welcome(), 0);});
  expect(view.container.querySelector("textarea.composer-input")).not.toBeNull();
 });
 it("audit12: late first host publication has a retry action without leaving the conversation",async()=>{
  const current=await api.getConversation("c-1");
  if(!current.ok)throw new Error("fixture failed");
  vi.mocked(api.getConversation).mockResolvedValue({ok:true,data:{...current.data,state:"starting",nativeSessionId:null,tmuxSessionId:"$1",tmuxPanePid:1002,tmuxServerIdentity:"private:1"}});
  vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No native session yet"}});
  vi.mocked(api.getConversationHistory).mockResolvedValue({ok:false,error:{code:"not_found",message:"No native session history yet"}});
  vi.spyOn(CollabSocket.prototype,"connect").mockImplementation(function(this:CollabSocket){socket=this;this.onOpen?.();});
  const view=render(<ConversationView conversationId="c-1" onBack={()=>{}}/>);
  await waitFor(()=>expect(api.getConversationHistory).toHaveBeenCalled());
  // The original managed process publishes later. Backend would now mint a link successfully.
  vi.mocked(api.getConversationLink).mockResolvedValue({ok:true,data:{url:"ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",access:"full",instanceId:"late",generation:1}});
  const retry=view.queryByRole("button",{name:/^(Retry|Open live view|Retry connection)$/i});
  console.log("AUDIT12 late host UI",JSON.stringify({hasRetry:!!retry,composer:!!view.container.querySelector("textarea.composer-input"),startingNotice:!!view.queryByText("Host is starting up; prompting may be refused."),claimsNoProcess:!!view.queryByText("There is currently no active host agent process running for this conversation.")}));
  expect(retry).not.toBeNull();
 });

 it("audit12: a failed stale send cannot consume the refusal for a newer prompt",async()=>{
  const view=await mountConversation();
  let finish!:(sent:boolean)=>void;let count=0;
  vi.mocked(CollabSocket.prototype.send).mockImplementation(frame=>{
    if(frame.t!=="prompt")return Promise.resolve(true);
    count++;return count===1?new Promise<boolean>(resolve=>{finish=resolve}):Promise.resolve(true);
  });
  let input=view.container.querySelector("textarea")!;
  fireEvent.change(input,{target:{value:"old not accepted"}});fireEvent.submit(input.closest("form")!);
  const previous=socket;await act(async()=>{previous!.onClose?.("lost",false);});
  fireEvent.click(view.getByRole("button",{name:"Retry"}));
  await waitFor(()=>expect(socket).not.toBe(previous));
  await act(async()=>{socket!.onFrame?.(welcome(), 0);finish(false);});
  input=view.container.querySelector("textarea")!;
  fireEvent.change(input,{target:{value:"new rejected prompt"}});
  await act(async()=>{fireEvent.submit(input.closest("form")!);});
  expect(input.value).toBe("");
  await act(async()=>{socket!.onFrame?.({t:"error",message:"prompting is unavailable until the host finishes starting up"}, 0);});
  console.log("AUDIT12 refused after reconnect",JSON.stringify({sends:count,draft:input.value,userRows:view.container.querySelectorAll(".message-card.user").length}));
  expect(input.value).toBe("new rejected prompt");
 });
});
