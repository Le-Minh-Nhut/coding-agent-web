// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../apps/web/src/api.js";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(),
    getAttachInstructions: vi.fn(),
    getConversationLink: vi.fn(),
    getConversationHistory: vi.fn(),
    getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }),
  },
}));

const header = { sessionId: "session", cwd: "/work", timestamp: null, version: 1, title: "Journal" };
function entry(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: `2026-01-01T00:00:0${id === "begin" ? "1" : id === "middle" ? "2" : "3"}Z`, message: { role: "user", content: text, timestamp: Date.now() } };
}
function page(entries: ReturnType<typeof entry>[], nextCursor: string | null, hasOlder: boolean, truncated = false) {
  return { ok: true as const, data: { header, entries, truncated, truncatedByBytes: false, truncatedByEntries: truncated, hasOlder, nextCursor } };
}

async function mountSavedHistory() {
  vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: {
    id: "c1", projectId: "p1", nativeSessionId: "session", nativeSessionPath: null, title: "Journal", modelPreference: null,
    model: null, ownership: "managed", state: "stopped", tmuxSessionId: null, tmuxSessionName: null,
    tmuxServerIdentity: null, tmuxPanePid: null, hostInstanceId: null, hostGeneration: null,
    createdAt: "", updatedAt: "", lastActivityAt: null, statusDetail: null,
  } });
  vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c1", available: false, command: null, tmuxSessionName: null, reason: null } });
  vi.mocked(api.getConversationLink).mockResolvedValue({ ok: false, error: { code: "link_unavailable", message: "No live host" } });
  const view = render(<ConversationView conversationId="c1" onBack={() => {}} />);
  await waitFor(() => expect(api.getConversationHistory).toHaveBeenCalled());
  await view.findByRole("button", { name: "Load older" });
  return view;
}

describe("saved transcript cursor paging", () => {
  it("loads two older pages in journal order without duplicates and reaches beginning", async () => {
    vi.mocked(api.getConversationHistory)
      .mockResolvedValueOnce(page([entry("middle", "middle"), entry("end", "end")], "cursor-1", true, true))
      .mockResolvedValueOnce(page([entry("begin", "begin"), entry("middle", "middle")], "cursor-2", true))
      .mockResolvedValueOnce(page([entry("begin", "begin")], null, false));
    const view = await mountSavedHistory();
    const scroller = view.container.querySelector(".messages-scroll") as HTMLDivElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => view.container.querySelectorAll(".message-card").length * 100 });
    scroller.scrollTop = 50;

    expect(view.getByText("middle")).toBeTruthy();
    expect(view.getByText("end")).toBeTruthy();
    expect(view.getByText("Saved transcript truncated; some history is omitted.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(view.getByText("begin")).toBeTruthy());
    expect(scroller.scrollTop).toBe(150);
    fireEvent.click(view.getByRole("button", { name: "Load older" }));
    await waitFor(() => expect(view.getByText("Beginning of history.")).toBeTruthy());

    const rows = [...view.container.querySelectorAll(".message-card.user .message-content")].map((row) => row.textContent?.trim());
    expect(rows).toEqual(["begin", "middle", "end"]);
    expect(view.queryByRole("button", { name: "Load older" })).toBeNull();
    expect(api.getConversationHistory.mock.calls).toEqual([["c1"], ["c1", "cursor-1"], ["c1", "cursor-2"]]);
  });

  it("surfaces a refused cursor as an error and keeps current page", async () => {
    vi.mocked(api.getConversationHistory)
      .mockResolvedValueOnce(page([entry("end", "end marker")], "cursor-bad", true))
      .mockResolvedValueOnce({ ok: false, error: { code: "bad_request", message: "Invalid history cursor" } });
    const view = await mountSavedHistory();
    fireEvent.click(view.getByRole("button", { name: "Load older" }));
    expect((await view.findByRole("alert")).textContent).toContain("Invalid history cursor");
    expect(view.container.querySelector(".messages-content")?.textContent).toContain("end marker");
    expect(view.getByRole("button", { name: "Load older" })).toBeTruthy();
  });
});
