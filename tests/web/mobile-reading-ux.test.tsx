// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CollabSocket, type GuestFrame, type HostFrame } from "@caw/collab-protocol";
import { api } from "../../apps/web/src/api.js";
import { ConversationView, autosizeComposer } from "../../apps/web/src/components/ConversationView.js";
import { MarkdownCodeBlock, renderMarkdown } from "../../apps/web/src/sanitize.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: { getConversation: vi.fn(), getAttachInstructions: vi.fn(), getConversationLink: vi.fn() },
}));

let socket: CollabSocket | null = null;
let sent: GuestFrame[] = [];
let spy: ReturnType<typeof vi.spyOn> | null = null;

const welcome = (isStreaming = false): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "session", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
});

async function mountConversation(initiallyRunning = false) {
  sent = [];
  socket = null;
  spy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => { sent.push(frame); return Promise.resolve(true); });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
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
      updatedAt: new Date().toISOString(), lastActivityAt: null, statusDetail: null,
    } });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
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