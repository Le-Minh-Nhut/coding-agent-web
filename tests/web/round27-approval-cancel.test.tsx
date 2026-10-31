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

let sentFrames: GuestFrame[] = [];
let socket: CollabSocket | null = null;

async function mount() {
  vi.spyOn(CollabSocket.prototype, "send").mockImplementation(async (frame: GuestFrame) => {
    sentFrames.push(frame);
    return true;
  });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  await act(async () => {
    render(<ConversationView conversationId="c-1" onBack={() => {}} />);
  });
  const welcome: HostFrame = {
    t: "welcome",
    proto: 3,
    header: { type: "session", id: "s1", cwd: "/", timestamp: new Date().toISOString() },
    state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
    agents: [],
    entryCount: 0,
  };
  await act(async () => {
    socket?.onFrame?.(welcome, 0);
  });
}

const emitRequest = async (request: {
  reqId: number;
  kind: "select" | "editor";
  title: string;
  options?: Array<string | { label: string; description?: string }>;
  prefill?: string;
}) => {
  await act(async () => {
    socket?.onFrame?.({ t: "ui-request", request } as HostFrame, 0);
  });
};

beforeEach(() => {
  sentFrames = [];
  socket = null;
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

const responses = () => sentFrames.filter((frame) => frame.t === "ui-response");

describe("F03 approval cancel", () => {
  it("offers Cancel on a select approval and sends it with no value, never an option label", async () => {
    await mount();
    await emitRequest({ reqId: 401, kind: "select", title: "Allow write?", options: ["Approve Once", "Deny"] });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    await act(async () => {
      fireEvent.click(cancel);
    });
    expect(responses()).toHaveLength(1);
    // `value` is absent on the wire, which is exactly what Cancel means: the JSON
    // the socket seals must not carry a value key at all (an empty string would be
    // read by the host as an answer).
    expect(JSON.stringify(responses()[0])).toBe('{"t":"ui-response","reqId":401}');
  });

  it("offers Cancel on an editor approval and sends it with no value", async () => {
    await mount();
    await emitRequest({ reqId: 402, kind: "editor", title: "Explain the change", prefill: "because" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(responses()).toHaveLength(1);
    // The prefilled text was never submitted as the answer.
    expect(JSON.stringify(responses()[0])).toBe('{"t":"ui-response","reqId":402}');
  });

  it("keeps a refused cancel visible as an open request", async () => {
    await mount();
    await emitRequest({ reqId: 403, kind: "select", title: "Allow read?", options: ["Allow"] });
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });
    expect(screen.getByText("Allow read?")).not.toBeNull();
    const alerts = [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? '');
    expect(alerts.join(' | ')).toMatch(/approval response not sent/i);
  });
});
