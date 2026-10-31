// @vitest-environment jsdom
// WEB-02: the primary navigation controls (project card, folder rows, conversation
// card) were pointer-only. Each case asserts the observable outcome of activating a
// control without a mouse: the next screen renders, or the listing moves to the
// activated directory.
//
// jsdom does not synthesize a click from Enter/Space on a native <button> (verified
// with a probe: dispatching keydown on a real <button> produced zero click events).
// So the contract each case can prove differs by control kind:
//   - `role="button"` containers (project card, conversation card) carry their own
//     keydown handler, so Enter and Space are fired for real and the resulting
//     screen change is asserted.
//   - native `<button>` rows get the browser's activation for free, so what is
//     proven is the part jsdom can see: the element exposes the button role, is a
//     tab stop, is not disabled, and its click runs the same navigation.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/web/src/App.js";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { api } from "../../apps/web/src/api.js";
import { resetMutationQueues } from "../../apps/web/src/mutation-order.js";
import { resetProjectMutationState } from "../../apps/web/src/components/ProjectsView.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getMe: vi.fn(), getCapabilities: vi.fn(), listProjects: vi.fn(), updateProject: vi.fn(),
    deleteProject: vi.fn(), createProject: vi.fn(), listConversations: vi.fn(),
    listNativeSessions: vi.fn(), createConversation: vi.fn(), browse: vi.fn(), createDirectory: vi.fn(),
  },
  setCsrfToken: vi.fn(),
}));
// The conversation screen is not this ticket's subject; asserting it is mounted is
// enough to prove the card navigated.
vi.mock("../../apps/web/src/components/ConversationView.js", () => ({
  ConversationView: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="conversation">Conversation {conversationId}</div>
  ),
}));

afterEach(() => {
  resetMutationQueues();
  resetProjectMutationState();
  cleanup();
  vi.restoreAllMocks();
});

const PROJECT = {
  id: "p1", path: "/work/A", label: "Project A", favorite: false,
  conversationCount: 1, lastActivityAt: null, createdAt: "", updatedAt: "",
};

const CONVERSATION = {
  id: "c1", projectId: "p1", nativeSessionId: null, nativeSessionPath: null, title: "Chat One",
  modelPreference: null, model: null, ownership: "managed", state: "idle", tmuxSessionId: null,
  tmuxSessionName: null, tmuxServerIdentity: null, tmuxPanePid: null, hostInstanceId: null,
  hostGeneration: null, createdAt: "", updatedAt: "", lastActivityAt: null, statusDetail: null,
};

async function renderApp() {
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } } as never);
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [PROJECT] } as never);
  vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [CONVERSATION] } as never);
  vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: true, data: [] } as never);
  await act(async () => { render(<App />); });
}

const cardOf = (text: string) => screen.getByText(text).closest(".card") as HTMLElement;

const entry = (path: string, over: Record<string, unknown> = {}) => ({
  name: path.split("/").at(-1)!, path, isDirectory: true, allowed: true, hasProject: false, ...over,
});
const page = (path: string, entries: unknown[], parent: string | null = null) => ({
  ok: true as const,
  data: { path, parent, roots: ["/work"], entries, hasMore: false, nextCursor: null },
});

