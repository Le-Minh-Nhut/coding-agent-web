// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/web/src/App.js";
import { resetMutationQueues } from "../../apps/web/src/mutation-order.js";
import { resetProjectMutationState } from "../../apps/web/src/components/ProjectsView.js";
import { api } from "../../apps/web/src/api.js";

/**
 * V26-03: a rename Save that coalesces onto a write already in flight records its
 * intent (label + the dialog token and draft revision of that Save). When the open
 * write succeeds with the label that intent asked for, it has *served* the intent —
 * but no code path ever acknowledged the dialog that submitted it, so the store and
 * the card moved to the new label while the dialog sat open.
 *
 * The acknowledgment is a feedback decision, not a request: no second PATCH may be
 * sent. It must also go through the same ownership test the direct-success path
 * uses (dialog token and draft revision captured at that Save), so it can only close
 * the dialog that submitted the label, and it must not act at all when no view is
 * mounted (there is nothing on screen to close or repaint).
 *
 * V26-01 half: a write whose request was already in flight when the auth boundary
 * was crossed cannot be recalled, but its *response* must not act on the session on
 * screen now — no report, no repaint, and never a follow-up intent sent under the
 * new credentials.
 *
 * The fixture models the server honestly: a write takes effect when it *arrives*,
 * and the response may be held afterwards. A held response therefore does not mean
 * the write never happened, which is what lets these cases tell "the retired
 * callback touched nothing" apart from "the write never landed".
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

type Row = { id: string; path: string; label: string; favorite: boolean; conversationCount: number; lastActivityAt: string | null; createdAt: string; updatedAt: string };
const row = (id: string, label: string): Row => ({ id, path: `/work/${id}`, label, favorite: false, conversationCount: 0, lastActivityAt: null, createdAt: "", updatedAt: "" });

interface ProjectsFixture {
  /** Patches that reached the server, in arrival order. */
  calls: Array<{ id: string; patch: Record<string, unknown> }>;
  /** List reads served, so a spurious refresh is observable. */
  reads: () => number;
  row: (id: string) => Row;
  label: (id: string) => string;
  /** Install succeeding writes; the response of call number `heldCall` waits on `gate`. */
  succeed: (gate: Promise<unknown>, heldCall?: number) => void;
}

const fixture = (rows: Row[]): ProjectsFixture => {
  let current = rows.map((r) => ({ ...r }));
  const calls: Array<{ id: string; patch: Record<string, unknown> }> = [];
  let reads = 0;
  vi.mocked(api.getMe).mockResolvedValue({ ok: true, data: { csrfToken: "t" } });
  vi.mocked(api.getCapabilities).mockResolvedValue({ ok: true, data: {} } as never);
  vi.mocked(api.getRuntime).mockResolvedValue({ ok: false, error: { code: "internal", message: "No runtime in this test" } });
  vi.mocked(api.listProjects).mockImplementation(async () => {
    reads++;
    return { ok: true, data: current.map((r) => ({ ...r })) };
  });
  const apply = (id: string, patch: Record<string, unknown>) => {
    calls.push({ id, patch });
    current = current.map((r) => (r.id === id ? { ...r, ...patch } : r));
  };
  return {
    calls,
    reads: () => reads,
    row: (id) => ({ ...current.find((r) => r.id === id)! }),
    label: (id) => current.find((r) => r.id === id)!.label,
    succeed: (gate, heldCall = 1) => {
      vi.mocked(api.updateProject).mockImplementation(async (id, patch) => {
        apply(id, patch as Record<string, unknown>);
        if (calls.length === heldCall) await gate;
        return { ok: true, data: { ...current.find((r) => r.id === id)! } } as never;
      });
    },
  };
};

const submitRename = (label: string, index = 0) => {
  fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[index]!);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: label } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
};

/** Settings round-trip: the ProjectsView unmounts and a fresh one mounts. */
const leaveAndReturn = async (label: string) => {
  fireEvent.click(screen.getByTitle("Settings"));
  await screen.findByRole("button", { name: "← Back" });
  fireEvent.click(screen.getByRole("button", { name: "← Back" }));
  await screen.findByText(label);
};

