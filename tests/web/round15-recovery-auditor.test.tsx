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

 it("V15 history retry: a recovered saved-history endpoint is fetched again by Retry",async()=>{
  vi.mocked(api.getConversationLink).mockResolvedValue({ok:false,error:{code:"link_unavailable",message:"No live host"}});
  const history={header:{sessionId:"s",cwd:"/work",timestamp:null,version:3,title:"Restored history"},entries:[],truncated:false,truncatedByBytes:false,truncatedByEntries:false,skippedOversized:false,hasOlder:false,nextCursor:null};
  vi.mocked(api.getConversationHistory).mockResolvedValueOnce({ok:false,error:{code:"internal",message:"Temporary journal read failure"}}).mockResolvedValue({ok:true,data:history});
  const view=render(<ConversationView conversationId="c-1" onBack={()=>{}}/>);
  await view.findByText("Temporary journal read failure");
  await act(async()=>{fireEvent.click(view.getByRole("button",{name:"Retry"}));});
  console.log("AUDIT15 history retry",JSON.stringify({historyReads:vi.mocked(api.getConversationHistory).mock.calls.length,oldErrorVisible:!!view.queryByText("Temporary journal read failure"),savedVisible:!!view.queryByText(/Saved transcript —/)}));
  expect(view.queryByText("Temporary journal read failure")).toBeNull();
  expect(view.getByText(/Saved transcript —/)).toBeTruthy();
 });
 it("V15 notices: a previous connection's error notice is cleared by a new welcome",async()=>{
  const view=await mountConversation();
  await act(async()=>{socket!.onFrame?.({t:"event",event:{type:"notice",level:"error",message:"Old connection error"}} as HostFrame,0);});
  const before=!!view.queryByText("Old connection error");
  expect(before).toBe(true);
  await act(async()=>{socket!.onClose?.("lost",true);socket!.onOpen?.();socket!.onFrame?.(welcome(),0);});
  console.log("AUDIT15 notice welcome",JSON.stringify({before,after:!!view.queryByText("Old connection error")}));
  expect(view.queryByText("Old connection error")).toBeNull();
 });
});
