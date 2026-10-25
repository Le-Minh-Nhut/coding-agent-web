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

  it("renders the question of a crafted ui-request frame", async () => {
    const { container } = await mountView();

    const requestFrame: HostFrame = {
      t: "ui-request",
      request: {
        reqId: 101,
        type: "select",
        prompt: "Execute bash command 'rm -rf /tmp/scratch'?",
        options: ["approve", "reject"],
      },
    };

    emitFrame(requestFrame);

    expect(container.textContent).toContain("Approval Requested");
    expect(container.textContent).toContain("Execute bash command 'rm -rf /tmp/scratch'?");
  });

  it("queues a second simultaneous ui-request instead of dropping it", async () => {
    const { container } = await mountView();

    const frame1: HostFrame = {
      t: "ui-request",
      request: {
        reqId: 201,
        type: "select",
        prompt: "First Question: Allow file write?",
        options: ["approve", "reject"],
      },
    };
    const frame2: HostFrame = {
      t: "ui-request",
      request: {
        reqId: 202,
        type: "select",
        prompt: "Second Question: Allow network connect?",
        options: ["approve", "reject"],
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
        type: "select",
        prompt: "Allow database migration?",
        options: ["approve", "reject"],
      },
    });

    const approveButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Approve"
    );
    expect(approveButtons.length).toBeGreaterThan(0);
    const approveBtn = approveButtons[0]!;

    // Tap Approve twice rapidly (double tap simulation)
    act(() => {
      fireEvent.click(approveBtn);
      fireEvent.click(approveBtn);
    });

    // Exactly one ui-response frame must be sent for reqId 301
    const responses = sentFrames.filter(
      (f): f is { t: "ui-response"; reqId: number; value?: string } =>
        f.t === "ui-response" && f.reqId === 301
    );
    expect(responses.length).toBe(1);
    expect(responses[0]).toEqual({
      t: "ui-response",
      reqId: 301,
      value: "approve",
    });
  });

  it("advances to the next queued request when current one is answered or ended", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 401,
        type: "select",
        prompt: "Question 1",
        options: ["yes", "no"],
      },
    });
    emitFrame({
      t: "ui-request",
      request: {
        reqId: 402,
        type: "select",
        prompt: "Question 2",
        options: ["yes", "no"],
      },
    });

    expect(container.textContent).toContain("Question 1");
    expect(container.textContent).toContain("+1 queued");

    // Answer Question 1
    const approveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Approve"
    );
    act(() => {
      fireEvent.click(approveBtn!);
    });

    // Question 2 advances to the front!
    expect(container.textContent).toContain("Question 2");
    expect(container.textContent).not.toContain("+1 queued");

    // Now end Question 2 from host via ui-request-end
    emitFrame({
      t: "ui-request-end",
      reqId: 402,
    });

    // Question 2 is cleared, showing honest timeout status
    expect(container.textContent).not.toContain("Question 2");
    expect(container.textContent).toContain("Previous approval request timed out");
  });

  it("removes a queued request when ui-request-end arrives for it without disturbing current", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 501,
        type: "select",
        prompt: "Active Question 501",
        options: ["ok"],
      },
    });
    emitFrame({
      t: "ui-request",
      request: {
        reqId: 502,
        type: "select",
        prompt: "Queued Question 502",
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
    const approveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Approve"
    );
    act(() => {
      fireEvent.click(approveBtn!);
    });
    expect(container.textContent).not.toContain("Approval Requested");
  });

  it("makes answering after settling impossible (for both timed-out and answered requests)", async () => {
    const { container } = await mountView();

    emitFrame({
      t: "ui-request",
      request: {
        reqId: 601,
        type: "select",
        prompt: "Question 601 to be timed out",
        options: ["approve"],
      },
    });

    // Grab the approve button while it is showing
    const approveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Approve"
    );
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
