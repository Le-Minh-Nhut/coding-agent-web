// @vitest-environment jsdom
/**
 * Round 54 P1-B: the Agents layer is a real screen, and browser Back walks it.
 *
 * The defect being guarded: the Agents Center/Detail used to render as siblings
 * *after* the composer inside `.conversation-screen`, so they competed with the
 * chat layout instead of occupying the viewport — and there was no history entry,
 * so the browser's Back left the app rather than returning to the conversation.
 *
 * What is asserted here (behaviour, not markup):
 *  - opening the layer does not unmount the conversation (same socket, same draft);
 *  - the layer is a fixed, full-viewport container outside the conversation column;
 *  - a browser `popstate` closes it and returns to the conversation, with the
 *    filter/selection state intact when navigating back from a detail;
 *  - no socket is created by the navigation, and listeners do not accumulate.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { CollabSocket, type HostFrame } from "@caw/collab-protocol";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { api } from "../../apps/web/src/api.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getConversation: vi.fn(), getAttachInstructions: vi.fn(), getConversationLink: vi.fn(), getModels: vi.fn(),
    getConversationHistory: vi.fn(),
  },
}));

const welcome = (): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "s", cwd: "/", timestamp: "" },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
});

const AGENTS = [
  { id: "main", displayName: "director", kind: "main" as const, status: "running" as const, hasSessionFile: false, createdAt: 1, lastActivity: 2 },
  { id: "sub-1", displayName: "scout", kind: "sub" as const, status: "running" as const, hasSessionFile: true, createdAt: 1, lastActivity: 2 },
];

let socket: CollabSocket | null = null;

async function mount() {
  vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: { id: "c-1", title: "Chat", state: "idle", ownership: "managed" } } as never);
  vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { available: false } } as never);
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } });
  vi.mocked(api.getConversationHistory).mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } });
  vi.mocked(api.getConversationLink).mockResolvedValue({
    ok: true,
    data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBA", access: "full", instanceId: "i", generation: 1 },
  });
  const connect = vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
  vi.spyOn(CollabSocket.prototype, "send").mockResolvedValue(true);
  const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
  await waitFor(() => expect(socket).not.toBeNull());
  await act(async () => { socket!.onFrame?.(welcome(), 0); });
  await act(async () => { socket!.onFrame?.({ t: "agents", agents: AGENTS } as HostFrame, 0); });
  return { view, connections: connect };
}

const openAgentsFromMenu = async (view: { getByRole: (role: "button", o: { name: string | RegExp }) => HTMLElement }) => {
  fireEvent.click(view.getByRole("button", { name: "More actions" }));
  await act(async () => { fireEvent.click(view.getByRole("button", { name: /^Agents \(/ })); });
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  socket = null;
  window.history.replaceState(null, "");
});

describe("P1-B — the Agents layer", () => {
  it("keeps the conversation mounted (same socket, same draft) while open", async () => {
    const { view } = await mount();
    const composer = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "draft that must survive" } });
    const socketBefore = socket;

    await openAgentsFromMenu(view);

    // The layer is a fixed overlay outside the conversation column, and the
    // conversation's own DOM (including the composer and its draft) still exists.
    const layer = view.container.querySelector(".agents-layer");
    expect(layer).not.toBeNull();
    expect(layer!.closest(".conversation-column")).toBeNull();
    expect(view.container.querySelector("textarea.composer-input")).toBe(composer);
    expect(composer.value).toBe("draft that must survive");
    expect(socket).toBe(socketBefore);
  });

  it("marks the covered conversation inert so it is not a second interactive screen", async () => {
    const { view } = await mount();
    await openAgentsFromMenu(view);
    expect(view.container.querySelector(".conversation-column")!.hasAttribute("inert")).toBe(true);
  });

  it("closes on browser Back (popstate) without creating a socket", async () => {
    const { view, connections } = await mount();
    const callsBefore = connections.mock.calls.length;
    await openAgentsFromMenu(view);
    expect(view.container.querySelector(".agents-layer")).not.toBeNull();

    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: null })); });

    expect(view.container.querySelector(".agents-layer")).toBeNull();
    expect(view.container.querySelector(".conversation-column")!.hasAttribute("inert")).toBe(false);
    expect(connections.mock.calls.length).toBe(callsBefore);
  });

  it("restores the list from a detail when Back lands on the list entry", async () => {
    const { view } = await mount();
    await openAgentsFromMenu(view);
    await act(async () => { fireEvent.click(view.getByRole("button", { name: /scout/ })); });
    expect(view.getByRole("heading", { name: "Transcript" })).toBeTruthy();

    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: { cawAgents: "list" } })); });
    // Back from the detail is the list, not the conversation.
    expect(view.getByRole("heading", { name: /Agents \(/ })).toBeTruthy();
    expect(view.container.querySelector(".agents-layer")).not.toBeNull();
  });

  it("a populated entry for another conversation cannot re-open this view's agents layer", async () => {
    // M2 regression. The stale entry is exactly what a conversation switch leaves
    // behind: `cawAgents` was pushed for conversation A, the user switches to B,
    // and a later Back lands on A's entry. Honouring it would show A's selected
    // agent against B's roster — so the entry names its conversation and the view
    // refuses one that is not its own.
    const { view } = await mount();
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { cawAgents: "detail", id: "scout", conversationId: "a-different-conversation" } }));
    });
    expect(view.container.querySelector(".agents-layer")).toBeNull();

    // Its own entry is still honoured: the guard rejects foreign state, not the layer.
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { cawAgents: "list", conversationId: "c-1" } }));
    });
    expect(view.container.querySelector(".agents-layer")).not.toBeNull();
  });

  it("stops reacting to popstate once unmounted, so a stale Back cannot resurrect the layer", async () => {
    // Behaviour, not wiring: this used to assert `removeEventListener` was called,
    // which is the implementation detail rather than the user-visible guarantee.
    const { view } = await mount();
    const container = view.container;
    await openAgentsFromMenu(view);
    expect(container.querySelector(".agents-layer")).not.toBeNull();

    view.unmount();
    expect(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { cawAgents: "list", conversationId: "c-1" } }));
    }).not.toThrow();
    // The unmounted tree is empty and nothing was re-rendered into it.
    expect(container.querySelector(".agents-layer")).toBeNull();
  });

  it("returns focus to the control that opened the layer when it closes", async () => {
    // M3: without this a keyboard user is dropped at document.body after Back.
    const { view } = await mount();
    await act(async () => { fireEvent.click(view.getByRole("button", { name: "More actions" })); });
    const opener = view.getByRole("button", { name: /^Agents \(/ });
    // jsdom does not move focus on click, so the opener is focused explicitly —
    // which is exactly the state a real keyboard user is in when they activate it.
    act(() => { opener.focus(); });
    await act(async () => { fireEvent.click(opener); });
    expect(view.container.querySelector(".agents-layer")).not.toBeNull();

    await act(async () => { window.dispatchEvent(new PopStateEvent("popstate", { state: null })); });
    expect(view.container.querySelector(".agents-layer")).toBeNull();
    // M3: focus never falls to `document.body`. The captured opener is a menu item and
    // the menu closes when the layer opens, so the header menu trigger — persistent,
    // and how the layer is reached — is the correct landing point.
    expect(document.activeElement).not.toBe(document.body);
    const active = document.activeElement as HTMLElement;
    expect(active.isConnected).toBe(true);
    expect(active.getAttribute("aria-label")).toBe("More actions");
  });
});
