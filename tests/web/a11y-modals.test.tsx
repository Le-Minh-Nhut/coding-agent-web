// @vitest-environment jsdom
// A11Y-01: the modal dialogs were anonymous divs — no dialog role, no name, focus
// left on the page behind them, Tab able to walk out, Escape doing nothing.
// A11Y-02: an aria-label on a plain div is exposed on nothing, because a generic div
// has no role to carry a name.
// ACTIVITY-01: the loading flag was released before the staleness check, so an older
// read cleared the spinner a newer read still owned.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectsView, resetProjectMutationState } from "../../apps/web/src/components/ProjectsView.js";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { SubagentPanel } from "../../apps/web/src/components/SubagentPanel.js";
import { ActivityPanel } from "../../apps/web/src/components/ActivityPanel.js";
import { api } from "../../apps/web/src/api.js";
import { resetMutationQueues } from "../../apps/web/src/mutation-order.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    listProjects: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), createProject: vi.fn(),
    browse: vi.fn(), createDirectory: vi.fn(), getConversationEvents: vi.fn(),
  },
}));

afterEach(() => {
  resetMutationQueues();
  resetProjectMutationState();
  cleanup();
  vi.restoreAllMocks();
});

// Node 20.19 here has no Promise.withResolvers, so the executor form is required.
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

const ok = (data: unknown) => ({ ok: true as const, data } as never);
const PROJECT = {
  id: "p1", path: "/work/A", label: "Project A", favorite: false, conversationCount: 0,
  lastActivityAt: null, createdAt: "", updatedAt: "",
};
const DELETED = ok({ deleted: true, filesRemoved: false });

const overlay = () => document.querySelector(".modal-overlay") as HTMLElement;
const tabbables = () =>
  [...document.querySelectorAll<HTMLElement>("button,input,a[href],[tabindex]")]
    .filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);

/** Every dialog owes the same four things, so they are asserted the same way. */
function expectRealDialog(overlayEl: HTMLElement, name: RegExp) {
  expect(overlayEl.getAttribute("role")).toBe("dialog");
  expect(overlayEl.getAttribute("aria-modal")).toBe("true");
  // A name, however this dialog supplies it. Text queries rather than role queries
  // so a dialog reachable only by mouse still gets a name reported here.
  expect(screen.getByRole("dialog", { name })).toBe(overlayEl);
  // Focus starts inside the dialog, not on the page behind it.
  expect(overlayEl.contains(document.activeElement)).toBe(true);
}

async function renderProjects(projects: unknown[] = [PROJECT]) {
  vi.mocked(api.listProjects).mockResolvedValue(ok(projects));
  await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
}

const folderListing = (path: string, parent: string | null = null) => ok({
  path, parent, roots: ["/work"],
  entries: [{ name: "other", path: `${path}/other`, isDirectory: true, allowed: true, hasProject: false }],
  hasMore: false, nextCursor: null,
});

