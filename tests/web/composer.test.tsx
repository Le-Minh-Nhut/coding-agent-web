// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { autosizeComposer, ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";
import { CollabSocket, type GuestFrame, type HostFrame } from "@caw/collab-protocol";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    getConversationHistory: vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } }),
    getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }),
  },
}));

describe("Composer behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getConversation).mockResolvedValue({
      ok: true,
      data: {
        id: "c-1",
        projectId: "p-1",
        nativeSessionId: null,
        nativeSessionPath: null,
        title: "Test",
        model: "gpt-4",
        ownership: "managed",
        state: "idle",
        tmuxSessionId: null,
        tmuxSessionName: null, tmuxServerIdentity: null, tmuxPanePid: null,
        hostInstanceId: null,
        hostGeneration: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastActivityAt: null,
        statusDetail: null,
      },
    });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({
      ok: true,
      data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null },
    });
    // Valid link
    vi.mocked(api.getConversationLink).mockResolvedValue({
      ok: true,
      data: {
        url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        access: "full",
        instanceId: "inst-1",
        generation: 1,
      },
    });
  });

  it("sends one prompt per draft, including follow-up while running", async () => {
    const sentFrames: GuestFrame[] = [];
    const sendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => { sentFrames.push(frame); return Promise.resolve(true); });
    let activeSocket: CollabSocket | null = null;
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
      activeSocket = this;
      this.onOpen?.();
    });
    let container: HTMLElement | null = null;
    await act(async () => { container = render(<ConversationView conversationId="c-1" onBack={() => {}} />).container; });
    const textarea = container!.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    const send = container!.querySelector('button[type="submit"]') as HTMLButtonElement;
    const welcome: HostFrame = {
      t: "welcome", proto: 3,
      header: { type: "session", id: "s1", cwd: "/", timestamp: new Date().toISOString() },
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] }, agents: [], entryCount: 0,
    };
    await act(async () => { activeSocket?.onFrame?.(welcome); });
    fireEvent.change(textarea, { target: { value: "first" } });
    act(() => { fireEvent.click(send); fireEvent.click(send); });
    expect(sentFrames.filter((frame) => frame.t === "prompt")).toEqual([{ t: "prompt", text: "first" }]);
    expect(container!.textContent).toContain("first");
    await act(async () => { activeSocket?.onFrame?.({ t: "state", state: { ...welcome.state, isStreaming: true } }); });
    fireEvent.change(textarea, { target: { value: "follow-up" } });
    act(() => { fireEvent.click(send); fireEvent.click(send); });
    const prompts = sentFrames.filter((frame) => frame.t === "prompt");
    expect(prompts).toEqual([{ t: "prompt", text: "first" }, { t: "prompt", text: "follow-up" }]);
    expect(container!.textContent).toContain("follow-up");
    expect(prompts.every((frame) => !("idempotencyKey" in frame))).toBe(true);
    sendSpy.mockRestore();
  });
});
