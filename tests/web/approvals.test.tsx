// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";
import { CollabSocket, type HostFrame, type GuestFrame } from "@caw/collab-protocol";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    getConversationHistory: vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } }),
    getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }),
  },
}));

describe("Approval handling & FIFO queueing", () => {
  let activeSocket: CollabSocket | null = null;
  let sentFrames: GuestFrame[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    sentFrames = [];
    activeSocket = null;

    vi.mocked(api.getConversation).mockResolvedValue({
      ok: true,
      data: {
        id: "c-test",
        projectId: "p-test",
        nativeSessionId: null,
        nativeSessionPath: null,
        title: "Test Conversation",
        model: "omp-test",
        ownership: "managed",
        state: "idle",
        tmuxSessionId: null,
        tmuxSessionName: null,
        tmuxServerIdentity: null, tmuxPanePid: null,
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
      data: { conversationId: "c-test", available: false, command: null, tmuxSessionName: null, reason: null },
    });

    vi.mocked(api.getConversationLink).mockResolvedValue({
      ok: true,
      data: {
        url: "ws://127.0.0.1:8792/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        access: "full",
        instanceId: "inst-1",
        generation: 1,
      },
    });

    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
      activeSocket = this;
      if (this.onOpen) this.onOpen();
    });

    vi.spyOn(CollabSocket.prototype, "send").mockImplementation(function (this: CollabSocket, frame: unknown) {
      sentFrames.push(frame as GuestFrame);
      return Promise.resolve(true);
    });
  });

  async function mountView() {
    let containerEl: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-test" onBack={() => {}} />);
      containerEl = container;
    });
    return { container: containerEl! };
  }

  function emitFrame(frame: HostFrame) {
    act(() => {
      if (activeSocket?.onFrame) {
        activeSocket.onFrame(frame);
      }
    });
  }

  it("renders upstream ui-request title and supplied choices", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 101,
        kind: "select",
        title: "Execute bash command 'rm -rf /tmp/scratch'?",
        options: ["Approve Once", "Deny"],
      },
    });

    expect(container.textContent).toContain("Execute bash command 'rm -rf /tmp/scratch'?");
    expect(container.textContent).toContain("Approve Once");
    expect(container.textContent).toContain("Deny");
    const approve = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Approve Once"))!;
    const deny = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Deny"))!;
    expect(approve.className).toBe("primary");
    expect(deny.className).toBe("approval-deny");
    fireEvent.click(deny);
    expect(sentFrames.find((frame) => frame.t === "ui-response")).toEqual({ t: "ui-response", reqId: 101, value: "Deny" });
  });
  it("renders selection markers and host option descriptions", async () => {
    const { container } = await mountView();
    emitFrame({
      t: "ui-request",
      request: {
        reqId: 102,
        kind: "select",
        title: "Choose files",
        options: [{ label: "first", description: "first description" }, "second"],
        initialIndex: 1,
        selectionMarker: "checkbox",
        checkedIndices: [0],
        markableCount: 2,
        helpText: "Choose allowed files",
      },
    });
    expect(container.textContent).toContain("Choose allowed files");
    expect(container.textContent).toContain("first description");
    expect(container.textContent).toContain("Choose up to 2 options.");
    const second = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("☐ second"))!;
    expect(second.textContent).toContain("second");
    fireEvent.click(second);
    expect(sentFrames.find((frame) => frame.t === "ui-response")).toEqual({ t: "ui-response", reqId: 102, value: "second" });
  });

  it("keeps approval request visible when socket refuses response", async () => {
    const { container } = await mountView();
    emitFrame({ t: "ui-request", request: { reqId: 103, kind: "select", title: "Allow write?", options: ["Allow", "Deny"] } });
    vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(false);
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Allow"))!);
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toContain("Allow write?");
    expect(sentFrames.some((frame) => frame.t === "ui-response")).toBe(false);
  });

  it("keeps draft and reports when socket refuses a prompt send", async () => {
    vi.spyOn(CollabSocket.prototype, "send").mockImplementation(function (this: CollabSocket, frame: unknown) {
      if ((frame as GuestFrame).t === "prompt") return Promise.resolve(false);
      sentFrames.push(frame as GuestFrame);
      return Promise.resolve(true);
    });
    const { container } = await mountView();
    emitFrame({ t: "welcome", proto: 3, header: { type: "session", id: "native", cwd: "/workspace", timestamp: "2026-01-01T00:00:00Z" }, state: { isStreaming: false, queuedMessageCount: 0, cwd: "/workspace", participants: [] }, agents: [], entryCount: 0 });

    const composer = container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "keep this prompt" } });
    fireEvent.click(Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Send")!);
    await act(async () => { await Promise.resolve(); });

    expect(composer.value).toBe("keep this prompt");
    expect(container.textContent).toContain("Socket did not accept prompt. Draft kept; retry when connected.");
    expect(sentFrames.some((frame) => frame.t === "prompt")).toBe(false);
  });

  it("queues a second simultaneous ui-request instead of dropping it", async () => {
    const { container } = await mountView();

    const frame1: HostFrame = {
      t: "ui-request",
      request: {
        reqId: 201,
        kind: "select",
        title: "First Question: Allow file write?",
        options: ["Approve Once", "Deny"],
      },
    };
    const frame2: HostFrame = {
      t: "ui-request",
      request: {
        reqId: 202,
        kind: "select",
        title: "Second Question: Allow network connect?",
        options: ["Approve Once", "Deny"],
      },
    };

    emitFrame(frame1);
    expect(container.textContent).toContain("First Question: Allow file write?");
    expect(container.textContent).not.toContain("Second Question");

    // Deliver second simultaneous frame
    emitFrame(frame2);

    // First question remains visible, queued indicator appears
    expect(container.textContent).toContain("First Question: Allow file write?");
    expect(container.textContent).toContain("+1 queued");
  });

  it("sends exactly one ui-response with the right reqId on answering and latches against double taps", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 301,
        kind: "select",
        title: "Allow database migration?",
        options: ["Approve Once", "Deny"],
      },
    });

    const approveBtn = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Approve Once"));
    expect(approveBtn).toBeDefined();

    // Tap the real upstream choice twice rapidly (double tap simulation)
    act(() => {
      fireEvent.click(approveBtn!);
      fireEvent.click(approveBtn!);
    });

    const responses = sentFrames.filter(
      (f): f is { t: "ui-response"; reqId: number; value?: string } =>
        f.t === "ui-response" && f.reqId === 301
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({ t: "ui-response", reqId: 301, value: "Approve Once" });
  });

  it("advances to the next queued request when current one is answered or ended", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 401,
        kind: "select",
        title: "Question 1",
        options: ["yes", "no"],
      },
    });
    emitFrame({
      t: "ui-request",
      request: {
        reqId: 402,
        kind: "select",
        title: "Question 2",
        options: ["yes", "no"],
      },
    });

    expect(container.textContent).toContain("Question 1");
    expect(container.textContent).toContain("+1 queued");

    const approveBtn = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("yes"));
    await act(async () => {
      fireEvent.click(approveBtn!);
      await Promise.resolve();
    });

    // Now end Question 2 from host via ui-request-end
    emitFrame({
      t: "ui-request-end",
      reqId: 402,
    });

    // ui-request-end reports settlement, not a timeout.
    expect(container.textContent).not.toContain("Previous approval request timed out");
  });

  it("removes a queued request when ui-request-end arrives for it without disturbing current", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 501,
        kind: "select",
        title: "Active Question 501",
        options: ["ok"],
      },
    });
    emitFrame({
      t: "ui-request",
      request: {
        reqId: 502,
        kind: "select",
        title: "Queued Question 502",
        options: ["ok"],
      },
    });

    expect(container.textContent).toContain("Active Question 501");
    expect(container.textContent).toContain("+1 queued");

    // End the queued one (502) before 501 settles
    emitFrame({
      t: "ui-request-end",
      reqId: 502,
    });

    // Active 501 still active, but queue is now 0
    expect(container.textContent).toContain("Active Question 501");
    expect(container.textContent).not.toContain("+1 queued");

    // When 501 is answered, there is no second request to advance to
    const approveBtn = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("ok"));
    await act(async () => {
      fireEvent.click(approveBtn!);
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("Approval Requested");
  });

  it("makes answering after settling impossible (for both timed-out and answered requests)", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 601,
        kind: "select",
        title: "Question 601 to be settled",
        options: ["Approve Once", "Deny"],
      },
    });

    // Grab the approve button while it is showing
    const approveBtn = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Approve Once"));
    expect(approveBtn).toBeDefined();

    // Settle request via ui-request-end
    emitFrame({
      t: "ui-request-end",
      reqId: 601,
    });

    // Clear frames to check if click does anything
    sentFrames = [];

    // Attempt to click the button element from before settling
    act(() => {
      fireEvent.click(approveBtn!);
    });

    // Must NOT send any ui-response frames
    expect(sentFrames.filter((f) => f.t === "ui-response")).toHaveLength(0);
  });
});
