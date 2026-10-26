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
  api: { getConversation: vi.fn(), getAttachInstructions: vi.fn(), getConversationLink: vi.fn(), getConversationHistory: vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } }), getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }) },
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
  it("sends the parsed write token in actual hello frames only for full links", async () => {
    const previousCrypto = globalThis.crypto;
    const previousWebSocket = globalThis.WebSocket;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: RecordingWebSocket as unknown as typeof WebSocket });
    const roomKey = new Uint8Array(32).fill(1);
    const writeToken = new Uint8Array(16).fill(2);
    const { key } = await importRoomKey(roomKey);

    const helloFor = async (secret: Uint8Array): Promise<GuestFrame> => {
      RecordingWebSocket.instances = [];
      vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: {
        url: `ws://127.0.0.1:7466/r/0123456789abcdef.${encodeBase64Url(secret)}`,
        access: secret.byteLength === 48 ? "full" : "view",
        instanceId: "i",
        generation: 1,
      } });
      const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      try {
        await waitFor(() => expect(RecordingWebSocket.instances[0]?.sent).toHaveLength(1));
        const envelope = unpackEnvelope(RecordingWebSocket.instances[0]!.sent[0]!);
        expect(envelope).not.toBeNull();
        return await open<GuestFrame>(key, envelope!.payload);
      } finally {
        view.unmount();
      }
    };

    try {
      const fullSecret = new Uint8Array(48);
      fullSecret.set(roomKey);
      fullSecret.set(writeToken, 32);
      expect(encodeBase64Url(fullSecret)).toHaveLength(64);
      expect(await helloFor(fullSecret)).toEqual({
        t: "hello", proto: 3, name: "Mobile Web Controller", writeToken: encodeBase64Url(writeToken),
      });
      expect(encodeBase64Url(roomKey)).toHaveLength(43);
      expect(await helloFor(roomKey)).toEqual({ t: "hello", proto: 3, name: "Mobile Web Controller" });
    } finally {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: previousCrypto });
      Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: previousWebSocket });
    }
  });

  afterEach(() => {
    cleanup();
    spy?.mockRestore();
    vi.restoreAllMocks();
    socket = null;
  });

  it("preserves reader position while detached, follows near tail, and Latest returns to tail", async () => {
    const { container } = await mountConversation();
    const scroller = container.querySelector(".messages-scroll") as HTMLDivElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    const entry = (id: string): HostFrame => ({ t: "entry", entry: { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: id, timestamp: Date.now() } } });
    await act(async () => { socket?.onFrame?.(entry("older-reader")); });
    expect(scroller.scrollTop).toBe(300);
    const latest = container.querySelector(".latest-button") as HTMLButtonElement;
    expect(latest).not.toBeNull();
    fireEvent.click(latest);
    expect(scroller.scrollTop).toBe(800);
    scroller.scrollTop = 1175;
    fireEvent.scroll(scroller);
    await act(async () => { socket?.onFrame?.(entry("near-tail")); });
    expect(scroller.scrollTop).toBe(800);
  });

  it("groups markdown paragraphs, lists, tables, and keeps raw markup inert", () => {
    const { container } = render(renderMarkdown("First line\ncontinued.\n\nNext paragraph.\n\n- one\n- two\n\n| Name | Value |\n| --- | --- |\n| alpha | beta |\n\n<img src=x onerror=alert(1)>"));
    expect(container.querySelectorAll("p")).toHaveLength(3);
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll(".markdown-table-scroll table tbody td")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("copies code and reports rejected clipboard writes", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const success = render(<MarkdownCodeBlock code="  const x = 1;" language="ts" />);
    expect(success.getByText("ts")).toBeTruthy();
    fireEvent.click(success.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(success.getByRole("button", { name: "Copy code" }).textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("  const x = 1;");
    success.unmount();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const failure = render(<MarkdownCodeBlock code="secret" language="js" />);
    fireEvent.click(failure.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(failure.getByRole("button", { name: "Copy code" }).textContent).toBe("Copy failed"));
  });

  it("grows composer to 140px cap and enables internal scroll beyond it", () => {
    const textarea = document.createElement("textarea");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 96 });
    autosizeComposer(textarea);
    expect(textarea.style.height).toBe("96px");
    expect(textarea.style.overflowY).toBe("hidden");
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 300 });
    autosizeComposer(textarea);
    expect(textarea.style.height).toBe("140px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("ignores Enter during IME composition but submits Enter outside composition", async () => {
    const { container } = await mountConversation();
    const textarea = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "composed prompt" } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(promptFrames()).toHaveLength(0);
    fireEvent.compositionEnd(textarea);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: false });
    expect(promptFrames()).toEqual([{ t: "prompt", text: "composed prompt" }]);
  });
  it("restores a prompt refused during host startup and leaves Send available for retry", async () => {
    const onDraftChange = vi.fn();
    const { container, getByRole } = await mountConversation(false, onDraftChange);
    const composer = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "retry after startup" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    await waitFor(() => expect(composer.value).toBe(""));
    expect(container.querySelector(".message-card.user")?.textContent).toContain("retry after startup");

    await act(async () => {
      socket?.onFrame?.({ t: "error", message: "prompting is unavailable until the host finishes starting up" });
    });

    expect(composer.value).toBe("retry after startup");
    expect(onDraftChange).toHaveBeenLastCalledWith("retry after startup");
    expect(container.querySelector(".message-card.user")).toBeNull();
    expect(getByRole("alert").textContent).toBe("prompting is unavailable until the host finishes starting up");
    expect((getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    expect(promptFrames()).toEqual([{ t: "prompt", text: "retry after startup" }]);
    fireEvent.click(getByRole("button", { name: "Send" }));
    await waitFor(() => expect(promptFrames()).toHaveLength(2));
  });

  it("keeps normal successful sends optimistic and preserves drafts when socket rejects send", async () => {
    const { container, getByRole } = await mountConversation();
    const composer = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "normal prompt" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    await waitFor(() => expect(container.querySelector(".message-card.user")?.textContent).toContain("normal prompt"));
    expect(composer.value).toBe("");

    spy?.mockImplementationOnce(() => Promise.resolve(false));
    fireEvent.change(composer, { target: { value: "transport rejected" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    await waitFor(() => expect(getByRole("alert").textContent).toBe("Socket did not accept prompt. Draft kept; retry when connected."));
    expect(composer.value).toBe("transport rejected");
    expect(container.querySelectorAll(".message-card.user")).toHaveLength(1);
  });


  it("intercepts known commands, offers explicit prose, and leaves unknown commands alone", async () => {
    const { container, getByRole, getByText } = await mountConversation();
    const textarea = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/compact" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(getByText("Terminal only — not sent to the live session.")).toBeTruthy();
    expect(promptFrames()).toHaveLength(0);
    fireEvent.click(getByRole("button", { name: "Send as plain text anyway" }));
    expect(promptFrames()).toEqual([{ t: "prompt", text: "/compact" }]);
    fireEvent.change(textarea, { target: { value: "/xyz" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(promptFrames()).toEqual([{ t: "prompt", text: "/compact" }, { t: "prompt", text: "/xyz" }]);
  });

  it("suggests slash commands and maps /model to existing app controls", async () => {
    const { container, getByRole, getByText } = await mountConversation();
    const textarea = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/mo" } });
    fireEvent.click(getByRole("button", { name: /\/model/ }));
    expect(textarea.value).toBe("/model");
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(getByText(/Collab does not dispatch slash commands/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Open model controls" }));
    expect((container.querySelector(".model-controls-disclosure") as HTMLDetailsElement).open).toBe(true);
    expect(promptFrames()).toHaveLength(0);
  });
  it("keeps prompts, approvals, and abort unavailable in read-only and restores controls", async () => {
    const { container, getByRole, queryByRole, getByText } = await mountConversation();
    await act(async () => { socket?.onFrame?.(welcome(true, true)); });

    expect(getByText(/Read-only view/)).toBeTruthy();
    const composer = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "not sent" } });
    expect(composer.disabled).toBe(true);
    expect(getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(composer.placeholder).toBe("Read-only — not sent");
    await act(async () => { socket?.onFrame?.({ t: "ui-request", request: { reqId: 91, kind: "select", title: "Approve action?", options: ["Approve"] } }); });
    expect(getByText("Approve action?")).toBeTruthy();
    expect(getByText("Read-only link — this request cannot be answered here.")).toBeTruthy();
    expect(queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(queryByRole("button", { name: "Stop" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(sent.some((frame) => frame.t === "prompt" || frame.t === "ui-response" || frame.t === "abort")).toBe(false);
    await act(async () => { socket?.onFrame?.({ t: "error", message: "Host refused read-only prompt" }); });
    expect(getByRole("alert").textContent).toBe("Host refused read-only prompt");
    await act(async () => { socket?.onFrame?.(welcome(true)); });
    expect(queryByRole("status", { name: /Read-only/ })).toBeNull();
    expect(getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(getByRole("button", { name: "Stop" })).toBeTruthy();
    await act(async () => { socket?.onFrame?.({ t: "ui-request", request: { reqId: 92, kind: "select", title: "Approve again?", options: ["Approve"] } }); });
    fireEvent.click(getByRole("button", { name: /Approve/ }));
    fireEvent.click(getByRole("button", { name: "Stop" }));
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(sent.some((frame) => frame.t === "prompt")).toBe(true);
    expect(sent.some((frame) => frame.t === "ui-response")).toBe(true);
    expect(sent.some((frame) => frame.t === "abort")).toBe(true);
  });
  it("shows loaded, empty, unavailable, and error model catalogs without changing saved preference", async () => {
    const cases = [
      { result: { ok: true, data: { models: ["model-a", "model-b"], source: "omp" as const, reason: null } }, message: "model-b" },
      { result: { ok: true, data: { models: [], source: "omp" as const, reason: null } }, message: "No models reported by OMP" },
      { result: { ok: true, data: { models: [], source: "unavailable" as const, reason: "OMP unavailable" } }, message: "OMP unavailable" },
      { result: { ok: false as const, error: { code: "internal" as const, message: "Catalog request failed" } }, message: "Catalog request failed" },
    ];
    for (const { result, message } of cases) {
      vi.mocked(api.getModels).mockResolvedValue(result);
      const view = await mountConversation();
      await waitFor(() => expect(view.container.textContent).toContain(message));
      expect(view.container.textContent).toContain("Preferred for next launch: model-a");
      expect(view.container.textContent).toContain("Effective model reported now: model");
      if (message === "model-b") expect(view.container.querySelector("#conversation-model option[value='model-b']")).not.toBeNull();
      view.unmount();
    }
  });
  it("shows bus failures as alerts and keeps them separate from connection status", async () => {
    const { container } = await mountConversation();
    await act(async () => {
      socket?.onFrame?.({ t: "event", event: { type: "notice", level: "warning", message: "Rate limited" } });
    });
    expect(container.querySelector(".banner.warning[role='status']")?.textContent).toBe("Rate limited");
    await act(async () => {
      socket?.onFrame?.({ t: "bus", channel: "task:subagent:progress", data: {
        index: 0, agent: "Scout", task: "inspect", progress: { id: "sub-1", status: "failed", currentTool: "bash" },
      } });
    });
    expect(container.querySelector(".banner.error[role='alert']")?.textContent).toBe("Scout: inspect (failed) · bash");
    expect(container.querySelector(".banner.disconnected")).toBeNull();
    expect(container.querySelector(".banner.idle")).not.toBeNull();
  });
  it("renders host user, assistant, and collapsed tool-result rows", async () => {
    const { container } = await mountConversation();
    const message = (id: string, message: Record<string, unknown>): HostFrame => ({
      t: "entry",
      entry: { type: "message", id, parentId: null, timestamp: new Date().toISOString(), message } as never,
    });
    await act(async () => {
      socket?.onFrame?.(message("user-row", { role: "user", content: "Read this", timestamp: Date.now() }));
      socket?.onFrame?.(message("assistant-row", {
        role: "assistant", content: [{ type: "text", text: "Answer" }], model: "provider/model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      }));
      socket?.onFrame?.(message("tool-row", {
        role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [{ type: "text", text: "command failed" }],
        isError: true, timestamp: Date.now(),
      }));
    });
    expect(container.querySelector(".message-card.user")?.textContent).toContain("Read this");
    expect(container.querySelector(".message-card.assistant")?.textContent).toContain("Answer");
    const tool = container.querySelector(".message-card.tool");
    expect(tool?.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(tool?.querySelector("summary")?.textContent).toContain("Error");
    expect(tool?.textContent).toContain("command failed");
  });


  it("renders explicit notices for host-shared image and tool-call blocks", async () => {
    const { container } = await mountConversation();
    await act(async () => {
      socket?.onFrame?.({ t: "entry", entry: {
        type: "message", id: "shared-content", parentId: null, timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Review image" },
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
            { type: "image", mimeType: "image/svg+xml", data: "PHN2Zy8+" },
            { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "pwd" }, intent: "inspect cwd" },
            { type: "text", text: "Finished" },
          ],
          model: "provider/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
          stopReason: "stop", timestamp: Date.now(),
        },
      } });
      socket?.onFrame?.({ t: "entry", entry: {
        type: "custom_message", id: "omitted", parentId: "shared-content", timestamp: new Date().toISOString(),
        customType: "collab-entry-too-large", content: "Tool output omitted by host", display: true,
      } });
    });
    expect(container.querySelector('img[alt="Attachment"]')).not.toBeNull();
    expect(container.textContent).toContain("[Image attachment not displayed (image/svg+xml)]");
    expect(container.textContent).toContain("[Tool call: bash — inspect cwd]");
    expect(container.textContent).toContain("Finished");
    expect(container.textContent).toContain("collab-entry-too-large: Tool output omitted by host");
  });

  it("keeps Latest in a dock row outside transcript scroll area", async () => {
    const { container } = await mountConversation();
    const transcript = container.querySelector(".messages-scroll")!;
    const scroller = transcript as HTMLDivElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);

    const latestRow = container.querySelector(".latest-row");
    const latest = latestRow?.querySelector(".latest-button");
    const composer = container.querySelector(".composer-container");
    expect(latest).not.toBeNull();
    expect(latest?.closest(".messages-scroll")).toBeNull();
    expect(transcript.nextElementSibling).toBe(latestRow);
    expect(latestRow?.nextElementSibling).toBe(composer);
  });


  it("keeps Latest in a dock row outside transcript scroll area", async () => {
    const { container } = await mountConversation();
    const transcript = container.querySelector(".messages-scroll") as HTMLDivElement;
    Object.defineProperty(transcript, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(transcript, "scrollHeight", { configurable: true, value: 1200 });
    transcript.scrollTop = 300;
    fireEvent.scroll(transcript);

    const latestRow = container.querySelector(".latest-row");
    expect(latestRow?.querySelector(".latest-button")).not.toBeNull();
    expect(latestRow?.closest(".messages-scroll")).toBeNull();
    expect(transcript.nextElementSibling).toBe(latestRow);
    expect(latestRow?.nextElementSibling).toBe(container.querySelector(".composer-container"));
  });
  it("hides Latest while slash suggestions or command interception is open", async () => {
    const { container, getByRole } = await mountConversation();
    const scroller = container.querySelector(".messages-scroll") as HTMLDivElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller);
    expect(container.querySelector(".latest-button")).not.toBeNull();

    const textarea = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/" } });
    expect(container.querySelector(".composer-suggestions")).not.toBeNull();
    expect(container.querySelector(".latest-button")).toBeNull();

    fireEvent.change(textarea, { target: { value: "/compact" } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(container.querySelector(".slash-command-intercept")).not.toBeNull();
    expect(container.querySelector(".latest-button")).toBeNull();
  });
});