const dialogInput = () => screen.getByRole("textbox") as HTMLInputElement;
const dialogOpen = () => screen.queryByRole("heading", { name: "Rename Project Label" }) !== null;
const alertText = () => screen.queryByRole("alert")?.textContent ?? null;

it.each([false,true])("V26 same-value coalesced rename acknowledges the live dialog (same=%s)",async same=>{
 const gate=deferred();
 const f=fixture([row("A","Original")]);f.succeed(gate.promise);
 render(<App/>);await screen.findByText('Original');
 submitRename('First');await waitFor(()=>expect(f.calls).toHaveLength(1));fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 await leaveAndReturn('First');
 submitRename(same?'First':'Final');await act(async()=>gate.resolve(undefined));
 await screen.findByRole('heading',{name:same?'First':'Final'});
 const open=dialogOpen();
 console.log('AUDIT26 equal rename',JSON.stringify({same,calls:f.calls.length,persisted:f.label('A'),dialogOpen:open}));
 expect(f.label('A')).toBe(same?'First':'Final');
 // The acknowledgment acknowledges; it never re-sends the label the server already holds.
 if(same)expect(f.calls).toHaveLength(1);
 expect(open).toBe(false);
 expect(alertText()).toBeNull();
});

it("V26 an equal-label acknowledgment cannot close a dialog opened after the pending Save", async () => {
  const gate = deferred();
  const f = fixture([row("A", "Original")]);
  f.succeed(gate.promise);
  render(<App />);
  await screen.findByText("Original");

  submitRename("First");
  await waitFor(() => expect(f.calls).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await leaveAndReturn("First");

  // The reopened view records the same label while the older write is open, then the
  // user cancels that dialog and opens a third one — a different token.
  submitRename("First");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));

  await act(async () => gate.resolve(undefined));
  await act(async () => { await Promise.resolve(); });

  console.log("AUDIT26 equal rename stale token", JSON.stringify({ calls: f.calls.length, persisted: f.label("A"), dialogOpen: dialogOpen() }));
  // The recorded intent's token belongs to the cancelled dialog: the live one is left
  // exactly as the user left it, and no redundant PATCH was sent.
  expect(dialogOpen()).toBe(true);
  expect(dialogInput().value).toBe("First");
  expect(f.calls).toHaveLength(1);
  expect(alertText()).toBeNull();
});

