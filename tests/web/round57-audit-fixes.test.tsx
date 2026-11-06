// @vitest-environment jsdom
// Regressions for the defects the independent adversarial audit found in this
// round's first commit. Each one is a claim the round makes but did not hold.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createTranscriptState, reduceHostFrame, snapshotProgress, SNAPSHOT_PROGRESS_TIMEOUT_MS } from "../../apps/web/src/transcript.js";
import { DashboardCards } from "../../apps/web/src/components/DashboardCards.js";
import type { HostFrame } from "@caw/collab-protocol";

afterEach(cleanup);

const welcome = (entryCount: number): HostFrame => ({
  t: "welcome", proto: 3,
  header: { type: "session", id: "s", cwd: "/", timestamp: "2026-01-01T00:00:00Z" },
  state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
  agents: [], entryCount,
});

describe("audit fixes", () => {
  it("F7: a zero or absent promised total never becomes a division or a fabricated count", () => {
    // The wire carries no validator, so a foreign or buggy host can promise
    // nonsense. The view must not divide by it or print `undefined`.
    expect(snapshotProgress(createTranscriptState())).toBeNull();
    const zero = reduceHostFrame(createTranscriptState(), welcome(0));
    expect(snapshotProgress(zero)).toBeNull();
  });

  it("F3: a stall over an existing transcript still marks the sync stalled", () => {
    // The state the strip renders from must exist even when rows are already on
    // screen — otherwise a resync that stops moving renders nothing at all.
    let state = reduceHostFrame(createTranscriptState(), welcome(1), 0);
    state = reduceHostFrame(state, { t: "snapshot-chunk", entries: [{ type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "kept", timestamp: 1 } }], final: true }, 0);
    expect(state.messages).toHaveLength(1);

    // A new welcome (reconnect/resync) then no progress.
    state = reduceHostFrame(state, welcome(10), 0);
    state = reduceHostFrame(state, { t: "snapshot-chunk", entries: [], final: false }, 0);
    const stalled = reduceHostFrame(state, { t: "state", state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] } }, 0);
    expect(stalled.messages, "verified rows are kept").toHaveLength(1);
    // The verdict the strip reads.
    expect(snapshotProgress(stalled)).not.toBeNull();
    expect(SNAPSHOT_PROGRESS_TIMEOUT_MS).toBe(30_000);
  });

  it("F4: the agents disclaimer is short enough for the narrowest card", () => {
    render(<DashboardCards counts={{ agents: { total: 12, running: 0 }, files: null }} onOpenAgents={vi.fn()} onOpenFiles={vi.fn()} onOpenActivity={vi.fn()} />);
    const sub = screen.getByText(/0 running/);
    // The clipped wording was the disclaimer itself; keep it short enough to fit.
    expect(sub.textContent!.length).toBeLessThanOrEqual(24);
  });
});
