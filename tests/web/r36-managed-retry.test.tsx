// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { ProjectDetailView } from "../../apps/web/src/components/ProjectDetailView.js";

vi.mock("../../apps/web/src/api.js", () => ({ api: { getConversationEvents: vi.fn().mockResolvedValue({ ok: true, data: { events: [], nextAfter: null, nextBefore: null } }), listProjects: vi.fn(), listConversations: vi.fn(), listNativeSessions: vi.fn(), createConversation: vi.fn(), restartConversation: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const conversation = { id: "failed-id", projectId: "p", title: "Failed chat", ownership: "managed", state: "error", nativeSessionId: null, model: null, modelPreference: null, statusDetail: "Launch failed" } as const;
const ok = (data: unknown) => ({ ok: true as const, data });
async function mount(onSelectConversation = vi.fn()) {
  vi.mocked(api.listProjects).mockResolvedValue(ok([{ id: "p", label: "Project", path: "/work" }]) as never);
  vi.mocked(api.listConversations).mockResolvedValue(ok([conversation]) as never);
  vi.mocked(api.listNativeSessions).mockResolvedValue(ok([]) as never);
  const view = render(<ProjectDetailView projectId="p" onBack={() => {}} onSelectConversation={onSelectConversation} />);
  return { onSelectConversation, rerender: view.rerender };
}
describe("R36 managed failed chat retry", () => {
  it("retries same conversation after launch failure and dedupes taps", async () => {
    const pending = new Promise<unknown>(() => {});
    vi.mocked(api.restartConversation).mockReturnValue(pending as never);
    await mount();
    const retry = await screen.findByRole("button", { name: "Retry launch" });
    fireEvent.click(retry); fireEvent.click(retry);
    expect(api.restartConversation).toHaveBeenCalledTimes(1);
    expect(api.restartConversation).toHaveBeenCalledWith("failed-id");
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(retry.textContent).toBe("Retrying…");
    expect(api.createConversation).not.toHaveBeenCalled();
  });
  it("surfaces conflict_owner without launching another writer", async () => {
    vi.mocked(api.restartConversation).mockResolvedValue({ ok: false, error: { code: "conflict_owner", message: "Writer cannot be verified" } } as never);
    await mount();
    fireEvent.click(await screen.findByRole("button", { name: "Retry launch" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no second agent was started");
    expect(api.restartConversation).toHaveBeenCalledTimes(1);
    expect(api.createConversation).not.toHaveBeenCalled();
  });
});
