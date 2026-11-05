// @vitest-environment jsdom
/**
 * Round 11's subagent-transcript behaviours, re-pointed at Agent Detail (round 53).
 *
 * The old `SubagentPanel` was a modal that kept a manual `Refresh` button. Agent
 * Detail is a full-screen view that polls and *self-heals*, so it has no Refresh
 * button by design (see its own comment). These tests therefore keep the original
 * claims — a running agent's transcript keeps being fetched, and a transient error
 * does not permanently stop polling — and drop only the premise about a button
 * that no longer exists.
 */
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AgentDetail } from "../../apps/web/src/components/AgentDetail.js";
import type { AgentView } from "../../apps/web/src/agent-model.js";
import type { TranscriptReply } from "../../apps/web/src/transcript.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** A running worker with a transcript file, as Agent Detail receives it. */
function view(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "a", displayName: "Worker", kind: "sub", status: "running", class: "worker",
    parentId: "main", hasSessionFile: true, createdAt: 0, lastActivity: 0,
    canKillWorker: true, readOnlyReason: null, ...over,
  };
}

function props(over: Partial<React.ComponentProps<typeof AgentDetail>> = {}) {
  return {
    view: view(),
    activity: undefined,
    transcript: undefined as TranscriptReply | undefined,
    transcriptError: null as string | null,
    loading: false,
    onFetchTranscript: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
}

it("audit11 control: a running agent's transcript keeps being polled", async () => {
  vi.useFakeTimers();
  const p = props();
  render(<AgentDetail {...p} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  // Three polls at 1200ms, plus the immediate fetch on mount.
  expect(p.onFetchTranscript.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it("audit11: a transient transcript error does not stop polling", async () => {
  vi.useFakeTimers();
  const p = props({ transcriptError: "Network timeout" });
  const rendered = render(<AgentDetail {...p} />);
  // The error is visible, not swallowed.
  expect(rendered.queryByRole("alert")).not.toBeNull();

  const before = p.onFetchTranscript.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  // Self-healing: the poll continues, so a recovered host is picked up without a
  // manual Refresh — the behaviour the old test protected through the button.
  expect(p.onFetchTranscript.mock.calls.length).toBeGreaterThan(before);
});

it("does not poll an agent that has no transcript file", async () => {
  vi.useFakeTimers();
  const p = props({ view: view({ hasSessionFile: false }) });
  render(<AgentDetail {...p} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  // Nothing to fetch: an explicit unavailable state instead of empty polling.
  expect(p.onFetchTranscript).not.toHaveBeenCalled();
});
