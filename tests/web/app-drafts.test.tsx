// @vitest-environment jsdom
import React from "react";
import type { ChangeEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { App } from "../../apps/web/src/App.js";

vi.mock("../../apps/web/src/api.js", () => ({ api: { getMe: vi.fn(), getCapabilities: vi.fn() } }));
vi.mock("../../apps/web/src/components/LoginView.js", () => ({
  LoginView: () => React.createElement("div", null, "Login"),
}));
vi.mock("../../apps/web/src/components/ProjectsView.js", () => ({
  ProjectsView: ({ onSelectProject }: { onSelectProject: (id: string) => void }) => React.createElement("button", { onClick: () => onSelectProject("p1") }, "Open project"),
}));
vi.mock("../../apps/web/src/components/ProjectDetailView.js", () => ({
  ProjectDetailView: ({ onSelectConversation, onBack }: { onSelectConversation: (id: string) => void; onBack: () => void }) => React.createElement(React.Fragment, null,
    React.createElement("button", { onClick: () => onSelectConversation("c1") }, "Open first"),
    React.createElement("button", { onClick: () => onSelectConversation("c2") }, "Open second"),
    React.createElement("button", { onClick: onBack }, "Back to projects")),
}));
vi.mock("../../apps/web/src/components/ConversationView.js", () => ({
  ConversationView: ({ draft, onDraftChange, onBack }: { draft: string; onDraftChange: (value: string) => void; onBack: () => void }) => React.createElement(React.Fragment, null,
    React.createElement("textarea", { value: draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onDraftChange(event.target.value) }),
    React.createElement("button", { onClick: onBack }, "Back to project")),
}));

describe("App conversation drafts", () => {
  beforeEach(() => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "test" } });
    vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} as Awaited<ReturnType<typeof api.getCapabilities>>["data"] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps separate drafts when switching conversations and returning", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open project" }));
    fireEvent.click(screen.getByRole("button", { name: "Open first" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "first draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to project" }));
    fireEvent.click(screen.getByRole("button", { name: "Open second" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "second draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to project" }));
    fireEvent.click(screen.getByRole("button", { name: "Open first" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("first draft");
  });
});