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

 it("V14 auto reconnect: an unacknowledged previous send must not consume a new refusal", async()=>{
  const view=await mountConversation();
  const input=view.container.querySelector("textarea")!;
  fireEvent.change(input,{target:{value:"old unacknowledged prompt"}});
  await act(async()=>{fireEvent.submit(input.closest("form")!);});
  expect(input.value).toBe("");
  // Same CollabSocket object automatically reconnects; no manual Retry / new link.
  await act(async()=>{socket!.onClose?.("network lost",true);socket!.onOpen?.();socket!.onFrame?.(welcome(),0);});
  fireEvent.change(input,{target:{value:"new refused prompt"}});
  await act(async()=>{fireEvent.submit(input.closest("form")!);});
  await act(async()=>{socket!.onFrame?.({t:"error",message:"prompting is unavailable until the host finishes starting up"},0);});
  console.log("AUDIT14 reconnect refusal",JSON.stringify({draft:input.value,prompts:promptFrames(),userRows:view.container.querySelectorAll(".message-card.user").length}));
  expect(input.value).toBe("new refused prompt");
 });
});
