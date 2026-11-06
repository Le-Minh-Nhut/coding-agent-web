// @vitest-environment jsdom
/**
 * The arguments a live tool call carried must survive the app's OWN projection.
 *
 * `tests/web/tool-activity.test.ts` hand-builds rows shaped exactly as
 * `argumentsFor` wants them, so it cannot see a projection that drops a field on
 * the way in. This file goes through `ConversationView`, which is what actually
 * renders: the reducer sets `toolArgs` on the transcript message, the component
 * projects it into `DisplayMessage`, and only then does the guest body render it.
 *
 * Two links in that chain were broken and are pinned here:
 *   1. the `DisplayMessage` projection did not carry `toolArgs` at all;
 *   2. `tool_execution_end` replaced the row wholesale, discarding the args the
 *      start event had captured — which is exactly when the user opens the row.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CollabSocket, type HostFrame } from "@caw/collab-protocol";
import { api } from "../../apps/web/src/api.js";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversationEvents: vi.fn(async () => ({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } })),
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    getConversationHistory: vi.fn(),
    getModels: vi.fn(),
  },
}));

let socket: CollabSocket | null = null;

class RecordingWebSocket {
  readyState = 0;
  binaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
  }
  send(): void { /* frames are inspected through the socket mock */ }
  close(): void { this.readyState = 3; }
}

const welcome = (): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "session", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
});

async function mountConversation() {
  socket = null;
  vi.spyOn(CollabSocket.prototype, "send").mockImplementation(() => Promise.resolve(true));
  vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
    socket = this;
    this.onOpen?.();
  });
  const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  await act(async () => { socket?.onFrame?.(welcome()); });
  return view;
}

const send = async (event: unknown) => {
  await act(async () => { socket?.onFrame?.({ t: "event", event } as never); });
};

describe("live tool arguments survive the projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getConversationEvents).mockResolvedValue({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: RecordingWebSocket as unknown as typeof WebSocket });
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: {
      id: "c-1", projectId: "p-1", nativeSessionId: null, nativeSessionPath: null, title: "Test", model: "model",
      ownership: "managed", state: "idle", tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null,
      tmuxPanePid: null, hostInstanceId: null, hostGeneration: null, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), lastActivityAt: null, statusDetail: null, modelPreference: "model-a",
    } });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
    vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: ["model-a"], source: "omp", reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); socket = null; });

  /** Open the tool row and return the rendered body's text. */
  const openBody = async (view: { container: HTMLElement }): Promise<string> => {
    const group = view.container.querySelector(".activity-group-head") as HTMLElement;
    await act(async () => { fireEvent.click(group); });
    const row = view.container.querySelector(".tool-row-head") as HTMLElement;
    await act(async () => { fireEvent.click(row); });
    return view.container.querySelector(".tool-body")?.textContent ?? "";
  };

  // `bash`'s guest body renders `args.command` from the row's arguments, so it is
  // the surface that proves the ARGUMENTS arrived. The body only renders for a
  // structured result (`ToollResultLike`), so a completed call must carry one —
  // otherwise the raw-text fallback renders the JSON and would pass without the fix.
  const COMMAND = "pnpm vitest run ARGS_SENTINEL";
  const structuredResult = { content: [{ type: "text", text: "OUTPUT_SENTINEL" }], details: { exitCode: 0 } };

  it("shows a running call's args in its collapsed summary line", async () => {
    // The strongest live-path check: the summary is rendered from the row's
    // arguments with no expansion at all, so it fails if either the projection or
    // the start event's `toolArgs` is missing.
    const view = await mountConversation();
    await send({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: COMMAND } });

    // Expand the GROUP only: the row stays collapsed, so its summary line — which
    // the guest renders from the row's arguments — is what has to carry them.
    const group = view.container.querySelector(".activity-group-head") as HTMLElement;
    await act(async () => { fireEvent.click(group); });
    const summary = view.container.querySelector(".tool-row-sum")?.textContent ?? "";
    expect(summary).toContain("ARGS_SENTINEL");
  });

  it("still shows those args after the call finishes", async () => {
    // The end event carries no `args`; before the fix it replaced the row and the
    // arguments vanished at exactly the moment the row becomes worth opening.
    const view = await mountConversation();
    await send({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: COMMAND } });
    await send({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: structuredResult });

    const body = await openBody(view);
    expect(body).toContain("ARGS_SENTINEL");
  });

  it("does not invent args when the start event carried none", async () => {
    const view = await mountConversation();
    await send({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: structuredResult });

    const body = await openBody(view);
    expect(body).not.toContain("ARGS_SENTINEL");
  });
});
