// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/web/src/App.js";
import { api } from "../../apps/web/src/api.js";

/**
 * V25-01 favorite path: the star toggle has the same cross-remount write race the
 * rename fix closed. The favorite flight is now module-scope and its PATCH is
 * chained per project, so a star write issued before Back/Settings cannot land
 * after a later one from the reopened view and rewind the stored flag.
 *
 * Same-mount favorite ordering — one write in flight per project, double-tap
 * coalescing, last intent winning — is already covered by
 * round16-favorite-order-auditor and round14-favorite-auditor. Only the remount
 * case is added here.
 */
vi.mock("../../apps/web/src/api.js", () => ({
  api: {
    getMe: vi.fn(),
    getCapabilities: vi.fn(),
    getRuntime: vi.fn(),
    listProjects: vi.fn(),
    updateProject: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Node 20.19 here has no Promise.withResolvers, so the executor form is required.
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const PROJECT = {
  id: "A",
  path: "/work/A",
  label: "A",
  favorite: false,
  conversationCount: 0,
  lastActivityAt: null,
  createdAt: "",
  updatedAt: "",
};

it("V25 a star write issued before leaving Projects cannot land after a later one", async () => {
  let stored = { ...PROJECT };
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this test" } });
  // The reopened view reads a star the server already flipped (the first write
  // landed in another client / an earlier session), so its click asks for the
  // opposite of the write still in flight — the one ordering case a toggle can
  // express across a remount with two states.
  vi.mocked(api.listProjects)
    .mockResolvedValueOnce({ ok: true, data: [{ ...stored }] })
    .mockResolvedValue({ ok: true, data: [{ ...stored, favorite: true }] });

  // The first write is held at the network: what matters is the order the server
  // receives the writes in, not the order the client applies the responses.
  const gate = deferred();
  const arrivals: boolean[] = [];
  const writes: Promise<unknown>[] = [];
  let calls = 0;
  vi.mocked(api.updateProject).mockImplementation((_id, patch) => {
    const wanted = patch.favorite!;
    const write = (++calls === 1 ? gate.promise : Promise.resolve()).then(() => {
      arrivals.push(wanted);
      stored = { ...stored, favorite: wanted };
      return { ok: true, data: { ...stored } } as never;
    });
    writes.push(write);
    return write as never;
  });

  render(<App />);
  await screen.findByTitle("Star");
  fireEvent.click(screen.getByTitle("Star"));
  await waitFor(() => expect(calls).toBe(1));

  // Leave Projects and come back: a fresh ProjectsView with a fresh list read.
  fireEvent.click(screen.getByTitle("Settings"));
  await screen.findByRole("button", { name: "← Back" });
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  await screen.findByTitle("Unstar");

  // The reopened view asks to unstar while the older star is still in flight.
  fireEvent.click(screen.getByTitle("Unstar"));
  await act(async () => { gate.resolve(undefined); });
  await act(async () => { await Promise.all(writes); });

  console.log("AUDIT25 favorite order", JSON.stringify({ calls, arrivals, stored: stored.favorite }));
  // Arrival order must be submission order, and the last intent (unstar) wins.
  expect(arrivals).toEqual([true, false]);
  expect(stored.favorite).toBe(false);
});
