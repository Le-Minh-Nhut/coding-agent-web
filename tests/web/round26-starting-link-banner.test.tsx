// @vitest-environment jsdom
// V26: the live collab link outranks the record's stale `starting` state.
//
// GET /api/conversations/:id refreshes a seeded/idle conversation through
// evaluateState, which reports "starting" for a conversation that has never
// launched (no native session, no tmux) even while a collab host is connected and
// idle. The record is the app-side process verdict; `status` is the live link. The
// UI must let the link win, or two live regions contradict each other.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { CollabSocket, type HostFrame } from "@caw/collab-protocol";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    getConversationHistory: vi.fn(),
    getModels: vi.fn(),
  },
}));

const welcome = (): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "session", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
});

let socket: CollabSocket | null = null;
afterEach(() => { cleanup(); vi.restoreAllMocks(); socket = null; });

async function mount(recordState: "starting" | "idle", publishWelcome: boolean) {
  socket = null;
  vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: {
    id: "c-1", projectId: "p-1", nativeSessionId: null, nativeSessionPath: null, title: "Chat",
    model: null, ownership: "managed", state: recordState, tmuxSessionId: null, tmuxSessionName: null,
    tmuxServerIdentity: null, tmuxPanePid: null, hostInstanceId: null, hostGeneration: null,
    createdAt: "", updatedAt: "", lastActivityAt: null, statusDetail: null, modelPreference: null,
  } as never });
  vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } });
  vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
  vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    if (publishWelcome) this.onOpen?.();
  });
  vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
  const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  if (publishWelcome) await act(async () => { socket?.onFrame?.(welcome(), 0); });
  return view;
}

describe("V26 starting record vs live link", () => {
  it("a connected idle link shows no second status row — the header carries it", async () => {
    // R51: the idle banner said the same thing as the header's `● idle` and cost
    // a full-width row on a phone. The claim under test is unchanged — a healthy
    // link must never show the record's startup warning — but the healthy case is
    // now silence in the banner area plus the header's single status line.
    const view = await mount("starting", true);
    expect(view.queryByText("Host is starting up; prompting may be refused.")).toBeNull();
    expect(view.queryByText("Connected — no turn in flight")).toBeNull();
    // The header is where the state now lives, exactly once.
    const header = view.container.querySelector(".header-status");
    expect(header).not.toBeNull();
    expect(header!.textContent).toBe("idle");
    // R57: the empty state is now a deliberate card rather than two grey
    // paragraphs. The claim is unchanged — a healthy idle link shows the neutral
    // empty state and never the record's startup warning.
    expect(await screen.findByText("Start the conversation")).toBeTruthy();
    expect(view.queryByText("The host is starting up")).toBeNull();
  });

  it("while the link is still connecting the startup warning is the honest row", async () => {
    const view = await mount("starting", false);
    expect(await screen.findByText("Host is starting up; prompting may be refused.")).toBeTruthy();
    expect(view.queryByText("Connected — no turn in flight")).toBeNull();
    // The empty-transcript copy switches back to the warning too.
    expect(await screen.findByText("The host is starting up")).toBeTruthy();
    expect(screen.queryByText("Start the conversation")).toBeNull();
    // A link that is not healthy must show its own state, not the record's idle.
    expect(view.container.querySelector(".header-status")!.textContent).toBe("connecting");
  });

  it("an idle record with no live link never claims a connection", async () => {
    const view = await mount("idle", false);
    expect(view.queryByText("Connected — no turn in flight")).toBeNull();
    expect(view.queryByText("Connected to this conversation's agent.")).toBeNull();
  });

  it("a running turn outranks the record's startup warning too", async () => {
    const view = await mount("starting", true);
    await act(async () => { socket?.onFrame?.({ t: "state", state: { isStreaming: true, queuedMessageCount: 0, cwd: "/", participants: [] } } as HostFrame, 0); });
    // R51: the running state is the header's status line now, not a banner row —
    // the same single representation the idle case uses. The claim is unchanged:
    // a live turn must never be reported as a stale startup warning.
    await waitFor(() => expect(view.container.querySelector(".header-status")!.textContent).toBe("running"));
    expect(view.queryByText("Host is starting up; prompting may be refused.")).toBeNull();
    expect(view.queryByText("Agent is working on a turn")).toBeNull();
  });
});
