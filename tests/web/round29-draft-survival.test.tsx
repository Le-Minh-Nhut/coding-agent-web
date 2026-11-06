// @vitest-environment jsdom
import React from "react";
import type { ChangeEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Capabilities } from "@caw/contracts";
import { api } from "../../apps/web/src/api.js";
import { App } from "../../apps/web/src/App.js";

vi.mock("../../apps/web/src/api.js", () => ({
  api: { getMe: vi.fn(), getCapabilities: vi.fn(), getAgentLimit: vi.fn() },
  setCsrfToken: vi.fn(),
}));

vi.mock("../../apps/web/src/components/LoginView.js", () => ({
  LoginView: ({ onSuccess }: { onSuccess: () => void }) =>
    React.createElement("button", { onClick: onSuccess }, "Sign in"),
}));

vi.mock("../../apps/web/src/components/ProjectsView.js", () => ({
  ProjectsView: ({ onSelectProject, onOpenSettings }: { onSelectProject: (id: string) => void; onOpenSettings: () => void }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { onClick: () => onSelectProject("p1") }, "Open project"),
      React.createElement("button", { onClick: onOpenSettings }, "Open settings"),
    ),
  resetProjectMutationState: () => {},
}));

vi.mock("../../apps/web/src/components/SettingsView.js", () => ({
  SettingsView: ({ onLogout }: { onLogout: () => void }) =>
    React.createElement("button", { onClick: onLogout }, "Sign out"),
}));

vi.mock("../../apps/web/src/components/ProjectDetailView.js", () => ({
  ProjectDetailView: ({ onSelectConversation, onBack }: { onSelectConversation: (id: string) => void; onBack: () => void }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement("button", { onClick: () => onSelectConversation("c1") }, "Open first"),
      React.createElement("button", { onClick: onBack }, "Back to projects"),
    ),
}));

vi.mock("../../apps/web/src/components/ConversationView.js", () => ({
  ConversationView: ({
    draft,
    onDraftChange,
    refusedRecoveries,
    onRefusedRecoveriesChange,
    onBack,
  }: {
    draft: string;
    onDraftChange: (value: string) => void;
    refusedRecoveries?: Array<{ id: number; text: string }>;
    onRefusedRecoveriesChange?: (next: Array<{ id: number; text: string }>) => void;
    onBack: () => void;
  }) =>
    React.createElement(
      React.Fragment,
      null,
      React.createElement("textarea", {
        value: draft,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onDraftChange(event.target.value),
      }),
      React.createElement("div", { "data-testid": "refused-count" }, String(refusedRecoveries?.length ?? 0)),
      React.createElement("button", {
        onClick: () => onRefusedRecoveriesChange?.([{ id: 1, text: "refused prompt A" }]),
      }, "Add refusal"),
      React.createElement("button", { onClick: onBack }, "Back to project"),
    ),
}));

describe("CAW-10 Intentional contract: drafts and recoveries survive session auth transitions", () => {
  beforeEach(() => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "owner-token" } });
    vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} as Capabilities });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("preserves conversation draft and refused recoveries when single owner re-authenticates after logout", async () => {
    render(<App />);

    // Navigate to conversation and establish an in-progress draft and a refused recovery item
    fireEvent.click(await screen.findByRole("button", { name: "Open project" }));
    fireEvent.click(screen.getByRole("button", { name: "Open first" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "owner work in progress" } });
    fireEvent.click(screen.getByRole("button", { name: "Add refusal" }));
    expect(screen.getByTestId("refused-count").textContent).toBe("1");

    // Back out to settings and sign out
    fireEvent.click(screen.getByRole("button", { name: "Back to project" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    // User is on Login screen (session ended)
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();

    // Owner logs back in
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // Navigate back to the conversation
    fireEvent.click(await screen.findByRole("button", { name: "Open project" }));
    fireEvent.click(screen.getByRole("button", { name: "Open first" }));

    // Both the draft text and the refused recovery notice MUST survive
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("owner work in progress");
    expect(screen.getByTestId("refused-count").textContent).toBe("1");
  });
});
