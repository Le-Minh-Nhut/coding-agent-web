// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
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

const welcome: HostFrame = {
  t: "welcome",
  proto: 3,
  header: { type: "session", id: "s1", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming: true, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [],
  entryCount: 0,
};

/** Render a live conversation whose socket refuses every send. */
async function renderWithSend(send: (frame: GuestFrame) => Promise<boolean>) {
  let socket: CollabSocket | null = null;
  vi.spyOn(CollabSocket.prototype, "send").mockImplementation(send);
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  await act(async () => {
    render(<ConversationView conversationId="c-1" onBack={() => {}} />);
  });
  await act(async () => {
    socket?.onFrame?.(welcome, 0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getConversation).mockResolvedValue({
    ok: true,
    data: {
      id: "c-1", projectId: "p-1", nativeSessionId: null, nativeSessionPath: null, title: "Test", model: "gpt-4",
      ownership: "managed", state: "running", tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null,
      tmuxPanePid: null, hostInstanceId: null, hostGeneration: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), lastActivityAt: null, statusDetail: null,
    },
  });
  vi.mocked(api.getAttachInstructions).mockResolvedValue({
    ok: true,
    data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null },
  });
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const stopFailure = () => screen.queryAllByText(/stop was not sent/i);

describe("F10 stop delivery", () => {
  it("tells the user when the stop was not sent", async () => {
    await renderWithSend(async () => false);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    });
    expect(stopFailure().length).toBe(1);
    expect(stopFailure()[0]!.textContent).toMatch(/agent may still be running/i);
  });

  it("tells the user when the stop send rejects", async () => {
    await renderWithSend(async () => {
      throw new Error("socket closed");
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    });
    expect(stopFailure().length).toBe(1);
  });

  it("reports nothing when the stop was delivered", async () => {
    await renderWithSend(async () => true);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    });
    expect(stopFailure().length).toBe(0);
  });
});