describe("WEB-02 project card", () => {
  it("exposes the card as one named button, not a pile of nested control text", async () => {
    await renderApp();
    const card = cardOf("/work/A");
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    // Without the explicit label, the name would be "☆ Project A Rename Delete".
    expect(screen.getByRole("button", { name: "Open Project A" })).toBe(card);
    expect(screen.queryByRole("button", { name: /Project A.*Rename/ })).toBeNull();
  });

  it("opens the project on Enter, without any pointer event", async () => {
    await renderApp();
    const card = cardOf("/work/A");
    expect(document.activeElement).not.toBe(card);

    card.focus();
    expect(document.activeElement).toBe(card);

    fireEvent.keyDown(card, { key: "Enter" });

    // Observable outcome: the project detail screen replaced the project list.
    expect(screen.getByRole("button", { name: "+ New chat" })).toBeTruthy();
    expect(screen.queryByText("/work/A")).toBeNull();
  });

  it("opens the project on Space and does not let Space scroll the page", async () => {
    await renderApp();
    const card = cardOf("/work/A");
    card.focus();

    // fireEvent returns false when the event's default was prevented: the page
    // must not scroll on the Space that activates the card.
    const notPrevented = fireEvent.keyDown(card, { key: " " });
    expect(notPrevented).toBe(false);
    expect(screen.getByRole("button", { name: "+ New chat" })).toBeTruthy();
  });

  it("leaves a control nested inside the card independently operable", async () => {
    await renderApp();
    const card = cardOf("/work/A");
    const rename = screen.getByRole("button", { name: "Rename" });

    // The inner control is its own tab stop inside the card's tab stop.
    rename.focus();
    expect(document.activeElement).toBe(rename);

    // Enter on the inner control must not bubble into the card's activation.
    fireEvent.keyDown(rename, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "+ New chat" })).toBeNull();

    // Its own click still works and still does not open the project.
    fireEvent.click(rename);
    expect(screen.getByRole("heading", { name: "Rename Project Label" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ New chat" })).toBeNull();
  });
});

describe("WEB-02 conversation card", () => {
  it("opens the conversation on Enter and on Space", async () => {
    await renderApp();
    fireEvent.keyDown(cardOf("/work/A"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Chat One")).toBeTruthy());

    const card = cardOf("Chat One");
    expect(screen.getByRole("button", { name: "Open Chat One" })).toBe(card);
    expect(document.activeElement).not.toBe(card);
    card.focus();
    expect(document.activeElement).toBe(card);
    fireEvent.keyDown(card, { key: "Enter" });
    expect(screen.getByTestId("conversation").textContent).toBe("Conversation c1");

    // Back to the list, then Space: the second activation key works too.
    cleanup();
    await renderApp();
    fireEvent.keyDown(cardOf("/work/A"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Chat One")).toBeTruthy());
    const again = cardOf("Chat One");
    again.focus();
    expect(fireEvent.keyDown(again, { key: " " })).toBe(false);
    expect(screen.getByTestId("conversation").textContent).toBe("Conversation c1");
  });
});

describe("WEB-02 folder rows", () => {
  const nativeButton = (el: HTMLElement) => {
    expect(el.tagName).toBe("BUTTON");
    expect((el as HTMLButtonElement).type).toBe("button");
    expect((el as HTMLButtonElement).disabled).toBe(false);
    expect(el.tabIndex).toBe(0);
    // No explicit role: the accessible role is the element's implicit one.
    expect(el.getAttribute("role")).toBeNull();
  };

  it("makes the Up row a real button that navigates to the parent", async () => {
    vi.mocked(api.browse).mockImplementation(async (path) => {
      if (path === "/work/up") return page("/work/up", [entry("/work/up/child")]);
      return page("/work", [entry("/work/other")], "/work/up");
    });
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });

    const up = await screen.findByRole("button", { name: /\(Up\)/ });
    nativeButton(up);
    up.focus();
    expect(document.activeElement).toBe(up);

    await act(async () => { fireEvent.click(up); });
    expect(api.browse).toHaveBeenLastCalledWith("/work/up", { limit: 100 });
    expect(screen.getByText("📁 child")).toBeTruthy();
  });

  it("makes each directory row a real button that navigates into it", async () => {
    vi.mocked(api.browse).mockImplementation(async (path) => {
      if (path === "/work/other") return page("/work/other", [entry("/work/other/deep")], "/work");
      return page("/work", [entry("/work/other")], "/work/up");
    });
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });

    const row = await screen.findByRole("button", { name: /other/ });
    nativeButton(row);
    row.focus();
    expect(document.activeElement).toBe(row);

    await act(async () => { fireEvent.click(row); });
    expect(api.browse).toHaveBeenLastCalledWith("/work/other", { limit: 100 });
    expect(screen.getByText("📁 deep")).toBeTruthy();
  });

  it("keeps a disallowed directory out of the tab order and non-navigating", async () => {
    vi.mocked(api.browse).mockResolvedValue(page("/work", [entry("/work/blocked", { allowed: false })]) as never);
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });

    const row = await screen.findByText("📁 blocked");
    const button = row.closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain("disabled");

    button.focus();
    expect(document.activeElement).not.toBe(button);

    fireEvent.click(button);
    expect(api.browse).toHaveBeenLastCalledWith(undefined, { limit: 100 });
  });
});
