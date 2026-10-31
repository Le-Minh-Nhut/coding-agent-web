// @vitest-environment jsdom
// F06: the delete-confirm path had no in-flight guard and no disabled Confirm, so
// two Confirm presses could send two DELETEs for a project that is already gone
// (404), which HEAD then reported as a failure of an action that had succeeded.
// F07: loadProjects released `loading` before the staleness check, so an older list
// response landing late cleared the spinner the newer request still needed.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectsView, resetProjectMutationState } from "../../apps/web/src/components/ProjectsView.js";
import { api } from "../../apps/web/src/api.js";
import { resetMutationQueues } from "../../apps/web/src/mutation-order.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    listProjects: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), createProject: vi.fn(),
    browse: vi.fn(), createDirectory: vi.fn(),
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

const project = (id: string, path: string) => ({
  id, path, label: id, favorite: false, conversationCount: 0,
  lastActivityAt: null, createdAt: "", updatedAt: "",
});
const ok = (data: unknown) => ({ ok: true as const, data } as never);
const deleted = { ok: true as const, data: { deleted: true, filesRemoved: false } };
const notFound = { ok: false as const, error: { code: "not_found" as const, message: "Project not found" } };

function listingFor(path: string) {
  return ok({
    path, parent: null, roots: ["/work"],
    entries: [{ name: "made", path: `${path}/made`, isDirectory: true, allowed: true, hasProject: false }],
    hasMore: false, nextCursor: null,
  });
}

async function renderProjects(projects: unknown[]) {
  vi.mocked(api.listProjects).mockResolvedValue(ok(projects));
  await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
}

// Every path that deletes also refreshes the list. A mock left without a queued
// return yields `undefined`, which loadProjects would dereference, so every case
// starts from an answered list and overrides it per call.
beforeEach(() => { vi.mocked(api.listProjects).mockResolvedValue(ok([])); });

const openDeleteDialog = (screen_ = screen) => fireEvent.click(screen_.getByRole("button", { name: "Delete" }));
const confirmDelete = () => fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