it("V26 an equal-label acknowledgment leaves a draft edited after that Save open", async () => {
  const gate = deferred();
  const f = fixture([row("A", "Original")]);
  f.succeed(gate.promise);
  render(<App />);
  await screen.findByText("Original");

  submitRename("First");
  await waitFor(() => expect(f.calls).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await leaveAndReturn("First");

  submitRename("First");
  // A keystroke after the Save makes the text on screen an unsaved edit for this
  // dialog: the acknowledgment may not close it (the direct-success rule, V20-03).
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Second" } });

  await act(async () => gate.resolve(undefined));
  await act(async () => { await Promise.resolve(); });

  console.log("AUDIT26 equal rename edited draft", JSON.stringify({ calls: f.calls.length, persisted: f.label("A"), dialogOpen: dialogOpen(), draft: dialogInput().value }));
  expect(f.label("A")).toBe("First");
  expect(dialogOpen()).toBe(true);
  expect(dialogInput().value).toBe("Second");
  expect(f.calls).toHaveLength(1);
  expect(alertText()).toBeNull();
});

it("V26 a failed write still owes a same-label pending intent its request (V20-04)", async () => {
  const first = deferred();
  const retry = deferred();
  const f = fixture([row("A", "Original")]);
  let arrivals = 0;
  vi.mocked(api.updateProject).mockImplementation(async (id, patch) => {
    const n = ++arrivals;
    f.calls.push({ id, patch: patch as Record<string, unknown> });
    if (n === 1) {
      await first.promise;
      return { ok: false, error: { code: "internal", message: "Rename refused" } } as never;
    }
    await retry.promise;
    return { ok: true, data: { ...f.row(id), label: "First" } } as never;
  });
  render(<App />);
  await screen.findByText("Original");

  submitRename("First");
  await waitFor(() => expect(f.calls).toHaveLength(1));
  // A second Save with the same label records the intent; the open write still has to
  // run, because a failed request did not serve it.
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await act(async () => first.resolve(undefined));
  await waitFor(() => expect(f.calls).toHaveLength(2));
  await act(async () => { await Promise.resolve(); });

  console.log("AUDIT26 equal rename retry", JSON.stringify({ calls: f.calls.length, dialogOpen: dialogOpen(), error: alertText() }));
  expect(f.calls.map((c) => c.patch)).toEqual([{ label: "First" }, { label: "First" }]);
  expect(alertText()).toContain("Rename refused");
  expect(dialogOpen()).toBe(true);

  await act(async () => retry.resolve(undefined));
  await act(async () => { await Promise.resolve(); });
  expect(dialogOpen()).toBe(false);
});

it("V26 one project's acknowledgment never touches another project's dialog", async () => {
  const gate = deferred();
  const f = fixture([row("A", "Original"), row("B", "Beta")]);
  f.succeed(gate.promise);
  render(<App />);
  await screen.findByText("Original");

  // A's write is held; B's write runs on its own key and settles immediately.
  submitRename("First", 0);
  await waitFor(() => expect(f.calls).toHaveLength(1));
  submitRename("Final", 1);
  await act(async () => { await Promise.resolve(); });
  expect(dialogOpen()).toBe(false);

  await act(async () => gate.resolve(undefined));
  await act(async () => { await Promise.resolve(); });

  console.log("AUDIT26 equal rename two projects", JSON.stringify({ calls: f.calls.length, a: f.label("A"), b: f.label("B"), dialogOpen: dialogOpen(), error: alertText() }));
  expect(f.calls.map((c) => c.id)).toEqual(["A", "B"]);
  expect(f.label("A")).toBe("First");
  expect(f.label("B")).toBe("Final");
  expect(dialogOpen()).toBe(false);
  expect(alertText()).toBeNull();
});

it("V26 a write retired at the auth boundary reports nothing to the session on screen", async () => {
  const gate = deferred();
  const f = fixture([row("A", "Original")]);
  f.succeed(gate.promise);
  const first = render(<App />);
  await screen.findByText("Original");

  // The old session's intent: one write whose request is already in flight, plus a
  // recorded intent behind it (a different label, so a follow-up really is owed).
  submitRename("First");
  await waitFor(() => expect(f.calls).toHaveLength(1));
  submitRename("Second");
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  // Sign-out/sign-in: every module-scope intent is retired and the view remounts.
  // The old request is in flight, so it cannot be recalled — it already reached the
  // server and its label is stored.
  first.unmount();
  resetMutationQueues();
  resetProjectMutationState();
  await act(async () => { render(<App />); });
  await screen.findByText("First");

  // The new session's own write is what decides the stored label now.
  submitRename("Final");
  await act(async () => { await Promise.resolve(); });
  expect(f.label("A")).toBe("Final");
  expect(f.calls).toHaveLength(2);
  // Baseline after the new write's own refresh: what follows must add no read at all.
  const readsBefore = f.reads();

  // Release the retired response. Its callback belongs to a session that is gone: no
  // follow-up under the new credentials, no error, and no repaint of the view on
  // screen — not even a refresh read.
  await act(async () => gate.resolve(undefined));
  await act(async () => { await Promise.resolve(); });

  console.log("AUDIT26 equal rename expired lifetime", JSON.stringify({ calls: f.calls.length, persisted: f.label("A"), reads: f.reads() - readsBefore, dialogOpen: dialogOpen(), error: alertText() }));
  expect(f.calls.map((c) => c.patch)).toEqual([{ label: "First" }, { label: "Final" }]);
  expect(f.label("A")).toBe("Final");
  expect(f.reads()).toBe(readsBefore);
  expect(dialogOpen()).toBe(false);
  expect(alertText()).toBeNull();
});
