// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api } from "../../apps/web/src/api.js";
import { App } from "../../apps/web/src/App.js";
import { resetProjectMutationState } from "../../apps/web/src/components/ProjectsView.js";

vi.mock("../../apps/web/src/api.js", () => ({ api: { getMe: vi.fn(), getCapabilities: vi.fn() }, setCsrfToken: vi.fn() }));
vi.mock("../../apps/web/src/components/ProjectsView.js", () => ({
  ProjectsView: () => React.createElement("div", null, "Project screen"),
  resetProjectMutationState: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
// The retryable surface has to name itself: a probe that could not decide the session
// state is not a sign-out, but it must not be a blank screen either.
const retry = () => screen.queryByRole("button", { name: "Retry" });
const signIn = () => screen.queryByRole("button", { name: "Sign in" });

describe("WEB-01 startup taxonomy", () => {
  it("keeps the session when capabilities fail transiently after an authenticated getMe", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "live" } });
    vi.mocked(api.getCapabilities).mockResolvedValue({ ok: false, error: { code: "internal", message: "Internal server error" }, httpStatus: 500 });
    render(<App />);
    await waitFor(() => expect(retry()).not.toBeNull());
    expect(signIn()).toBeNull();
    // Session-scoped in-memory state is only ever retired by a real auth loss.
    expect(vi.mocked(resetProjectMutationState)).not.toHaveBeenCalled();
  });

  it("keeps the session when capabilities fail without any status (transport failure)", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "live" } });
    vi.mocked(api.getCapabilities).mockResolvedValue({ ok: false, error: { code: "internal", message: "Network request failed" } });
    render(<App />);
    await waitFor(() => expect(retry()).not.toBeNull());
    expect(signIn()).toBeNull();
  });

  it("never presents a getMe 500 as a sign-out", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: false, error: { code: "internal", message: "Internal server error" }, httpStatus: 500 });
    render(<App />);
    await waitFor(() => expect(retry()).not.toBeNull());
    expect(signIn()).toBeNull();
    expect(vi.mocked(resetProjectMutationState)).not.toHaveBeenCalled();
  });

  it("never presents a getMe transport failure as a sign-out", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: false, error: { code: "internal", message: "Network request failed" } });
    render(<App />);
    await waitFor(() => expect(retry()).not.toBeNull());
    expect(signIn()).toBeNull();
  });

  it("retries the probe from the error surface and enters the workspace once it answers", async () => {
    vi.mocked(api.getMe).mockResolvedValueOnce({ ok: false, error: { code: "internal", message: "Network request failed" } });
    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "live" } });
    vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} as never });
    render(<App />);
    await waitFor(() => expect(retry()).not.toBeNull());
    fireEvent.click(retry()!);
    expect(await screen.findByText("Project screen")).toBeTruthy();
  });

  it("still shows the login form for a genuine 401", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: false, httpStatus: 401, error: { code: "unauthorized", message: "Authentication required" } });
    render(<App />);
    await waitFor(() => expect(signIn()).not.toBeNull());
    expect(retry()).toBeNull();
    expect(vi.mocked(resetProjectMutationState)).toHaveBeenCalled();
  });

  it("opens the workspace when both probes succeed", async () => {
    vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "live" } });
    vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} as never });
    render(<App />);
    expect(await screen.findByText("Project screen")).toBeTruthy();
  });
});
