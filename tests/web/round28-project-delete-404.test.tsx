// @vitest-environment jsdom
/**
 * D2 (round 28 post-fix audit): the delete path treated EVERY 404 on
 * DELETE /api/projects/:id as "already deleted", but the server answers
 * `fail("not_found")` for every missing project. So a delete the user never
 * performed — a stale row, or another tab having deleted it — was reported as a
 * success, and no error was shown.
 *
 * The 404 tolerance is now narrowed to the one case it was written for: a 404
 * that follows this component's own already-successful DELETE for the same
 * project id (the duplicate). A first-attempt 404 is a failure and must be shown.
 */
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

const project = (id: string, path: string) => ({
  id, path, label: id, favorite: false, conversationCount: 0,
  lastActivityAt: null, createdAt: "", updatedAt: "",
});
const ok = (data: unknown) => ({ ok: true as const, data } as never);
const deleted = { ok: true as const, data: { deleted: true, filesRemoved: false } };
const notFound = { ok: false as const, error: { code: "not_found" as const, message: "Project not found" } };

beforeEach(() => { vi.mocked(api.listProjects).mockResolvedValue(ok([])); });

const openDeleteDialog = () => fireEvent.click(screen.getByRole("button", { name: "Delete" }));
const confirmDelete = () => fireEvent.click(screen.getByRole("button", { name: "Confirm Delete" }));

async function renderProjects(projects: unknown[]) {
  vi.mocked(api.listProjects).mockResolvedValue(ok(projects));
  await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
}

describe("D2 a 404 means the deletion is done only when it follows our own delete", () => {
  it("reports a first-attempt 404 for a project the user just asked to delete", async () => {
    vi.mocked(api.deleteProject).mockResolvedValue(notFound as never);
    await renderProjects([project("A", "/work/A")]);

    openDeleteDialog();
    await act(async () => { confirmDelete(); });

    // The server never had this row: the delete failed, and claiming otherwise
    // would hide a real error behind a success the app did not earn.
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Project not found");
  });

  it("treats a 404 after our own successful delete as the duplicate it is", async () => {
    // First DELETE succeeds. The list snapshot is stale and offers the row again
    // (another tab, a cached render): the retry 404s, and that one IS our own
    // duplicate, so it stays silent instead of claiming the delete broke.
    vi.mocked(api.listProjects).mockResolvedValue(ok([project("A", "/work/A")]));
    vi.mocked(api.deleteProject).mockResolvedValueOnce(deleted as never).mockResolvedValue(notFound as never);
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    openDeleteDialog();
    await act(async () => { confirmDelete(); });
    expect(screen.queryByRole("alert")).toBeNull();

    openDeleteDialog();
    await act(async () => { confirmDelete(); });

    expect(api.deleteProject).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Delete Project" })).toBeNull();
  });

  it("releases the guard after a failed delete so the user can retry", async () => {
    vi.mocked(api.listProjects).mockResolvedValue(ok([project("A", "/work/A")]));
    vi.mocked(api.deleteProject).mockResolvedValueOnce(notFound as never).mockResolvedValueOnce(deleted as never);
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    openDeleteDialog();
    await act(async () => { confirmDelete(); });
    expect(screen.getByRole("alert")).toBeTruthy();

    await act(async () => { confirmDelete(); });

    expect(api.deleteProject).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("heading", { name: "Delete Project" })).toBeNull();
  });

  it("still sends only one DELETE while the first is in flight", async () => {
    let release!: (value: never) => void;
    const pending = new Promise<never>((resolve) => { release = resolve; });
    vi.mocked(api.deleteProject).mockReturnValue(pending);
    await renderProjects([project("A", "/work/A")]);

    openDeleteDialog();
    await act(async () => { confirmDelete(); confirmDelete(); });

    expect(api.deleteProject).toHaveBeenCalledTimes(1);
    await act(async () => { release(deleted as never); });
  });
});
