// @vitest-environment jsdom
// Regression coverage for the round-16 web fixes, covering the branches the
// auditor probes do not: the failure path of a coalesced favorite write, a
// cross-project pair of in-flight writes, every create-form ownership order
// (a stale settle racing B's own submit, A failure), and the folder load-more
// owner across A→B→A and a duplicate same-cursor click.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { FolderBrowser } from "../../apps/web/src/components/FolderBrowser.js";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: { listProjects: vi.fn(), updateProject: vi.fn(), createProject: vi.fn(), deleteProject: vi.fn(), browse: vi.fn(), createDirectory: vi.fn() },
}));

const project = (id: string, favorite = false) => ({ id, label: id, path: `/work/${id}`, favorite, conversationCount: 0, lastActivityAt: null, createdAt: "", updatedAt: "" });
const child = (path: string) => ({ name: path.split("/").at(-1)!, path, isDirectory: true, allowed: true, hasProject: false });
const listing = (path: string, children: string[], cursor: string | null = null) => ({ ok: true as const, data: { path, parent: null, roots: ["/work"], entries: children.map(child), hasMore: cursor !== null, nextCursor: cursor } });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("round16 web regressions", () => {
  it("V16 star: a failed write still delivers the newest intent recorded while it was open", async () => {
    const base = project("A");
    const drifted = { ...base, favorite: true };
    const bodies: boolean[] = [];
    const pending: Array<{ favorite: boolean; resolve: (value: unknown) => void }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(api.listProjects).mockResolvedValueOnce({ ok: true, data: [base] }).mockResolvedValue({ ok: true, data: [drifted] });
    vi.mocked(api.updateProject).mockImplementation((_id, patch) => {
      if (patch.favorite === undefined) return Promise.resolve({ ok: true, data: { ...base, label: patch.label! } }) as never;
      bodies.push(patch.favorite);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => { pending.push({ favorite: patch.favorite!, resolve: (value: unknown) => { inFlight--; resolve(value); } }); }) as never;
    });
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    const card = () => within(screen.getByText("/work/A").closest(".card")! as HTMLElement);

    // The star write is in flight and its delivery is delayed.
    fireEvent.click(card().getByTitle("Star"));
    expect(bodies).toEqual([true]);
    // An unrelated reload drifts the displayed value to starred (server already changed).
    fireEvent.click(card().getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A renamed" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    expect(card().queryByTitle("Unstar")).not.toBeNull();
    // The user's newest intent is the opposite of the write still in flight.
    fireEvent.click(card().getByTitle("Unstar"));
    expect(bodies).toEqual([true]);

    // The in-flight write fails: the recorded intent must not be lost with it.
    await act(async () => { pending[0]!.resolve({ ok: false, error: { code: "internal", message: "Injected star failure" } }); });
    expect(screen.getByRole("alert").textContent).toContain("Injected star failure");
    expect(bodies).toEqual([true, false]);
    await act(async () => { pending[1]!.resolve({ ok: true, data: { ...base, favorite: false } }); });
    expect(maxInFlight).toBe(1);
    expect(card().queryByTitle("Star")).not.toBeNull();
  });

  it("V16 star: two projects' writes are independent and neither serializes the other", async () => {
    const projects = [project("A"), project("B")];
    const pending: Array<{ id: string; resolve: (value: unknown) => void }> = [];
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: projects });
    vi.mocked(api.updateProject).mockImplementation((id) => new Promise((resolve) => pending.push({ id, resolve })) as never);
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    const card = (id: string) => within(screen.getByText(`/work/${id}`).closest(".card")! as HTMLElement);
    fireEvent.click(card("A").getByTitle("Star"));
    fireEvent.click(card("B").getByTitle("Star"));
    expect(pending.map((p) => p.id)).toEqual(["A", "B"]);
    await act(async () => { pending[1]!.resolve({ ok: true, data: { ...projects[1]!, favorite: true } }); });
    expect(card("B").queryByTitle("Unstar")).not.toBeNull();
    expect(card("A").queryByTitle("Star")).not.toBeNull();
    await act(async () => { pending[0]!.resolve({ ok: true, data: { ...projects[0]!, favorite: true } }); });
    expect(card("A").queryByTitle("Unstar")).not.toBeNull();
  });

  const openCreateForm = async (folder: string) => {
    fireEvent.click(screen.getByRole("button", { name: "+ New Project" }));
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByText(`📁 ${folder}`)); });
    fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
    fireEvent.change(screen.getByPlaceholderText(/Display label/), { target: { value: `${folder} label` } });
  };
  const createButton = () => screen.getByRole("button", { name: /^Create$/ }) as HTMLButtonElement;

  it("V16 create: a stale response cannot clear the pending of a form submitted meanwhile", async () => {
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [] });
    const creates: Array<(value: unknown) => void> = [];
    vi.mocked(api.createProject).mockImplementation(() => new Promise((resolve) => creates.push(resolve)) as never);
    vi.mocked(api.browse).mockImplementation(async (path) => path ? listing(path, []) : listing("/work", ["/work/A", "/work/B"]));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    await openCreateForm("A");
    fireEvent.click(createButton());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openCreateForm("B");
    // B submits before A settles: B has its own pending write.
    fireEvent.click(createButton());
    expect(creates).toHaveLength(2);
    // A settles first; it must not release B's pending button.
    await act(async () => { creates[0]!({ ok: true, data: { ...project("A"), path: "/work/A" } }); });
    expect(createButton().disabled).toBe(true);
    expect((screen.getByPlaceholderText(/Display label/) as HTMLInputElement).value).toBe("B label");
    // B settles: its own pending is the one that releases, and the form closes.
    await act(async () => { creates[1]!({ ok: true, data: { ...project("B"), path: "/work/B" } }); });
    expect(screen.queryByRole("button", { name: /^Create$/ })).toBeNull();
  });

  it("V16 create: a failed stale response neither disables nor blames the new form", async () => {
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [] });
    let finishCreates!: (value: unknown) => void;
    vi.mocked(api.createProject).mockReturnValue(new Promise((resolve) => { finishCreates = resolve; }) as never);
    vi.mocked(api.browse).mockImplementation(async (path) => path ? listing(path, []) : listing("/work", ["/work/A", "/work/B"]));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });

    await openCreateForm("A");
    fireEvent.click(createButton());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openCreateForm("B");
    await act(async () => { finishCreates({ ok: false, error: { code: "internal", message: "Injected create failure" } }); });
    // A's failure belongs to A: B's form stays usable and carries no error.
    expect(createButton().disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByPlaceholderText(/Display label/) as HTMLInputElement).value).toBe("B label");
  });

  it("V16 folder: the load-more owner survives A→B→A and blocks a duplicate same-cursor click", async () => {
    const pending: Array<{ path: string; cursor: string; resolve: (value: unknown) => void }> = [];
    vi.mocked(api.browse).mockImplementation((path, options) => options?.cursor
      ? new Promise((resolve) => pending.push({ path: path!, cursor: options.cursor!, resolve })) as never
      : Promise.resolve(path === "/work/B" ? listing("/work/B", ["/work/B/head"], "b2") : listing("/work", ["/work/B"], "a2")));
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    const loadMore = () => screen.getByRole("button", { name: /Load more|Loading/ }) as HTMLButtonElement;

    fireEvent.click(loadMore());
    expect(pending.map((p) => p.path)).toEqual(["/work"]);
    // A duplicate click while the owner is in flight must not resubmit the cursor.
    fireEvent.click(loadMore());
    expect(pending).toHaveLength(1);

    await act(async () => { fireEvent.click(screen.getByText("📁 B")); });
    fireEvent.click(loadMore());
    expect(pending.map((p) => p.path)).toEqual(["/work", "/work/B"]);
    // A's (old generation) completion must leave B's pending alone.
    await act(async () => { pending[0]!.resolve(listing("/work", ["/work/old-tail"])); });
    expect(loadMore().disabled).toBe(true);
    fireEvent.click(loadMore());
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!.resolve(listing("/work/B", ["/work/B/tail"])); });
    expect(screen.queryAllByText("📁 tail")).toHaveLength(1);

    // Back to A: a fresh generation may load its own next page.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Roots" })); });
    expect(loadMore().disabled).toBe(false);
    fireEvent.click(loadMore());
    expect(pending.map((p) => p.path)).toEqual(["/work", "/work/B", "/work"]);
    await act(async () => { pending[2]!.resolve(listing("/work", [])); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("V16 folder: an old generation's failure is not reported for the directory shown now", async () => {
    const pending: Array<{ resolve: (value: unknown) => void }> = [];
    vi.mocked(api.browse).mockImplementation((path, options) => options?.cursor
      ? new Promise((resolve) => pending.push({ resolve })) as never
      : Promise.resolve(path === "/work/B" ? listing("/work/B", ["/work/B/head"], "b2") : listing("/work", ["/work/B"], "a2")));
    await act(async () => { render(<FolderBrowser onSelect={() => {}} onCancel={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: /Load more/ }));
    await act(async () => { fireEvent.click(screen.getByText("📁 B")); });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => { pending[0]!.resolve({ ok: false, error: { code: "internal", message: "Old directory page failed" } }); });
    expect(screen.queryByRole("alert")).toBeNull();
    // B still owns the pending slot and can settle normally.
    await act(async () => { pending[1]!.resolve(listing("/work/B", ["/work/B/tail"])); });
    expect(screen.queryAllByText("📁 tail")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
