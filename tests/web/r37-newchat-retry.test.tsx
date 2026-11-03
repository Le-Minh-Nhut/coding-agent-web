// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { ProjectDetailView } from "../../apps/web/src/components/ProjectDetailView.js";

vi.mock("../../apps/web/src/api.js", () => ({ api: { listProjects: vi.fn(), listConversations: vi.fn(), listNativeSessions: vi.fn(), createConversation: vi.fn(), restartConversation: vi.fn(), attachLiveSession: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("R37 failed new-chat retry", () => {
  it("refreshes persisted error row after failed launch and retries same id", async () => {
    const failed = { id: "failed", projectId: "p1", title: "New chat", ownership: "managed", state: "error", nativeSessionId: null, model: null, modelPreference: null, tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null, tmuxPanePid: null, hostInstanceId: null, hostGeneration: null, createdAt: "", updatedAt: "", lastActivityAt: null, statusDetail: "Launch failed" };
    vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [{ id: "p1", path: "/tmp", label: "Project", favorite: false, createdAt: "", updatedAt: "" }] } as never);
    vi.mocked(api.listConversations).mockResolvedValueOnce({ ok: true, data: [] }).mockResolvedValueOnce({ ok: true, data: [failed] } as never);
    vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: true, data: [] } as never);
    vi.mocked(api.createConversation).mockResolvedValue({ ok: false, error: { code: "internal", message: "launch rejected" } } as never);
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: failed } as never);
    render(<ProjectDetailView projectId="p1" onBack={() => {}} onSelectConversation={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ New chat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry launch" }));
    await vi.waitFor(() => expect(api.restartConversation).toHaveBeenCalledWith("failed"));
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });
});
