// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";
import { MUTATION_CANCELLED } from "../../apps/web/src/mutation-order.js";
import { CollabSocket, type HostFrame } from "@caw/collab-protocol";
import { openModelSheet, openModelSheetWhenReady } from "./model-sheet.js";

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
  await openModelSheetWhenReady();
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
  it("saves the submitted model before a mounted restart", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...base } as never });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "inst-1", generation: 1 } });
    vi.mocked(api.setConversationModel).mockResolvedValue({ ok: true, data: { ...base, modelPreference: "model-b" } as never });
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: { ...base, modelPreference: "model-b", state: "running" } } as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await openModelSheetWhenReady();
    fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "model-b" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save & restart agent" })); });
    expect(api.setConversationModel).toHaveBeenCalledWith("c-1", "model-b");
    expect(api.restartConversation).toHaveBeenCalledWith("c-1");
  });
  it("still restarts with the saved draft when Back unmounts during the save", async () => {
    let resolveSave!: (value: unknown) => void;
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...base } as never });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({
      ok: true,
      data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null },
    });
    vi.mocked(api.getConversationLink).mockResolvedValue({
      ok: true,
      data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "inst-1", generation: 1 },
    });
    vi.mocked(api.setConversationModel).mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }) as never);
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: { ...base, modelPreference: "model-b", state: "starting" } as never });
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await openModelSheetWhenReady();
    const input = screen.getByLabelText("Custom model ID");
    fireEvent.change(input, { target: { value: "model-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & restart agent" }));
    view.unmount();
    await act(async () => { resolveSave({ ok: true, data: { ...base, modelPreference: "model-b" } }); });
    expect(api.setConversationModel).toHaveBeenCalledWith("c-1", "model-b");
    expect(api.restartConversation).toHaveBeenCalledWith("c-1");
  });
  it("does not restart when saving the model fails", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...base } as never });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "inst-1", generation: 1 } });
    vi.mocked(api.setConversationModel).mockResolvedValue({ ok: false, error: { code: "internal", message: "Save refused" } } as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await openModelSheetWhenReady();
    fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "model-b" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save & restart agent" })); });
    expect(api.restartConversation).not.toHaveBeenCalled();
    expect(modelStatus()).toContain("Save refused");
  });

  it("restarts after a conversation change without publishing old metadata", async () => {
    let resolveSave!: (value: unknown) => void;
    vi.mocked(api.getConversation).mockImplementation(async (id) => ({ ok: true, data: { ...base, id, title: id } as never }));
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "inst-1", generation: 1 } });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.setConversationModel).mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }) as never);
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: { ...base, modelPreference: "model-b", state: "starting" } } as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await openModelSheetWhenReady();
    fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "model-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & restart agent" }));
    view.rerender(<ConversationView conversationId="c-2" onBack={() => {}} />);
    await act(async () => { resolveSave({ ok: true, data: { ...base, modelPreference: "OLD_CONVERSATION_PREFERENCE" } }); });
    expect(api.restartConversation).toHaveBeenCalledWith("c-1");
    expect(await screen.findByRole("heading", { name: "c-2" })).toBeTruthy();
    expect(screen.queryByText("OLD_CONVERSATION_PREFERENCE")).toBeNull();
  });
  it("does not restart when the save was retired at the auth boundary", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...base } as never });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "inst-1", generation: 1 } });
    vi.mocked(api.setConversationModel).mockResolvedValue(MUTATION_CANCELLED as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await openModelSheetWhenReady();
    fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "model-b" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save & restart agent" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save & restart agent" })); });
    expect(api.restartConversation).not.toHaveBeenCalled();
  });
  it("reports a restart failure after the model save", async () => {
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { ...base } as never });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "inst-1", generation: 1 } });
    vi.mocked(api.setConversationModel).mockResolvedValue({ ok: true, data: { ...base, modelPreference: "model-a" } as never });
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: false, error: { code: "internal", message: "Restart refused" } } as never);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    openModelSheet();
    fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "model-b" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save & restart agent" }) as HTMLButtonElement).disabled).toBe(false));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save & restart agent" })); });
    expect(api.restartConversation).toHaveBeenCalledWith("c-1");
    expect(modelStatus()).toContain("Restart refused");
  });
});
