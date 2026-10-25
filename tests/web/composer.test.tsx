// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";
import { CollabSocket } from "@caw/collab-protocol";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
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

  it("disables during flight and produces exactly one idempotency key per submit", async () => {
    const sentFrames: unknown[] = [];
    const socketSendSpy = vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => {
      sentFrames.push(frame);
    });

    const uuidSpy = vi.spyOn(crypto, "randomUUID");

    let containerEl: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      containerEl = container;
    });

    // Simulate socket onOpen to make status idle
    const textarea = containerEl?.querySelector("textarea") as HTMLTextAreaElement;
    const sendButton = containerEl?.querySelector('button[type="submit"]') as HTMLButtonElement;

    expect(textarea).not.toBeNull();
    expect(sendButton).not.toBeNull();

    // Type prompt
    fireEvent.change(textarea, { target: { value: "Please refactor the auth service" } });
    expect(textarea.value).toBe("Please refactor the auth service");

    // Clear frame history before prompt
    const initialUuidCallCount = uuidSpy.mock.calls.length;

    // Submit form
    act(() => {
      fireEvent.click(sendButton);
    });

    // Assert: Exactly one randomUUID generated for this submit
    expect(uuidSpy.mock.calls.length).toBe(initialUuidCallCount + 1);
    const generatedKey = uuidSpy.mock.results[initialUuidCallCount]?.value;

    // Assert: Input and button are now disabled during flight
    expect(textarea.disabled).toBe(true);
    expect(sendButton.disabled).toBe(true);

    // Attempt second click (double-tap prevention)
    act(() => {
      fireEvent.click(sendButton);
    });

    // Assert: No additional UUID generated
    expect(uuidSpy.mock.calls.length).toBe(initialUuidCallCount + 1);

    // Verify sent prompt frame
    const promptFrame = sentFrames.find(
      (f): f is { t: string; text: string; idempotencyKey: string } =>
        Boolean(f && typeof f === "object" && "t" in f && (f as { t: string }).t === "prompt")
    );

    expect(promptFrame).toBeDefined();
    expect(promptFrame?.text).toBe("Please refactor the auth service");
    expect(promptFrame?.idempotencyKey).toBe(generatedKey);

    socketSendSpy.mockRestore();
    uuidSpy.mockRestore();
  });
});
