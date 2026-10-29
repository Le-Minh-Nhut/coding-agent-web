// @vitest-environment jsdom
// Regression coverage for the round-14/15 web fixes, covering branches the
// auditor probes do not: a refusal landing on the wrong physical connection,
// A→B→A and refresh-same-path folder navigation, late create/rename dialog
// responses, and a stale list snapshot against a settled star.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CollabSocket, type GuestFrame, type HostFrame } from "@caw/collab-protocol";
import type { ApiResult, ProjectWithStats } from "@caw/contracts";
import { api } from "../../apps/web/src/api.js";
import { ConversationView } from "../../apps/web/src/components/ConversationView.js";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    setConversationModel: vi.fn(), restartConversation: vi.fn(), getConversation: vi.fn(),
    getAttachInstructions: vi.fn(), getConversationLink: vi.fn(),
    getConversationHistory: vi.fn().mockResolvedValue({ ok: false, error: { code: "not_found", message: "No history" } }),
    getModels: vi.fn().mockResolvedValue({ ok: true, data: { models: [], source: "omp", reason: null } }),
    listProjects: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), createProject: vi.fn(),
    browse: vi.fn(), createDirectory: vi.fn(),
  },
}));

const welcome = (): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "session", cwd: "/", timestamp: new Date().toISOString() },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount: 0,
});
const child = (path: string) => ({ name: path.split("/").at(-1)!, path, isDirectory: true, allowed: true, hasProject: false });
const listing = (path: string, children: string[], cursor: string | null = null) => ({ ok: true as const, data: { path, parent: null, roots: ["/work"], entries: children.map(child), hasMore: cursor !== null, nextCursor: cursor } });

let socket: CollabSocket | null = null;
afterEach(() => { cleanup(); vi.restoreAllMocks(); socket = null; });

