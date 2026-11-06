// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryView } from "../../apps/web/src/components/HistoryView.js";
import { api } from "../../apps/web/src/api.js";
import type { GlobalSessionSummary } from "@caw/contracts";

vi.mock("../../apps/web/src/api.js", () => ({ api: { getConversationEvents: vi.fn().mockResolvedValue({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } }), listGlobalSessions: vi.fn(), getSavedSessionHistory: vi.fn(), createConversation: vi.fn(), attachLiveSession: vi.fn() } }));
const session = (over: Partial<GlobalSessionSummary> = {}): GlobalSessionSummary => ({ sessionId: "session-1", journalPath: "/journal", cwd: "/work", cwdAvailable: true, projectId: "p1", conversationId: null, title: null, updatedAt: null, startedAt: null, live: false, tracked: false, hasCollabHost: false, relayConnected: null, ...over });
const page = (sessions: GlobalSessionSummary[], extra = {}) => ({ ok: true as const, data: { sessions, nextCursor: null, filesScanned: 2, truncated: false, excludedOutsideRoots: 0, skippedNonJournal: 0, unreadableJournals: 0, unreadableCwds: 0, ...extra } });

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.clearAllMocks(); vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session()]) as never); vi.mocked(api.getSavedSessionHistory).mockResolvedValue({ ok: true, data: { header: { sessionId: "session-1", cwd: "/work", timestamp: null, version: null, title: null }, entries: [], truncated: false, truncatedByBytes: false, truncatedByEntries: false, skippedOversized: false, hasOlder: false, nextCursor: null } } as never); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("global session history", () => {
  it("shows the full truncation warning and counts", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session()], { truncated: true, filesScanned: 99, excludedOutsideRoots: 4, skippedNonJournal: 3 }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect((await screen.findByText(/truthful prefix, not the whole store/)).textContent).toContain("99");
    expect(screen.getByRole("alert").textContent).toContain("excluded outside allowed roots: 4");
  });

  it("warns with the count when journals could not be read, and stays silent at zero", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session()], { unreadableJournals: 2 }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    // Assert the whole banner, not just its <strong> heading.
    const warning = (await screen.findByText(/Some journals could not be read\./)).closest("[role='alert']")!;
    expect(warning.textContent).toContain("2 journals were skipped after a read error");
    cleanup();

    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ title: "quiet-session" })], { unreadableJournals: 0 }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect(await screen.findByText("quiet-session")).toBeTruthy();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });

  it("warns about a dropped root even with truncated false and zero rows", async () => {
    // The silent-loss case: a configured root could not be read, so sessions under
    // it are missing, yet no cap was hit (`truncated: false`) and the page is
    // empty. "No sessions match." would be a lie about the whole store.
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([], { truncated: false, droppedRoots: ["/mnt/data/projects"] }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);

    const warning = (await screen.findByText(/A configured root could not be read\./)).closest("[role='alert']")!;
    // The path is named, so the user can act on the specific mount.
    expect(warning.textContent).toContain("/mnt/data/projects");
    expect(warning.textContent).toContain("missing from this list");
    // And the empty-store claim is not made.
    expect(screen.queryByText("No sessions match.")).toBeNull();
  });

  it("warns about unreadable working directories even with truncated false and zero rows", async () => {
    // Distinct from `excludedOutsideRoots`, which is a legitimate scope decision
    // and must stay silent. Here the journal was readable but its own `cwd` was
    // not, so rows are missing for a reason invisible from the sessions list.
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([], { truncated: false, excludedOutsideRoots: 12, unreadableCwds: 3 }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);

    const warning = (await screen.findByText(/Some sessions are missing\./)).closest("[role='alert']")!;
    expect(warning.textContent).toContain("3 sessions were skipped");
    expect(warning.textContent).toContain("could not be read");
    // The empty-store claim is not made, since rows were dropped.
    expect(screen.queryByText("No sessions match.")).toBeNull();
    expect(screen.getByText(/No sessions can be listed right now/)).toBeTruthy();
    // `excludedOutsideRoots` on its own must not raise this banner.
    expect(screen.queryByText(/excluded outside allowed roots: 12/)).toBeNull();
  });

  it("stays silent for a legitimately out-of-scope count", async () => {
    // The 12-of-61 case: journals outside the workspace are not an error.
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ title: "in-scope" })], { truncated: false, excludedOutsideRoots: 12, unreadableCwds: 0 }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect(await screen.findByText("in-scope")).toBeTruthy();
    expect(screen.queryByText(/Some sessions are missing\./)).toBeNull();
  });

  it("degrades when an older server omits droppedRoots entirely", async () => {
    // `droppedRoots` is optional: a server that predates it must not crash, and
    // must not be read as "roots failed" either.
    const legacy = { ok: true as const, data: { sessions: [session({ title: "legacy" })], nextCursor: null, filesScanned: 1, truncated: false, excludedOutsideRoots: 0, skippedNonJournal: 0, unreadableJournals: 0 } };
    vi.mocked(api.listGlobalSessions).mockResolvedValue(legacy as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect(await screen.findByText("legacy")).toBeTruthy();
    expect(screen.queryByText(/configured root could not be read/)).toBeNull();
  });

  it("stays silent about dropped roots on a healthy listing", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ title: "healthy-session" })], { truncated: false }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect(await screen.findByText("healthy-session")).toBeTruthy();
    expect(screen.queryByText(/configured root could not be read/)).toBeNull();
    // Absent field on an older server is the same healthy path, not a crash.
    expect(screen.queryByText(/No sessions can be listed right now/)).toBeNull();
  });

  it("keeps the unreadable warning separate from the truncation banner", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session()], { truncated: true, unreadableJournals: 1, filesScanned: 7 }) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);

    const truncation = await screen.findByText(/truthful prefix, not the whole store/);
    const unreadable = screen.getByText(/Some journals could not be read\./).closest("[role='alert']")!;
    // Two facts, two banners, one live region each.
    expect(truncation.closest("[role='alert']")).not.toBe(unreadable);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(unreadable.textContent).toContain("1 journal was skipped");
  });

  it("disables unsafe resume and exposes reason for unregistered folder", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ projectId: null })]) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    const resume = await screen.findByRole("button", { name: "Resume" });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("This folder is not a project; add it to resume here.").textContent).toBe("This folder is not a project; add it to resume here.");
    cleanup();
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ live: "unknown" })]) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
  it("renders each action only for its valid session state", async () => {
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([
      session({ sessionId: "safe" }),
      session({ sessionId: "live", title: "live", live: true, hasCollabHost: true, relayConnected: true }),
      session({ sessionId: "tracked", title: "tracked", tracked: true, conversationId: "conversation-1" }),
      session({ sessionId: "unverified", title: "unverified", live: "unknown", hasCollabHost: true, relayConnected: true }),
      session({ sessionId: "no-relay", title: "no-relay", live: true, hasCollabHost: true, relayConnected: false }),
    ]) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    const safe = await screen.findByText("safe").then((e) => e.closest("article")!);
    expect(within(safe).getByRole("button", { name: "View history" })).toBeTruthy();
    expect((within(safe).getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(safe).queryByRole("button", { name: "Open live" })).toBeNull();
    const live = screen.getAllByRole("heading", { name: "live", level: 4 })[0]!.closest("article")!;
    const tracked = screen.getAllByRole("heading", { name: "tracked", level: 4 })[0]!.closest("article")!;
    expect(within(tracked).getByRole("button", { name: "Open conversation" })).toBeTruthy();
    expect(within(live).getByRole("button", { name: "Open live" })).toBeTruthy();
    const unknown = screen.getAllByRole("heading", { name: "unverified", level: 4 })[0]!.closest("article")!;
    expect(within(unknown).queryByRole("button", { name: "Open live" })).toBeNull();
    expect((within(unknown).getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(true);
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

  it("carries the unreadable count across load more as a whole-store figure", async () => {
    // The server sends `scan.filesUnreadable` on every response, cursor or not
    // (apps/server/src/app.ts:443), so the merged page keeps the max rather than
    // summing per-response counts — unlike `filesScanned`, which is a slice.
    vi.mocked(api.listGlobalSessions).mockImplementation((options) => options?.cursor
      ? Promise.resolve(page([session({ sessionId: "older", title: "older-session" })], { nextCursor: null, filesScanned: 3, unreadableJournals: 1 })) as never
      : Promise.resolve(page([session({ title: "first-session" })], { nextCursor: "next", filesScanned: 4, unreadableJournals: 2 })) as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);

    const banner = (await screen.findByText(/Some journals could not be read\./)).closest("[role='alert']")!;
    expect(banner.textContent).toContain("2 journals were skipped");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("older-session")).toBeTruthy();
    // Max(2, 1) = 2, not the sum 3 — one store, one count.
    expect(screen.getByText(/Some journals could not be read\./).closest("[role='alert']")!.textContent).toContain("2 journals were skipped");
  });

  it("keeps selected history after an earlier request resolves and ignores close-then-resolve", async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const deferredA = new Promise<unknown>((resolve) => { resolveA = resolve; });
    const deferredB = new Promise<unknown>((resolve) => { resolveB = resolve; });
    vi.mocked(api.listGlobalSessions).mockResolvedValue(page([session({ sessionId: "A", title: "A" }), session({ sessionId: "B", title: "B" })]) as never);
    vi.mocked(api.getSavedSessionHistory).mockImplementation((id) => id === "A" ? deferredA as never : deferredB as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "View history" }))[0]!);
    fireEvent.click(screen.getAllByRole("button", { name: "View history" })[1]!);
    const history = (id: string) => ({ ok: true, data: { header: { sessionId: id, cwd: "/work", timestamp: null, version: null, title: id }, entries: [{ type: "message", id, role: "assistant", content: id }], truncated: false, truncatedByBytes: false, truncatedByEntries: false, skippedOversized: false, hasOlder: false, nextCursor: null } });
    await act(async () => { resolveB(history("B")); });
    await act(async () => { resolveA(history("A")); });
    expect(screen.getByText("B", { selector: ".history-reader h3" })).toBeTruthy();
    expect(screen.queryByText("A", { selector: ".history-reader h3" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    let resolveC!: (value: unknown) => void;
    const deferredC = new Promise<unknown>((resolve) => { resolveC = resolve; });
    vi.mocked(api.getSavedSessionHistory).mockReturnValue(deferredC as never);
    fireEvent.click(screen.getAllByRole("button", { name: "View history" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => { resolveC(history("A")); });
    expect(screen.queryByRole("dialog", { name: "Saved session history" })).toBeNull();
  });
  it("releases pagination when search changes during a deferred page request", async () => {
    let resolvePage!: (value: unknown) => void;
    const deferredPage = new Promise<unknown>((resolve) => { resolvePage = resolve; });
    vi.mocked(api.listGlobalSessions).mockImplementation((options) => {
      if (options?.cursor) return deferredPage as never;
      if (options?.q === "new") return Promise.resolve(page([session({ sessionId: "new" })], { nextCursor: "new-cursor" })) as never;
      return Promise.resolve(page([session({ sessionId: "old" })], { nextCursor: "old-cursor" })) as never;
    });
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    await screen.findByText("old");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
    await act(async () => { vi.advanceTimersByTime(260); });
    await screen.findByText("new");
    await act(async () => { resolvePage(page([session({ sessionId: "stale-page" })])); });
    expect(screen.queryByText("stale-page")).toBeNull();
    expect((screen.getByRole("button", { name: "Load more" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("preserves every supported transcript block and ordering in rendered history", async () => {
    vi.mocked(api.getSavedSessionHistory).mockResolvedValue({ ok: true, data: { header: { sessionId: "session-1", cwd: "/work", timestamp: null, version: null, title: null }, entries: [
      { type: "message", id: "sentinel", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: "ORDER_FIRST" }, { type: "toolCall", id: "call", name: "sentinel_tool", arguments: { arg: "ARGUMENT_SENTINEL" } }, { type: "text", text: "ORDER_LAST" }], model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, stopReason: "stop", timestamp: 0 } },
      { type: "custom_message", id: "custom", parentId: "sentinel", timestamp: "2026-01-01T00:00:01Z", customType: "saved_execution", content: "CUSTOM_SENTINEL", details: { exitCode: 17 }, display: true },
      { type: "branch_summary", id: "branch", parentId: "custom", timestamp: "2026-01-01T00:00:02Z", fromId: "PARENT_SENTINEL", summary: "BRANCH_SENTINEL" },
      { type: "message", id: "result", parentId: "branch", timestamp: "2026-01-01T00:00:03Z", message: { role: "toolResult", toolCallId: "call", toolName: "sentinel_tool", content: [{ type: "text", text: "RESULT_SENTINEL\\n  indented" }], details: { exitCode: 17 }, isError: true, timestamp: 3 } },
    ], truncated: false, truncatedByBytes: false, truncatedByEntries: false, skippedOversized: false, hasOlder: false, nextCursor: null } } as never);
    render(<HistoryView onBack={() => {}} onSelectConversation={() => {}} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "View history" }))[0]!);
    expect((await screen.findByText("[Tool call: sentinel_tool]")).textContent).toContain("sentinel_tool");
    expect(screen.getByText(/ARGUMENT_SENTINEL/)).toBeTruthy();
    expect(screen.getByText(/CUSTOM_SENTINEL/)).toBeTruthy();
    expect(screen.getByText(/PARENT_SENTINEL/)).toBeTruthy();
    expect(screen.getByText(/BRANCH_SENTINEL/)).toBeTruthy();
    const content = screen.getByRole("dialog").textContent ?? "";
    expect(content.indexOf("ORDER_FIRST")).toBeLessThan(content.indexOf("ORDER_LAST"));
    expect(content).toContain("RESULT_SENTINEL\\n  indented");
    expect(content).toContain("exitCode");
  });
});