describe("A11Y-01 the delete dialog", () => {
  it("is a named modal dialog that takes focus and returns it to the opener", async () => {
    await renderProjects();
    const opener = screen.getByRole("button", { name: "Delete" });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await act(async () => { fireEvent.click(opener); });
    expectRealDialog(overlay(), /Delete Project/);

    // Cancel hands focus back to the control the dialog was opened from.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
  });

  it("closes on Escape through Cancel, never through Confirm", async () => {
    vi.mocked(api.deleteProject).mockResolvedValue(DELETED);
    await renderProjects();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete" })); });

    fireEvent.keyDown(overlay(), { key: "Escape" });

    // The dialog is gone, and the destructive action was not taken.
    expect(screen.queryByRole("heading", { name: "Delete Project" })).toBeNull();
    expect(api.deleteProject).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the dialog instead of walking into the page behind", async () => {
    await renderProjects();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Delete" })); });

    const inside = tabbables().filter((el) => overlay().contains(el));
    // Exactly the dialog's own two controls are inside it, and every other reachable
    // control is behind the overlay.
    expect(inside.map((el) => (el.textContent ?? "").trim())).toEqual(["Cancel", "Confirm Delete"]);
    expect(tabbables().length).toBeGreaterThan(inside.length);

    const first = inside[0]!;
    const last = inside[1]!;
    last.focus();
    expect(document.activeElement).toBe(last);
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(overlay().contains(document.activeElement)).toBe(true);

    // Shift+Tab from the first wraps to the last.
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
    expect(overlay().contains(document.activeElement)).toBe(true);

    // The state the pointer click on the dialog's inert text produces: the browser
    // puts focus on <body>, outside the dialog. Shift+Tab from there used to walk
    // backwards onto the Delete button behind the overlay.
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    expect(fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
    expect(overlay().contains(document.activeElement)).toBe(true);
  });
});

describe("A11Y-01 the rename dialog", () => {
  it("is a named modal dialog that closes on Escape back to the opener", async () => {
    await renderProjects();
    const opener = screen.getByRole("button", { name: "Rename" });
    opener.focus();
    await act(async () => { fireEvent.click(opener); });
    expectRealDialog(overlay(), /Rename Project Label/);

    fireEvent.keyDown(overlay(), { key: "Escape" });
    expect(screen.queryByRole("heading", { name: "Rename Project Label" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("A11Y-01 the folder browser dialog", () => {
  it("is a named modal dialog that takes focus, and Escape cancels it", async () => {
    vi.mocked(api.browse).mockResolvedValue(folderListing("/work") as never);
    const onCancel = vi.fn();
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={onCancel} />); });

    expectRealDialog(overlay(), /Browse Folders/);
    fireEvent.keyDown(overlay(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("A11Y-01 the subagents dialog", () => {
  it("is a named modal dialog that takes focus and closes on Escape", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <SubagentPanel
          agents={[]}
          onFetchTranscript={() => {}}
          onWatchAgent={() => {}}
          transcripts={{}}
          transcriptErrors={{}}
          loadingAgentIds={[]}
          onClose={onClose}
        />,
      );
    });

    expectRealDialog(overlay(), /Subagents/);
    fireEvent.keyDown(overlay(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("A11Y-02 the workspace roots container", () => {
  it("carries its name on an element that can actually expose one", async () => {
    vi.mocked(api.browse).mockResolvedValue(ok({
      path: "/work", parent: null, roots: ["/work", "/srv/work"], entries: [], hasMore: false, nextCursor: null,
    }) as never);
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });

    // Before: a plain div, whose aria-label no assistive tech reports. The name is
    // only exposed once the element has a role that accepts one.
    const group = screen.getByRole("group", { name: "Workspace roots" });
    expect(group.getAttribute("aria-label")).toBe("Workspace roots");
    expect(group.tagName).toBe("DIV");
  });
});

describe("ACTIVITY-01 loading belongs to the newest activity read", () => {
  const EVENT = { seq: 1, type: "agent.launched", ts: "2026-01-01T00:00:00.000Z", payload: { n: 1 } };

  it("keeps the spinner when a superseded read lands while a newer one is open", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    vi.mocked(api.getConversationEvents).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const view = render(<ActivityPanel conversationId="c1" />);
    expect(screen.getByText("Loading activity…")).toBeTruthy();
    // A new conversation starts a new read; the first one is now superseded.
    view.rerender(<ActivityPanel conversationId="c2" />);

    await act(async () => { first.resolve(ok({ events: [EVENT], nextBefore: null }) as never); });

    // The read the user is waiting on has not finished: it must not report "no
    // activity" and must not drop its spinner.
    expect(screen.getByText("Loading activity…")).toBeTruthy();
    expect(screen.queryByText("No activity recorded for this conversation yet.")).toBeNull();

    await act(async () => { second.resolve(ok({ events: [EVENT], nextBefore: null }) as never); });
    expect(screen.queryByText("Loading activity…")).toBeNull();
    expect(screen.getByText("Agent Launched")).toBeTruthy();
  });

  it("does not leave the spinner stuck when the panel is handed an empty event list while a read is open", async () => {
    const pending = deferred<never>();
    vi.mocked(api.getConversationEvents).mockReturnValueOnce(pending.promise);

    const view = render(<ActivityPanel conversationId="c1" />);
    expect(screen.getByText("Loading activity…")).toBeTruthy();

    // The panel is handed its state directly and starts no replacement read, so this
    // path must release the tail flag the abandoned read can no longer touch. If it
    // does not, the spinner stays up over an empty list and the honest empty state
    // never appears — and Retry stays disabled if the read later fails.
    await act(async () => { view.rerender(<ActivityPanel conversationId="c1" events={[]} />); });
    expect(screen.queryByText("Loading activity…")).toBeNull();
    expect(screen.getByText("No activity recorded for this conversation yet.")).toBeTruthy();

    // The abandoned read lands and changes nothing.
    await act(async () => { pending.resolve(ok({ events: [EVENT], nextBefore: null }) as never); });
    expect(screen.queryByText("Agent Launched")).toBeNull();
  });

  it("clears the spinner when the newest read is the one that settles", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    vi.mocked(api.getConversationEvents).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const view = render(<ActivityPanel conversationId="c1" />);
    view.rerender(<ActivityPanel conversationId="c2" />);

    await act(async () => { second.resolve(ok({ events: [EVENT], nextBefore: null }) as never); });
    expect(screen.queryByText("Loading activity…")).toBeNull();
    expect(screen.getByText("Agent Launched")).toBeTruthy();

    // The superseded read lands afterwards and repaints nothing.
    await act(async () => { first.resolve(ok({ events: [{ ...EVENT, seq: 99 }], nextBefore: null }) as never); });
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.queryByText("#99")).toBeNull();
  });
});
