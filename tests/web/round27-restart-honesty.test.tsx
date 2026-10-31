// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";
import { CollabSocket, type HostFrame } from "@caw/collab-protocol";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    setConversationModel: vi.fn(),
    restartConversation: vi.fn(),
    getConversationHistory: vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } }),
    getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }),
  },
}));

const base = {
  id: "c-1",
  projectId: "p-1",
  nativeSessionId: "native-A",
  nativeSessionPath: "/work/journal",
  title: "Test",
  model: "model-a",
  modelPreference: "model-a",
  ownership: "managed",
  state: "running",
  tmuxSessionId: "$1",
  tmuxSessionName: "caw-c1",
  tmuxServerIdentity: "private-socket:1",
  tmuxPanePid: 1002,
  hostInstanceId: null,
  hostGeneration: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lastActivityAt: null,
  statusDetail: null,
};

const welcome: HostFrame = {
  t: "welcome",
  proto: 3,
  header: { type: "session", id: "native-A", cwd: "/work", timestamp: new Date().toISOString() },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] },
  agents: [],
  entryCount: 0,
};

let socket: CollabSocket | null = null;

/** Restart with the server's own answer, and let the post-restart socket deliver (or not) a welcome. */
async function restartWith(returnedState: string, deliverWelcome: boolean) {
  vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...base } as never });
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
  vi.mocked(api.setConversationModel).mockResolvedValue({ ok: true, data: { ...base } as never });
  vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: { ...base, state: returnedState } as never });
  vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
    if (deliverWelcome) this.onFrame?.(welcome, 0);
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => {
    render(<ConversationView conversationId="c-1" onBack={() => {}} />);
  });
  fireEvent.click(await screen.findByText("Conversation model settings"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save & restart agent" }));
  });
}

beforeEach(() => {
  socket = null;
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const modelStatus = () => {
  const section = document.querySelector('.model-controls');
  return [...(section?.querySelectorAll('[role="status"]') ?? [])].map((el) => el.textContent ?? '').join(' | ');
};

describe("F01 restart honesty", () => {
  it("claims a restart only when the returned conversation is live", async () => {
    await restartWith("idle", true);
    await waitFor(() => expect(modelStatus()).toContain("Agent restarted."));
  });

  it("does not claim a restart that only reached starting, and says so", async () => {
    await restartWith("starting", false);
    await waitFor(() => expect(modelStatus()).toContain("has not come up"));
    expect(modelStatus()).not.toContain("Agent restarted.");
    expect(modelStatus()).toContain("starting");
  });

  it("does not claim a restart the registry never confirmed", async () => {
    await restartWith("unknown", false);
    await waitFor(() => expect(modelStatus()).toContain("has not come up"));
    expect(modelStatus()).not.toContain("Agent restarted.");
  });

  it("reports a restart as done when the returned state is starting but the host answers live", async () => {
    await restartWith("starting", true);
    await waitFor(() => expect(modelStatus()).toContain("Agent restarted."));
  });
});
