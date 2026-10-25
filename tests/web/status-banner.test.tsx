// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
  },
}));

const mockGetConversation = vi.mocked(api.getConversation);
const mockGetAttachInstructions = vi.mocked(api.getAttachInstructions);
const mockGetConversationLink = vi.mocked(api.getConversationLink);

describe("Connection status banners", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockGetConversation.mockResolvedValue({
      ok: true,
      data: {
        id: "c-1",
        projectId: "p-1",
        nativeSessionId: null,
        nativeSessionPath: null,
        title: "Test Conversation",
        model: "claude-3-5",
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
    mockGetAttachInstructions.mockResolvedValue({
      ok: true,
      data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null },
    });
  });

  it("renders distinct accessible text for disconnected state", async () => {
    mockGetConversationLink.mockResolvedValue({
      ok: false,
      error: { code: "internal", message: "Failed" },
    });

    let viewContainer: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      viewContainer = container;
    });

    const banner = viewContainer?.querySelector('[role="status"]');
    expect(banner?.textContent).toContain("Disconnected — Connection lost");
    expect(banner?.textContent).not.toContain("State: unknown");
  });

  it("renders distinct accessible text for unknown / link_unavailable state", async () => {
    mockGetConversationLink.mockResolvedValue({
      ok: false,
      error: { code: "link_unavailable", message: "Unavailable" },
    });

    let viewContainer: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      viewContainer = container;
    });

    const banner = viewContainer?.querySelector('[role="status"]');
    expect(banner?.textContent).toContain("State: unknown");
    expect(banner?.textContent).toContain("Agent status cannot be determined");
    expect(banner?.textContent).not.toContain("Disconnected — Connection lost");
  });

  it("shows registry-reported model and restart guidance without a live process", async () => {
    mockGetConversationLink.mockResolvedValue({
      ok: false,
      error: { code: "link_unavailable", message: "Unavailable" },
    });
    let viewContainer: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      viewContainer = container;
    });
    expect(viewContainer?.textContent).toContain("Effective model: claude-3-5");
    expect(viewContainer?.textContent).toContain("Model changes apply on the next launch of this conversation, not immediately.");
  });
  it("renders the registry-recorded model for stopped conversations", async () => {
    mockGetConversation.mockResolvedValue({
      ok: true,
      data: {
        id: "c-1", projectId: "p-1", nativeSessionId: null, nativeSessionPath: null,
        title: "Stopped", model: "recorded-model", modelPreference: null, ownership: "managed",
        state: "stopped", tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null,
        tmuxPanePid: null, hostInstanceId: null, hostGeneration: null, createdAt: "", updatedAt: "",
        lastActivityAt: null, statusDetail: null,
      },
    });
    mockGetConversationLink.mockResolvedValue({ ok: false, error: { code: "link_unavailable", message: "Unavailable" } });
    let viewContainer: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      viewContainer = container;
    });
    expect(viewContainer?.textContent).toContain("Effective model: recorded-model");
    expect(viewContainer?.textContent).toContain("Model changes apply on the next launch of this conversation, not immediately.");
  });
});
