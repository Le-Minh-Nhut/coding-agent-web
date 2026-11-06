// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { ProjectDetailView } from "../../apps/web/src/components/ProjectDetailView.js";

vi.mock("../../apps/web/src/api.js", () => ({ api: { getConversationEvents: vi.fn().mockResolvedValue({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } }), listProjects: vi.fn(), listConversations: vi.fn(), listNativeSessions: vi.fn(), createConversation: vi.fn(), restartConversation: vi.fn(), attachLiveSession: vi.fn() } }));
const managed = (id: string, ownership: "managed" | "external", state: "error" | "running" | "stopped") => ({ id, projectId: "p1", title: id, nativeSessionId: "native", nativeSessionPath: null, ownership, state, model: null, modelPreference: null, tmuxSessionId: null, tmuxSessionName: null, tmuxServerIdentity: null, tmuxPanePid: null, hostInstanceId: "host", hostGeneration: 1, createdAt: "", updatedAt: "", lastActivityAt: null });
const session = { sessionId: "native", path: "/tmp/session", cwd: "/tmp", title: "Native", updatedAt: "", live: false, hasCollabHost: false, tracked: true };
async function mount(conversations: unknown[], onSelect = vi.fn()) {
  vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [{ id: "p1", path: "/tmp", label: "Project", favorite: false, createdAt: "", updatedAt: "" }] } as never);
  vi.mocked(api.listConversations).mockResolvedValue({ ok: true, data: conversations } as never);
  vi.mocked(api.listNativeSessions).mockResolvedValue({ ok: true, data: [session] } as never);
  render(<ProjectDetailView projectId="p1" onBack={() => {}} onSelectConversation={onSelect} />);
  await screen.findByText("Native");
  return onSelect;
}
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe("R37 native retry record selection", () => {
  it("retries eligible managed error row, not preceding external row sharing native id", async () => {
    const select = await mount([managed("external", "external", "running"), managed("retry", "managed", "error")]);
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: { id: "retry" } } as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(api.restartConversation).toHaveBeenCalledWith("retry"));
    await vi.waitFor(() => expect(select).toHaveBeenCalledWith("retry"));
  });
  it("retries stopped row after non-retryable managed row and hides Retry without eligible row", async () => {
    await mount([managed("running", "managed", "running"), managed("stopped", "managed", "stopped")]);
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: true, data: { id: "stopped" } } as never);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(api.restartConversation).toHaveBeenCalledWith("stopped"));
    cleanup(); vi.clearAllMocks();
    await mount([managed("external", "external", "error"), managed("running", "managed", "running")]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