describe("F06 delete is one operation at a time", () => {
  it("sends one DELETE when Confirm is pressed twice before the first settles", async () => {
    const pending = deferred<never>();
    vi.mocked(api.deleteProject).mockReturnValue(pending.promise);
    await renderProjects([project("A", "/work/A")]);

    openDeleteDialog();
    await act(async () => { confirmDelete(); confirmDelete(); });

    expect(api.deleteProject).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(deleted as never); });
    expect(screen.queryByRole("heading", { name: "Delete Project" })).toBeNull();
  });

  it("does not send a second DELETE for the same project when its dialog is reopened", async () => {
    const pending = deferred<never>();
    vi.mocked(api.deleteProject).mockReturnValueOnce(pending.promise);
    vi.mocked(api.listProjects).mockResolvedValueOnce(ok([project("A", "/work/A")]));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    openDeleteDialog();
    await act(async () => { confirmDelete(); });
    // Cancel, then reopen the same project's dialog while the first DELETE is open.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openDeleteDialog();
    await act(async () => { confirmDelete(); });

    // The project is already being deleted: a second request would 404 and tell the
    // user their successful delete failed.
    expect(api.deleteProject).toHaveBeenCalledTimes(1);

    await act(async () => { pending.resolve(deleted as never); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Delete Project" })).toBeNull();
  });

  it("still lets a different project be deleted after the dialog is reopened", async () => {
    const pendingA = deferred<never>();
    vi.mocked(api.deleteProject).mockReturnValueOnce(pendingA.promise).mockResolvedValue(deleted as never);
    vi.mocked(api.listProjects).mockResolvedValueOnce(ok([project("A", "/work/A"), project("B", "/work/B")]));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    // A's dialog: confirm (held open), then abandon it.
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    await act(async () => { confirmDelete(); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // B's dialog must not be blocked by A's in-flight delete.
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[1]!);
    await act(async () => { confirmDelete(); });

    expect(api.deleteProject).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.deleteProject).mock.calls[1]?.[0]).toBe("B");

    await act(async () => { pendingA.resolve(deleted as never); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a first-attempt 404 as a failure, not as an already-done delete", async () => {
    vi.mocked(api.listProjects).mockResolvedValue(ok([project("A", "/work/A")]));
    vi.mocked(api.deleteProject).mockResolvedValue(notFound as never);
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    openDeleteDialog();
    await act(async () => { confirmDelete(); });

    // The server answers `fail("not_found")` for every missing project, so a 404 on
    // the first attempt cannot be credited to this component: the app did not delete
    // this row and must not claim it did. The dialog stays open for a retry.
    expect(screen.getByRole("alert").textContent).toContain("Project not found");
    expect(screen.getByRole("heading", { name: "Delete Project" })).not.toBeNull();
  });

  it("treats a 404 that follows this view's own successful delete as the duplicate it is", async () => {
    vi.mocked(api.listProjects)
      .mockResolvedValueOnce(ok([project("A", "/work/A")]))
      .mockResolvedValueOnce(ok([project("A", "/work/A")]))
      .mockResolvedValue(ok([]));
    vi.mocked(api.deleteProject).mockResolvedValueOnce(deleted as never).mockResolvedValue(notFound as never);
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    openDeleteDialog();
    await act(async () => { confirmDelete(); });
    expect(screen.queryByRole("alert")).toBeNull();

    // The stale list still offers the row; a second confirm 404s. That 404 is this
    // view's own duplicate, so it is silent and the dialog closes.
    openDeleteDialog();
    await act(async () => { confirmDelete(); });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Delete Project" })).toBeNull();
    // And the list is reconciled with the server: the deleted row is actually gone
    // from the screen. A call count alone would pass for a repaint with stale data.
    expect(screen.queryByRole("heading", { name: "A" })).toBeNull();
    expect(screen.getByText("No projects added yet.")).toBeTruthy();
  });

  it("disables Confirm while the DELETE is open", async () => {
    const pending = deferred<never>();
    vi.mocked(api.deleteProject).mockReturnValue(pending.promise);
    await renderProjects([project("A", "/work/A")]);

    openDeleteDialog();
    await act(async () => { confirmDelete(); });

    expect((screen.getByRole("button", { name: "Confirm Delete" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { pending.resolve(deleted as never); });
  });
});

describe("F07 loading belongs to the newest list request", () => {
  it("keeps the spinner when a superseded list response lands while a newer read is open", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    vi.mocked(api.listProjects).mockReset();
    vi.mocked(api.listProjects).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.mocked(api.browse).mockResolvedValue(listingFor("/work") as never);
    vi.mocked(api.createProject).mockResolvedValue(ok(project("New", "/work/made")) as never);

    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    expect(screen.getByText("Loading projects…")).toBeTruthy();

    // Start a second read on the same mounted view: a successful create refreshes
    // the list, and its read is now the current one.
    fireEvent.click(screen.getByRole("button", { name: "+ New Project" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    fireEvent.change(screen.getByPlaceholderText(/Display label/), { target: { value: "New" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });
    expect(api.listProjects).toHaveBeenCalledTimes(2);

    // The older read settles first, and the newer one is still in flight: the read
    // the user is waiting on has not finished, so the spinner must stay.
    await act(async () => { first.resolve(ok([project("A", "/work/A")]) as never); });

    expect(screen.getByText("Loading projects…")).toBeTruthy();
    expect(screen.queryByText("/work/A")).toBeNull();

    await act(async () => { second.resolve(ok([project("New", "/work/made")]) as never); });
    expect(screen.queryByText("Loading projects…")).toBeNull();
    expect(screen.getByText("/work/made")).toBeTruthy();
  });

  it("clears the spinner when the newest read is the one that settles last", async () => {
    const first = deferred<never>();
    const second = deferred<never>();
    vi.mocked(api.listProjects).mockReset();
    vi.mocked(api.listProjects).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.mocked(api.browse).mockResolvedValue(listingFor("/work") as never);
    vi.mocked(api.createProject).mockResolvedValue(ok(project("New", "/work/made")) as never);

    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: "+ New Project" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    fireEvent.change(screen.getByPlaceholderText(/Display label/), { target: { value: "New" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });

    await act(async () => { second.resolve(ok([project("New", "/work/made")]) as never); });
    expect(screen.queryByText("Loading projects…")).toBeNull();
    expect(screen.getByText("/work/made")).toBeTruthy();

    // The superseded response lands afterwards and must not repaint anything.
    await act(async () => { first.resolve(ok([project("A", "/work/A")]) as never); });
    expect(screen.queryByText("/work/A")).toBeNull();
    expect(screen.getByText("/work/made")).toBeTruthy();
  });
});
