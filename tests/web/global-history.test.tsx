// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryView } from "../../apps/web/src/components/HistoryView.js";
import { api } from "../../apps/web/src/api.js";
import type { GlobalSessionSummary } from "@caw/contracts";

vi.mock("../../apps/web/src/api.js", () => ({ api: { listGlobalSessions: vi.fn(), getSavedSessionHistory: vi.fn(), createConversation: vi.fn(), attachLiveSession: vi.fn() } }));
const session = (over: Partial<GlobalSessionSummary> = {}): GlobalSessionSummary => ({ sessionId: "session-1", journalPath: "/journal", cwd: "/work", cwdAvailable: true, projectId: "p1", title: null, updatedAt: null, startedAt: null, live: false, tracked: false, hasCollabHost: false, relayConnected: null, ...over });
const page = (sessions: GlobalSessionSummary[], extra = {}) => ({ ok: true as const, data: { sessions, nextCursor: null, filesScanned: 2, truncated: false, excludedOutsideRoots: 0, skippedNonJournal: 0, ...extra } });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.clearAllMocks(); vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session()]) as never); vi.mocked(api.getSavedSessionHistory).mockResolvedValue({ ok: true, data: { header: { sessionId: "session-1", cwd: "/work", timestamp: null, version: null, title: null }, entries: [], truncated: false, truncatedByBytes: false, truncatedByEntries: false, skippedOversized: false, hasOlder: false, nextCursor: null } } as never); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("global session history", () => {
  it("shows the full truncation warning and counts", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session()], { truncated: true, filesScanned: 99, excludedOutsideRoots: 4, skippedNonJournal: 3 }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect((await screen.findByText(/truthful prefix, not the whole store/)).textContent).toContain("99");
    expect(screen.getByRole("alert").textContent).toContain("excluded outside allowed roots: 4");
  });

  it("disables unsafe resume and exposes reason for unregistered folder", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ projectId: null })]) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    const resume = await screen.findByRole("button", { name: "Resume" });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("this folder is not a project; add it to resume here").textContent).toBe("this folder is not a project; add it to resume here");
    cleanup();
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ live: "unknown" })]) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
  it("renders each action only for its valid session state", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([
      session({ sessionId: "safe" }),
      session({ sessionId: "tracked", tracked: true }),
      session({ sessionId: "live", live: true, hasCollabHost: true, relayConnected: true }),
      session({ sessionId: "unverified", title: "unverified", live: "unknown", hasCollabHost: true, relayConnected: true }),
      session({ sessionId: "no-relay", title: "no-relay", live: true, hasCollabHost: true, relayConnected: false }),
    ]) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    const safe = await screen.findByText("safe").then((e) => e.closest("article")!);
    expect(within(safe).getByRole("button", { name: "View history" })).toBeTruthy();
    expect((within(safe).getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(safe).queryByRole("button", { name: "Open live" })).toBeNull();
    const tracked = screen.getAllByRole("heading", { name: "tracked", level: 4 })[0]!.closest("article")!;
    expect(within(tracked).queryByRole("button", { name: "Resume" })).toBeNull();
    const live = screen.getAllByRole("heading", { name: "live", level: 4 })[0]!.closest("article")!;
    expect(within(live).getByRole("button", { name: "Open live" })).toBeTruthy();
    const unknown = screen.getAllByRole("heading", { name: "unverified", level: 4 })[0]!.closest("article")!;
    expect(within(unknown).queryByRole("button", { name: "Open live" })).toBeNull();
    expect(within(unknown).queryByRole("button", { name: "Resume" })).toBeNull();
    const noRelay = screen.getAllByRole("heading", { name: "no-relay", level: 4 })[0]!.closest("article")!;
    expect(within(noRelay).queryByRole("button", { name: "Open live" })).toBeNull();
  });

  it("discards stale query results and appends load-more without duplicates", async () => {
    let resolveFirst!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolveFirst = resolve; });
    vi.mocked(api.listGlobalSessions).mockImplementation((options) => {
      if (options?.cursor) return Promise.resolve(page([session({ sessionId: "second" }), session({ sessionId: "third" })])) as never;
      if (options?.q === "new") return Promise.resolve(page([session({ sessionId: "second" })], { nextCursor: "next" })) as never;
      return pending as never;
    });
    const { container } = render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    await waitFor(() => expect(api.listGlobalSessions).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
    await act(async () => { vi.advanceTimersByTime(260); });
    expect(await screen.findByText("second")).toBeTruthy();
    await act(async () => { resolveFirst(page([session({ sessionId: "stale" })])); });
    expect(screen.queryByText("stale")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("third")).toBeTruthy();
    expect(container.querySelectorAll("article.history-row")).toHaveLength(2);
  });
});
