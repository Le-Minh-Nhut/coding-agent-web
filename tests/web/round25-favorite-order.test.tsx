// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/web/src/App.js";
import { api } from "../../apps/web/src/api.js";
import { resetMutationQueues } from "../../apps/web/src/mutation-order.js";
import { resetProjectMutationState } from "../../apps/web/src/components/ProjectsView.js";

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
  setCsrfToken: vi.fn(),
}));

afterEach(() => {
  resetMutationQueues(); resetProjectMutationState();
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

/**
 * The UI half of the same residual: the write's *result* must reach the star
 * column of the view the user is looking at. Here the write settles after the
 * user left Projects and came back, so its response lands on a mount that is
 * gone; the reopened view's own list read (taken while the write was still in
 * flight) carries the pre-write star. Applying the response to the dead mount's
 * state repaints nothing the user can see — the live star column is only
 * corrected by routing the accepted value through the live view's bridge, and
 * without a second list read (the value is already known).
 */
it("V25 a star write that settles after remount repaints the live view without a refetch", async () => {
  let stored = { ...PROJECT };
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this test" } });
  let listCalls = 0;
  vi.mocked(api.listProjects).mockImplementation(async () => {
    listCalls++;
    return { ok: true, data: [{ ...stored }] };
  });

  // The write is held at the network until after the round trip, so the reopened
  // view's read still sees the unstarred server state.
  const gate = deferred();
  let writes = 0;
  vi.mocked(api.updateProject).mockImplementation(async (_id, patch) => {
    writes++;
    await gate.promise;
    stored = { ...stored, favorite: patch.favorite! };
    return { ok: true, data: { ...stored } } as never;
  });

  render(<App />);
  await screen.findByTitle("Star");
  fireEvent.click(screen.getByTitle("Star"));
  await waitFor(() => expect(writes).toBe(1));

  fireEvent.click(screen.getByTitle("Settings"));
  await screen.findByRole("button", { name: "← Back" });
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  await screen.findByTitle("Star");
  expect(listCalls).toBe(2);

  // The held write lands now. Its accepted star belongs to the view on screen.
  await act(async () => { gate.resolve(undefined); });
  await act(async () => { await Promise.resolve(); });

  const starTitle = screen.queryByTitle("Star") ? "Star" : screen.queryByTitle("Unstar") ? "Unstar" : null;
  console.log("AUDIT25 favorite live repaint", JSON.stringify({ starTitle, listCalls }));
  expect(starTitle).toBe("Unstar");
  // The accepted value is applied directly, so no third list read is required.
  expect(listCalls).toBe(2);
});

it("V26 a star write whose flight was reset at sign-out does not repaint the new session's list", async () => {
  let stored = { ...PROJECT };
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this test" } });
  let listCalls = 0;
  vi.mocked(api.listProjects).mockImplementation(async () => {
    listCalls++;
    return { ok: true, data: [{ ...stored }] };
  });

  // The request is already in flight when the boundary is crossed — it cannot be
  // recalled, and the server applies it — but its response must not be applied to the
  // star column of the mount that is on screen afterwards.
  const gate = deferred();
  let calls = 0;
  vi.mocked(api.updateProject).mockImplementation(async (_id, patch) => {
    calls++;
    await gate.promise;
    stored = { ...stored, favorite: patch.favorite! };
    return { ok: true, data: { ...stored } } as never;
  });

  const first = render(<App />);
  await screen.findByTitle("Star");
  fireEvent.click(screen.getByTitle("Star"));
  await waitFor(() => expect(calls).toBe(1));

  // The auth boundary retires the flight, then a fresh ProjectsView mounts.
  first.unmount();
  resetMutationQueues();
  resetProjectMutationState();
  await act(async () => { render(<App />); });
  await screen.findByTitle("Star");
  const readsBefore = listCalls;

  await act(async () => { gate.resolve(undefined); });
  await act(async () => { await Promise.resolve(); });

  const starTitle = screen.queryByTitle("Star") ? "Star" : screen.queryByTitle("Unstar") ? "Unstar" : null;
  console.log("AUDIT25 favorite retired", JSON.stringify({ calls, starTitle, listCalls: listCalls - readsBefore, stored: stored.favorite, error: screen.queryByRole("alert")?.textContent ?? null }));
  // The star on screen is still the value this session's own read returned: the
  // retired callback neither repainted the column nor reported anything, and it sent
  // no follow-up under the new credentials.
  expect(calls).toBe(1);
  expect(starTitle).toBe("Star");
  expect(listCalls).toBe(readsBefore);
  expect(screen.queryByRole("alert")).toBeNull();
  // The server did apply the request that was already in flight — the next read sees it.
  expect(stored.favorite).toBe(true);
});
