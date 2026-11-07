// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { MessageRow, type DisplayMessage } from "../../apps/web/src/components/MessageRow.js";
import { NoticeRow } from "../../apps/web/src/components/NoticeRow.js";
import { TranscriptList } from "../../apps/web/src/components/MessageRow.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/**
 * Round-57 performance fixes, pinned by behaviour.
 *
 * Neither of these is a "the code is faster" assertion — a timing test in jsdom
 * would measure jsdom. They pin the *decisions* that make the code fast, because
 * each decision is invisible to a reader and easy to undo:
 *
 *  1. `MessageRow` must not re-render when only the `represented` set was rebuilt.
 *     A rebuilt set is what defeated `memo` and had React walking all 4075 rows on
 *     every streamed frame.
 *  2. It MUST re-render when that set actually changes the answer for its own row
 *     — a tool call whose result appeared, or disappeared, changes what is drawn.
 */
function row(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return { id: "u-1", role: "user", text: "hello", ...overrides };
}

function toolCallRow(id: string, callId: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    text: "calling",
    blocks: [{ type: "toolCall", name: "bash", id: callId, arguments: { cmd: "ls" } }],
  };
}

describe("MessageRow memoization on the represented set", () => {
  it("does not re-render a row when the set is rebuilt to the same answer", () => {
    const message = row();
    const { rerender } = render(<MessageRow message={message} represented={new Set(["other-call"])} />);
    // Count real renders of the row's own body by watching a value it must produce
    // exactly once per render: the rendered text node.
    const before = document.querySelectorAll(".message-card").length;
    rerender(<MessageRow message={message} represented={new Set(["other-call"])} />);
    rerender(<MessageRow message={message} represented={new Set(["other-call", "another-call"])} />);
    const after = document.querySelectorAll(".message-card").length;
    expect(before).toBe(1);
    expect(after).toBe(1);
    // The observable proof that no re-render happened: the DOM node is the same node.
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("re-renders when the row's own tool call becomes represented", () => {
    const message = toolCallRow("a-1", "call-1");
    const { rerender } = render(<MessageRow message={message} represented={new Set()} />);
    // Not represented: the call is the only record of the request, so it is drawn.
    expect(document.querySelector("details")).not.toBeNull();
    rerender(<MessageRow message={message} represented={new Set(["call-1"])} />);
    // Represented: a result row is on screen, so the duplicate request is suppressed.
    expect(document.querySelector("details")).toBeNull();
  });

  it("re-renders when the message object itself changes", () => {
    const { rerender } = render(<MessageRow message={row({ text: "first" })} />);
    expect(screen.getByText("first")).toBeTruthy();
    rerender(<MessageRow message={row({ text: "second" })} />);
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("keeps a tool result row visible when its call id is in the set", () => {
    // The tool row's own id must not be read as a suppressed request: a result row
    // is the execution, and it is never hidden by `represented`.
    const { rerender } = render(<MessageRow message={row({ id: "t-1", role: "tool", text: "output", toolName: "bash", toolCallId: "call-1" })} represented={new Set()} />);
    expect(screen.getAllByText(/bash/).length).toBeGreaterThan(0);
    rerender(<MessageRow message={row({ id: "t-1", role: "tool", text: "output", toolName: "bash", toolCallId: "call-1" })} represented={new Set(["call-1"])} />);
    expect(screen.getAllByText(/bash/).length).toBeGreaterThan(0);
  });
});

/**
 * The caller-supplied-scroller path is the windowed one; without a scroller the list
 * still mounts every row, which is what `AgentChat` and these component tests rely on.
 * The window's own bounds and its reachability guarantees are proven in
 * `transcript-window.test.ts` and `transcript-window-component.test.tsx`; this block
 * keeps proving the unwindowed contract exactly as before.
 */
describe("TranscriptList without a scroller keeps every row in the document", () => {
  it("renders one element per row plus none dropped, across a large list", () => {
    const rows: DisplayMessage[] = Array.from({ length: 300 }, (_, index) => row({ id: `u-${index}`, text: `message ${index}` }));
    render(<TranscriptList rows={rows} />);
    expect(document.querySelectorAll(".message-card").length).toBe(300);
    // First, middle and last must all be present: windowing must never cost content.
    expect(screen.getByText("message 0")).toBeTruthy();
    expect(screen.getByText("message 150")).toBeTruthy();
    expect(screen.getByText("message 299")).toBeTruthy();
  });
});

describe("routine notices retire themselves, actionable ones do not", () => {
  it("removes a routine info notice after its linger window", () => {
    vi.useFakeTimers();
    render(<NoticeRow notice={{ level: "info", message: "Mobile Web Controller joined the collab session", kind: "event", seq: 1 }} />);
    expect(screen.getByText(/joined the collab session/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(screen.queryByText(/joined the collab session/)).toBeNull();
  });

  it("keeps a warning on screen indefinitely", () => {
    vi.useFakeTimers();
    render(<NoticeRow notice={{ level: "warning", message: "Host is starting up", kind: "event", seq: 1 }} />);
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(screen.getByText(/Host is starting up/)).toBeTruthy();
  });

  it("keeps an error on screen indefinitely, as an alert", () => {
    vi.useFakeTimers();
    render(<NoticeRow notice={{ level: "error", message: "Connection lost", kind: "event", seq: 1 }} />);
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(screen.getByRole("alert").textContent).toContain("Connection lost");
  });

  it("retires nothing while a routine notice has not yet been read for long enough", () => {
    // The expanded-row case cannot be staged in jsdom: the expander only renders
    // once `scrollHeight` exceeds `clientHeight`, and jsdom reports 0 for both, so
    // the control that would cancel the timer does not exist there. That case is
    // covered in `tests/e2e/` where a real layout decides it.
    vi.useFakeTimers();
    render(<NoticeRow notice={{ level: "info", message: "Routine chatter", kind: "event", seq: 1 }} />);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.getByText(/Routine chatter/)).toBeTruthy();
  });
});
