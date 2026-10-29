// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../../apps/web/src/App.js";
import { api } from "../../apps/web/src/api.js";
vi.mock("../../apps/web/src/api.js", () => ({ api: { getMe: vi.fn(), getCapabilities: vi.fn(), listProjects: vi.fn(), getRuntime: vi.fn(), logout: vi.fn() } }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("V17 a failed logout cannot present the user as signed out while the session still authenticates", async () => {
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "test-csrf" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as any);
  vi.mocked(api.listProjects).mockResolvedValue({ ok: true, data: [] });
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this fixture" } });
  vi.mocked(api.logout).mockResolvedValue({ ok: false, error: { code: "internal", message: "Offline: logout did not reach server" } });
  const view = render(<App />);
  await screen.findByText("Projects");
  fireEvent.click(screen.getByTitle("Settings"));
  await screen.findByRole("button", { name: "Sign out" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
  const fakeSignedOut = !!screen.queryByRole("button", { name: "Sign in" });
  view.unmount();
  await act(async () => { render(<App />); });
  const authenticatedOnReload = !!screen.queryByText("Projects");
  console.log("AUDIT17 logout failed", JSON.stringify({ fakeSignedOut, authenticatedOnReload }));
  expect(authenticatedOnReload).toBe(true);
  expect(fakeSignedOut).toBe(false);
});
