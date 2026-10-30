// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, cleanup, waitFor } from "@testing-library/react";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    getConversationHistory: vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } }),
    getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }),
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

    const banner = viewContainer?.querySelector(".banner.disconnected");
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

    const banner = viewContainer?.querySelector(".banner.unknown");
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
    expect(viewContainer?.textContent).toContain("Effective model reported now: not reported");
    expect(viewContainer?.textContent).not.toContain("Effective model reported now: claude-3-5");
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
    expect(viewContainer?.textContent).toContain("Effective model reported now: not reported");
    expect(viewContainer?.textContent).not.toContain("Effective model reported now: recorded-model");
    expect(viewContainer?.textContent).toContain("Model changes apply on the next launch of this conversation, not immediately.");
  });
  it("renders a saved transcript, truncated note, and live-session conflict", async () => {
    mockGetConversationLink.mockResolvedValue({ ok: false, error: { code: "link_unavailable", message: "Unavailable" } });
    const history = {
      header: { sessionId: "session-1", cwd: "/work", timestamp: null, version: null, title: "Saved session" },
      entries: [{ type: "message", id: "saved-1", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "Saved prompt", timestamp: 1 } }],
      truncated: false, truncatedByBytes: false, truncatedByEntries: false, skippedOversized: false, hasOlder: false, nextCursor: null,
    };
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: true, data: history });
    let viewContainer: HTMLElement | null = null;
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      viewContainer = container;
    });
    await waitFor(() => {
      expect(viewContainer?.textContent).toContain("Saved transcript — this session is not running.");
      expect(viewContainer?.textContent).toContain("Saved prompt");
    });
    expect(viewContainer?.querySelector(".composer-container")).toBeNull();

    cleanup();
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: true, data: { ...history, truncated: true, skippedOversized: true } });
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      viewContainer = container;
    });
    await waitFor(() => {
      expect(viewContainer?.textContent).toContain("History is incomplete: a record too large to display was skipped; journal intact on disk.");
      expect(viewContainer?.textContent).toContain("Saved transcript truncated; some history is omitted.");
    });

    cleanup();
    vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "conflict_owner", message: "Live" } });
    await act(async () => {
      const { container } = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
      viewContainer = container;
    });
    // V22-01: conflict_owner means a writer is live OR unverifiable, so the UI now
    // hedges instead of asserting a live session outright.
    await waitFor(() => expect(viewContainer?.textContent).toContain("Writer status could not be verified — this session may be live. Open the live view to read it."));
    expect(viewContainer?.querySelector(".composer-container")).toBeNull();
  });
});
