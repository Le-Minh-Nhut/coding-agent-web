// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/web/src/App.js";
import { api } from "../../apps/web/src/api.js";
import { resetMutationQueues } from "../../apps/web/src/mutation-order.js";
import { resetProjectMutationState } from "../../apps/web/src/components/ProjectsView.js";

/**
 * V25-01 feedback path: a rename write issued from a ProjectsView that has since
 * unmounted (Cancel → Settings → Back) must still settle the dialog the *live*
 * view has open and refresh the list it shows.
 *
 * The server-side ordering claim is covered by round25-mutation-lifetime-auditor
 * (and by the e2e spec, which reads the persisted label back). What that pair
 * cannot see is this: the response's feedback runs against the dead instance's
 * closure, so on screen the reopened dialog never closes and the card keeps the
 * stale label even though the server holds the new one.
 */
vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getMe: vi.fn(),
    getCapabilities: vi.fn(),
    getRuntime: vi.fn(),
    listProjects: vi.fn(),
    updateProject: vi.fn(),
  },
  setCsrfToken: vi.fn(),
}));

afterEach(() => {
  resetMutationQueues(); resetProjectMutationState();
  cleanup();
  vi.restoreAllMocks();
});

const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const PROJECT = { id: "A", path: "/work/A", label: "Original", favorite: false, conversationCount: 0, lastActivityAt: null, createdAt: "", updatedAt: "" };

it("V25 a rename settled after the view remounted closes the live dialog and repaints the live list", async () => {
  let stored = { ...PROJECT };
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this test" } });
  vi.mocked(api.listProjects).mockImplementation(async () => ({ ok: true, data: [{ ...stored }] }));
  // The first write is held open across the whole round trip; the second (the
  // coalesced follow-up) settles immediately, so ordering is not what is under test.
  const gate = deferred();
  let calls = 0;
  vi.mocked(api.updateProject).mockImplementation(async (_id, patch) => {
    if (++calls === 1) await gate.promise;
    stored = { ...stored, label: patch.label! };
    return { ok: true, data: { ...stored } };
  });

  render(<App />);
  await screen.findByText("Original");

  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  // Leave Projects and come back: a fresh ProjectsView, whose list is loaded on mount.
  fireEvent.click(screen.getByTitle("Settings"));
  await screen.findByRole("button", { name: "← Back" });
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  await screen.findByText("Original");

  // The live view's own dialog submits the last intent while the older write is open.
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Final" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  // Release the older write: its response is what has to report to the live view.
  await act(async () => { gate.resolve(undefined); });
  await waitFor(() => expect(calls).toBe(2));
  await act(async () => { await Promise.resolve(); });

  const dialogOpen = screen.queryByRole("heading", { name: "Rename Project Label" }) !== null;
  const error = screen.queryByRole("alert")?.textContent ?? null;
  const heading = screen.queryByRole("heading", { name: "Original" }) !== null;
  const persisted = stored.label;
  console.log("AUDIT25 rename feedback", JSON.stringify({ dialogOpen, error, heading, persisted }));

  // The dialog the user submitted on must close, and the list must show the label
  // the server now holds — without a page reload.
  expect(dialogOpen).toBe(false);
  expect(screen.queryByRole("heading", { name: "Final" }) !== null).toBe(true);
  expect(error).toBeNull();
  expect(persisted).toBe("Final");
});

it("V25 a rename failure reported after the view remounted reaches the live alert region", async () => {
  let stored = { ...PROJECT };
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this test" } });
  vi.mocked(api.listProjects).mockImplementation(async () => ({ ok: true, data: [{ ...stored }] }));
  const gate = deferred();
  let calls = 0;
  vi.mocked(api.updateProject).mockImplementation(async (_id, patch) => {
    if (++calls === 1) await gate.promise;
    if (calls === 1) return { ok: true, data: { ...stored, label: patch.label! } };
    return { ok: false, error: { code: "internal", message: "Rename refused by the server" } };
  });

  render(<App />);
  await screen.findByText("Original");
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls).toBe(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  fireEvent.click(screen.getByTitle("Settings"));
  await screen.findByRole("button", { name: "← Back" });
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  await screen.findByText("Original");

  // The live dialog records its intent, then the older write fails and the follow-up
  // is what carries that intent — the failure feedback must land on the live view.
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Final" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await act(async () => { gate.resolve(undefined); });
  await waitFor(() => expect(calls).toBe(2));
  await act(async () => { await Promise.resolve(); });

  const error = screen.queryByRole("alert")?.textContent ?? null;
  console.log("AUDIT25 rename feedback failure", JSON.stringify({ error }));
  expect(error).toContain("Rename refused by the server");
  // The dialog belongs to the intent that failed, so it stays open for a retry.
  expect(screen.queryByRole("heading", { name: "Rename Project Label" }) !== null).toBe(true);
});

it("V26 a rename write cancelled at the auth boundary reports nothing to the reopened session", async () => {
  let stored = { ...PROJECT };
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this test" } });
  vi.mocked(api.listProjects).mockImplementation(async () => ({ ok: true, data: [{ ...stored }] }));
  // The old session's request is held; the recorded intent behind it is what the
  // boundary must retire. The server still accepted the held write — its label is
  // stored, and it is the label the new session's read shows.
  const gate = deferred();
  let calls = 0;
  vi.mocked(api.updateProject).mockImplementation(async (_id, patch) => {
    const n = ++calls;
    if (n === 1) {
      await gate.promise;
      stored = { ...stored, label: patch.label! };
      return { ok: true, data: { ...stored } };
    }
    stored = { ...stored, label: patch.label! };
    return { ok: true, data: { ...stored } };
  });

  const first = render(<App />);
  await screen.findByText("Original");
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "First" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(calls).toBe(1));
  // A second label recorded while the write is open would otherwise be chained as a
  // follow-up — under the new session's credentials.
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Queued" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  // The auth boundary: the app leaves the session and mounts a fresh ProjectsView.
  first.unmount();
  resetMutationQueues();
  resetProjectMutationState();
  await act(async () => { render(<App />); });
  await screen.findByText("Original");
  expect(screen.queryByRole("heading", { name: "Rename Project Label" })).toBeNull();

  await act(async () => { gate.resolve(undefined); });
  await act(async () => { await Promise.resolve(); });

  const error = screen.queryByRole("alert")?.textContent ?? null;
  const open = screen.queryByRole("heading", { name: "Rename Project Label" }) !== null;
  const cardLabel = screen.queryByRole("heading", { name: "First" }) !== null ? "First" : "Original";
  console.log("AUDIT25 rename cancelled feedback", JSON.stringify({ calls, error, open, cardLabel, stored: stored.label }));
  // Only the request the user actually submitted went out; the recorded intent did
  // not follow it, and nothing was reported to the view that is on screen now.
  expect(calls).toBe(1);
  expect(error).toBeNull();
  expect(open).toBe(false);
  // The retired response did not repaint that view either: it still shows the label
  // this session's own read returned. The server's newer value appears on the next
  // read, not because a dead session's callback wrote it.
  expect(cardLabel).toBe("Original");
  expect(stored.label).toBe("First");
});