describe("round14/15 web regressions", () => {
  it("V14 refusal: an unacked pre-reconnect prompt keeps its row and the new prompt is restored", async () => {
    const sent: GuestFrame[] = [];
    vi.spyOn(CollabSocket.prototype, "send").mockImplementation((frame) => { sent.push(frame); return Promise.resolve(true); });
    vi.spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) { socket = this; this.onOpen?.(); });
    vi.mocked(api.getConversation).mockResolvedValue({ ok: true, data: {
      id: "c-1", projectId: "p-1", nativeSessionId: null, nativeSessionPath: null, title: "Test", model: "model",
      ownership: "managed", state: "idle", tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null,
      tmuxPanePid: null, hostInstanceId: null, hostGeneration: null, createdAt: "", updatedAt: "",
      lastActivityAt: null, statusDetail: null, modelPreference: "model-a",
    } });
    vi.mocked(api.getAttachInstructions).mockResolvedValue({ ok: true, data: { conversationId: "c-1", available: false, command: null, tmuxSessionName: null, reason: null } });
    vi.mocked(api.getConversationLink).mockResolvedValue({ ok: true, data: { url: "ws://127.0.0.1:7466/r/0123456789abcdef.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE", access: "full", instanceId: "i", generation: 1 } });
    const view = render(<ConversationView conversationId="c-1" onBack={() => {}} />);
    await waitFor(() => expect(socket).not.toBeNull());
    await act(async () => { socket?.onFrame?.(welcome(), 0); });
    await waitFor(() => expect(view.container.querySelector("textarea.composer-input")).not.toBeNull());
    const composer = view.container.querySelector("textarea.composer-input") as HTMLTextAreaElement;

    // A: accepted by the socket, never echoed, then the same object auto-reconnects.
    fireEvent.change(composer, { target: { value: "unacknowledged A" } });
    await act(async () => { fireEvent.submit(composer.closest("form")!); });
    await act(async () => { socket!.onClose?.("lost", true); socket!.onOpen?.(); socket!.onFrame?.(welcome(), 0); });

    fireEvent.change(composer, { target: { value: "refused B" } });
    await act(async () => { fireEvent.submit(composer.closest("form")!); });
    await act(async () => { socket!.onFrame?.({ t: "error", message: "prompting is unavailable until the host finishes starting up" }, 0); });

    // B was refused: its text is restored. A belonged to the previous physical
    // connection, so the refusal must not consume it — it never gets a row removed.
    expect(composer.value).toBe("refused B");
    expect(view.container.querySelectorAll(".message-card.user")).toHaveLength(1);
  });

  it("V15 folder load-more: A→B→A and a same-path reload both drop the stale failure", async () => {
    let complete!: (value: any) => void;
    vi.mocked(api.browse).mockImplementation((path, options) =>
      options?.cursor
        ? new Promise((resolve) => { complete = resolve; })
        : Promise.resolve((path ?? "/work") === "/work" ? listing("/work", ["/work/other"], "page2") : listing(path!, [])));

    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    // Navigate away and back to the same directory: a new generation either way.
    await act(async () => { fireEvent.click(screen.getByText("📁 other")); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Roots" })); });
    await act(async () => { complete({ ok: false, error: { code: "internal", message: "Stale page failure" } }); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("V15 folder load-more: cancelling the new-folder form does not leave the button stuck loading", async () => {
    let complete!: (value: ApiResult<unknown>) => void;
    vi.mocked(api.browse).mockImplementation((path, options) =>
      options?.cursor
        ? new Promise((resolve) => { complete = resolve; }) as never
        : Promise.resolve(listing("/work", ["/work/other"], "page2")));

    const view = render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />);
    await act(async () => {});
    const loadMoreButton = () => view.container.querySelector(".folder-browser-load-more") as HTMLButtonElement;

    fireEvent.click(loadMoreButton());
    expect(loadMoreButton().disabled).toBe(true);

    // Cancelling the form bumps the navigation generation without changing
    // currentPath/refreshVersion, so the load effect never re-runs.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ New Folder" })); });
    const form = screen.getByLabelText(/New folder in/).closest("form")!;
    await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Cancel" })); });

    // The stale page lands; the button must be usable again, not stuck on "Loading…".
    await act(async () => { complete({ ok: true, data: listing("/work", []).data }); });
    expect(loadMoreButton().disabled).toBe(false);
    expect(loadMoreButton().textContent).toBe("Load more");
  });

  it("V15 dialog: a late create response cannot clear a create form opened meanwhile", async () => {
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [] });
    let finishCreate!: (value: any) => void;
    // jsdom in this repo has no Promise.withResolvers; the deferred resolver is needed to land the response late.
    vi.mocked(api.createProject).mockReturnValue(new Promise((resolve) => { finishCreate = resolve; }) as never);
    vi.mocked(api.browse).mockImplementation(async (path) => listing(path ?? "/work", ["/work/one", "/work/two"]));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    // Create A: browse → pick /work/one → submit, leave the request in flight.
    fireEvent.click(screen.getByRole("button", { name: "+ New Project" }));
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByText("📁 one")); });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    fireEvent.change(screen.getByPlaceholderText(/Display label/), { target: { value: "A label" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    // Cancel, then start a second create with a different folder and label.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "+ New Project" }));
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByText("📁 two")); });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    fireEvent.change(screen.getByPlaceholderText(/Display label/), { target: { value: "B label" } });
    // A's response lands: it may refresh the list, but must not clear B's form.
    await act(async () => { finishCreate({ ok: true, data: { id: "p-a", label: "A label", path: "/work/one" } }); });
    expect((screen.getByPlaceholderText(/Display label/) as HTMLInputElement).value).toBe("B label");
  });

  it("V14 star: a stale list snapshot cannot rewind a settled star nor misdirect the next click", async () => {
    const base = { id: "A", label: "A", path: "/work/A", favorite: false, conversationCount: 0, lastActivityAt: null, createdAt: "", updatedAt: "" };
    const favoriteBodies: boolean[] = [];
    const listDeferred: Array<(value: ApiResult<ProjectWithStats[]>) => void> = [];
    let finishFavorite!: (value: ApiResult<ProjectWithStats>) => void;
    vi.mocked(api.listProjects).mockResolvedValueOnce({ ok: true, data: [base] })
      .mockImplementation(() => new Promise((resolve) => { listDeferred.push(resolve); }));
    vi.mocked(api.updateProject).mockImplementation((_id, patch) => {
      // The favorite PATCH stays open; the rename PATCH resolves and triggers a reload.
      if (patch.favorite !== undefined) {
        favoriteBodies.push(patch.favorite);
        return new Promise((resolve) => { finishFavorite = resolve; }) as never;
      }
      return Promise.resolve({ ok: true, data: { ...base, label: patch.label! } });
    });
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    const card = () => within(screen.getByText("/work/A").closest(".card")! as HTMLElement);

    // Star is in flight, then a rename triggers loadProjects, which snapshots the
    // pre-star server state before the favorite PATCH settles. The reload hides the
    // list while pending, so settle both before asserting.
    fireEvent.click(card().getByTitle("Star"));
    fireEvent.click(card().getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A renamed" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    // Favorite settles: server true, UI ★.
    await act(async () => { finishFavorite({ ok: true, data: { ...base, favorite: true } }); });
    // The stale snapshot (favorite:false, taken before the star) must be dropped.
    await act(async () => { listDeferred[0]!({ ok: true, data: [base] }); });
    expect(card().queryByTitle("Unstar")).not.toBeNull();

    // The next click must express the user's real intent (unstar), not a toggle
    // computed from a rewound prop.
    fireEvent.click(card().getByTitle("Unstar"));
    await act(async () => {});
    expect(favoriteBodies).toEqual([true, false]);
  });

  it("V14 star: a failed update reports an error and releases its own flight only", async () => {
    const projects = ["A", "B"].map((id) => ({ id, label: id, path: `/work/${id}`, favorite: false, conversationCount: 0, lastActivityAt: null, createdAt: "", updatedAt: "" }));
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: projects });
    const pending: Array<{ id: string; resolve: (value: any) => void }> = [];
    vi.mocked(api.updateProject).mockImplementation((id) => new Promise((resolve) => pending.push({ id, resolve })));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    const card = (id: string) => within(screen.getByText(`/work/${id}`).closest(".card")! as HTMLElement);
    fireEvent.click(card("A").getByTitle("Star"));
    fireEvent.click(card("B").getByTitle("Star"));
    await act(async () => { pending[0]!.resolve({ ok: false, error: { code: "internal", message: "Injected star failure" } }); });
    expect(screen.getByRole("alert").textContent).toContain("Injected star failure");
    // A's failure must not have disturbed B, which is still free to settle.
    await act(async () => { pending[1]!.resolve({ ok: true, data: { ...projects[1]!, favorite: true } }); });
    expect(card("B").queryByTitle("Unstar")).not.toBeNull();
  });

  it("V15 favorite overlay: a star settling mid-reload must not drop a rename from the list", async () => {
    const base = { id: "A", label: "A", path: "/work/A", favorite: false, conversationCount: 0, lastActivityAt: null, createdAt: "", updatedAt: "" };
    const renamed = { ...base, label: "A renamed" };
    const listDeferred: Array<(value: ApiResult<ProjectWithStats[]>) => void> = [];
    let finishFavorite!: (value: ApiResult<ProjectWithStats>) => void;
    vi.mocked(api.listProjects).mockResolvedValueOnce({ ok: true, data: [base] })
      .mockImplementation(() => new Promise((resolve) => { listDeferred.push(resolve); }));
    vi.mocked(api.updateProject).mockImplementation((_id, patch) => patch.favorite !== undefined
      ? new Promise((resolve) => { finishFavorite = resolve; }) as never
      : Promise.resolve({ ok: true, data: renamed }));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    const card = () => within(screen.getByText("/work/A").closest(".card")! as HTMLElement);

    fireEvent.click(card().getByTitle("Star"));
    fireEvent.click(card().getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A renamed" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    // The star settles while the reload is still in flight. The snapshot predates
    // the star (favorite:false) but is the only carrier of the rename, so it must
    // land with the star column overlaid, not be dropped whole.
    await act(async () => { finishFavorite({ ok: true, data: { ...base, favorite: true } }); });
    await act(async () => { listDeferred[0]!({ ok: true, data: [renamed] }); });
    expect(screen.getByText("A renamed")).not.toBeNull();
    expect(card().queryByTitle("Unstar")).not.toBeNull();
  });
});
