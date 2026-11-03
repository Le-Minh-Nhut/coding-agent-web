// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { ProjectDetailView } from "../../apps/web/src/components/ProjectDetailView.js";

vi.mock("../../apps/web/src/api.js", () => ({ api: { listProjects: vi.fn(), listConversations: vi.fn(), listNativeSessions: vi.fn(), createConversation: vi.fn(), restartConversation: vi.fn(), attachLiveSession: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("R37 project switch actions", () => {
  it("unlocks resume action immediately on project switch", async () => {
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [{ id: "a", path: "/a", label: "A" }, { id: "b", path: "/b", label: "B" }] } as never);
    vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: [] } as never);
    const native = { sessionId: "native", path: "/a/session", cwd: "/a", title: "Session", updatedAt: "", live: false, hasCollabHost: false, tracked: false };
    vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: true, data: [native] } as never);
    vi.mocked(api.createConversation).mockReturnValue(new Promise(() => {}) as never);
    const view = render(<ProjectDetailView projectId="a" onBack={() => {}} onSelectConversation={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume in app" }));
    view.rerender(<ProjectDetailView projectId="b" onBack={() => {}} onSelectConversation={() => {}} />);
    await vi.waitFor(() => expect((screen.getByRole("button", { name: "Resume in app" }) as HTMLButtonElement).disabled).toBe(false));
  });
});
