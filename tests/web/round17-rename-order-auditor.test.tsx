// @vitest-environment jsdom
import React from "react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { ProjectsView } from "../../apps/web/src/components/ProjectsView.js";
import { createMetadataStore } from "../../apps/server/src/store.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: { listProjects: vi.fn(), updateProject: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("V17 a late older Rename Save must not overwrite the latest label on the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "caw-r17-rename-"));
  try {
    const store = createMetadataStore(dir); const p = await store.createProject({ path: "/work/A", label: "Original" });
    vi.mocked(api.listProjects).mockImplementation(async () => ({ ok: true, data: (await store.listProjects()).map(p => ({ ...p, conversationCount: 0, lastActivityAt: null })) }));
    const pending: Array<{ id: string; label: string; resolve: (value: any) => void }> = [];
    vi.mocked(api.updateProject).mockImplementation((id, patch) => new Promise(resolve => pending.push({ id, label: patch.label!, resolve })));
    await act(async () => { render(<ProjectsView onSelectProject={() => {}} onOpenSettings={() => {}} />); });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "First label" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Final label" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const finish = async (request: typeof pending[number]) => { const result = await store.updateProject(request.id, { label: request.label }); await act(async () => { request.resolve({ ok: true, data: result }); }); };
    // A corrected UI may coalesce or disable while pending. Only apply whichever
    // requests it emitted, with the old request arriving last if both were sent.
    if (pending.length === 2) { await finish(pending[1]!); await finish(pending[0]!); }
    else { await finish(pending[0]!); if (pending.length === 2) await finish(pending[1]!); }
    const label = (await createMetadataStore(dir).listProjects()).find(row => row.id === p.id)!.label;
    console.log("AUDIT17 Rename ordering", JSON.stringify({ requests: pending.map(r => r.label), persistedLabel: label }));
    expect(label).toBe("Final label");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
