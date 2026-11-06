// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NoticeRow } from "../../apps/web/src/components/NoticeRow.js";
import { createTranscriptState, reduceHostFrame, type TranscriptState } from "../../apps/web/src/transcript.js";
import type { HostFrame } from "@caw/collab-protocol";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/**
 * Regressions found by an independent adversarial audit of the commit that
 * introduced notice retirement. All three were real, and all three are the same
 * mistake in different clothes: treating a notice's *text* as its identity, and
 * treating `info` as a synonym for "transient".
 *
 *  1. P1 — the row was keyed on the message text, so a notice repeated later in the
 *     session (the host emits "… interrupted" again on a second Stop) reused the
 *     retired element and rendered NOTHING, at any level, for the rest of the
 *     session. Including an error re-emitted with the same text: no alert at all.
 *  2. P2 — `info` notices that report work still in progress (a retry waiting on a
 *     provider, a compaction running) expired mid-operation, taking the only report
 *     of that state with them.
 *  3. The expiry flag never reset, which is what made (1) permanent rather than a
 *     single lost render.
 */

const frame = (event: unknown): HostFrame => ({ t: "event", event } as unknown as HostFrame);

function reduce(state: TranscriptState, events: unknown[]): TranscriptState {
  let next = state;
  for (const event of events) next = reduceHostFrame(next, frame(event), 1_000);
  return next;
}

describe("a notice's identity is not its text", () => {
  it("gives a repeated identical notice a new identity, so it renders again", () => {
    let state = createTranscriptState();
    state = reduce(state, [{ type: "notice", level: "info", message: "Mobile Web Controller interrupted" }]);
    const first = state.notice!;
    state = reduce(state, [{ type: "turn_start" }]);
    state = reduce(state, [{ type: "notice", level: "info", message: "Mobile Web Controller interrupted" }]);
    const second = state.notice!;
    expect(second.message).toBe(first.message);
    expect(second.seq).not.toBe(first.seq);
  });

  it("keeps a repeated notice visible even after the first one expired", () => {
    vi.useFakeTimers();
    const message = "Mobile Web Controller interrupted";
    // First notice: retires, as designed.
    const { rerender } = render(<NoticeRow notice={{ level: "info", message, kind: "event", seq: 1 }} />);
    expect(screen.getByText(message)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(screen.queryByText(message)).toBeNull();
    // The host emits the same words again in the same session. A new key means a new
    // instance, which must be unexpired.
    rerender(<NoticeRow notice={{ level: "info", message, kind: "event", seq: 2 }} />);
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("renders an error that repeats a previously expired notice's text, as an alert", () => {
    vi.useFakeTimers();
    const message = "Rate limit reached";
    const { rerender } = render(<NoticeRow notice={{ level: "info", message, kind: "event", seq: 1 }} />);
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(screen.queryByText(message)).toBeNull();
    // Escalation to error. The audit's clearest case: this used to render nothing,
    // so a genuine error was invisible.
    rerender(<NoticeRow notice={{ level: "error", message, kind: "event", seq: 2 }} />);
    expect(screen.getByRole("alert").textContent).toContain(message);
  });
});

describe("work still in progress never expires", () => {
  it("does not retire a retry that is waiting on a provider", () => {
    vi.useFakeTimers();
    const message = "Retry 1/3: provider unavailable";
    render(<NoticeRow notice={{ level: "info", message, kind: "status", seq: 1 }} />);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("does not retire a running compaction", () => {
    vi.useFakeTimers();
    const message = "Compacting context (auto)";
    render(<NoticeRow notice={{ level: "info", message, kind: "status", seq: 1 }} />);
    act(() => { vi.advanceTimersByTime(120_000); });
    expect(screen.getByText(message)).toBeTruthy();
  });

  it("still retires a routine event notice", () => {
    vi.useFakeTimers();
    render(<NoticeRow notice={{ level: "info", message: "joined the collab session", kind: "event", seq: 1 }} />);
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(screen.queryByText(/joined the collab session/)).toBeNull();
  });

  it("classifies retry and compaction as status, and their settlements as events", () => {
    const retryStart = reduce(createTranscriptState(), [{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 60_000, errorMessage: "unavailable" }]);
    expect(retryStart.notice!.kind).toBe("status");
    const compactStart = reduce(createTranscriptState(), [{ type: "auto_compaction_start", reason: "auto", action: "compact" }]);
    expect(compactStart.notice!.kind).toBe("status");
    const retryEnd = reduce(createTranscriptState(), [{ type: "auto_retry_end", success: true }]);
    expect(retryEnd.notice!.kind).toBe("event");
    const compactEnd = reduce(createTranscriptState(), [{ type: "auto_compaction_end", aborted: false, willRetry: false }]);
    expect(compactEnd.notice!.kind).toBe("event");
  });

  it("classifies the subagent status fallback as status", () => {
    // The bus fallback (`transcript.ts`) carries a live agent's status and has no
    // other surface, so it must not expire while the agent works.
    const state = reduce(createTranscriptState(), [{ type: "subagent_progress", agent: "scout", status: "running" }]);
    if (state.notice !== null) expect(state.notice.kind).toBe("status");
  });
});
