// @vitest-environment jsdom
/**
 * Agents Center (level 2) + Agent Detail (level 3).
 *
 * The cases are written against behaviour the brief named, not against the
 * implementation: preview bounding, full-task location, the Kill safety gate,
 * filter behaviour, and the two honesty states (no transcript, live-only task).
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AgentsCenter } from "../../apps/web/src/components/AgentsCenter.js";
import { AgentDetail } from "../../apps/web/src/components/AgentDetail.js";
import { agentViews, taskPreview, vibeWorkerIds } from "../../apps/web/src/agent-model.js";
import type { AgentActivity } from "../../apps/web/src/transcript.js";
import type { AgentSnapshot } from "@caw/collab-protocol";

afterEach(cleanup);

function snapshot(over: Partial<AgentSnapshot> & { id: string }): AgentSnapshot {
  return {
    displayName: over.id,
    kind: "sub",
    status: "running",
    hasSessionFile: true,
    createdAt: 0,
    lastActivity: Date.now(),
    ...over,
  } as AgentSnapshot;
}

/** main + plain subagent + proven worker, classified by the real model. */
function roster() {
  const agents: AgentSnapshot[] = [
    snapshot({ id: "main", kind: "main", displayName: "director" }),
    snapshot({ id: "sub-1", displayName: "plain-sub" }),
    snapshot({ id: "worker-1", displayName: "vibe-worker" }),
  ];
  const views = agentViews(agents, vibeWorkerIds([{ id: "worker-1", ownerId: "main", parentSessionId: "sess" }]));
  return Object.fromEntries(views.map((view) => [view.id, view]));
}

function activity(over: Partial<AgentActivity> & { agentId: string; task: string }): AgentActivity {
  return {
    agent: over.agentId,
    lifecycle: null,
    currentTool: null,
    status: "running",
    level: "info",
    liveOnly: true,
    updatedAt: Date.now(),
    ...over,
  };
}

describe("AgentsCenter", () => {
  it("bounds a 5,000-char task to a 2-line preview and never shows the whole thing", () => {
    const views = Object.values(roster());
    const long = Array.from({ length: 5_000 }, (_, i) => (i % 97 === 0 ? "\n" : "x")).join("");
    const { getByRole } = render(
      <AgentsCenter
        views={views}
        activity={{ "sub-1": activity({ agentId: "sub-1", task: long }) }}
        onSelect={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    const row = getByRole("button", { name: /plain-sub/ });
    expect(row.textContent).not.toContain(long);
    expect(row.textContent).toContain(taskPreview(long));
    // Two lines and 140 chars, plus the ellipsis taskPreview appends.
    expect(taskPreview(long).split("\n").length).toBeLessThanOrEqual(2);
    expect(taskPreview(long).length).toBeLessThanOrEqual(141);
    expect(taskPreview(long).length).toBeLessThan(long.length);
  });

  it("says so honestly when a row has no activity, instead of inventing a task", () => {
    const { getByRole } = render(
      <AgentsCenter views={Object.values(roster())} activity={{}} onSelect={vi.fn()} onBack={vi.fn()} />,
    );
    const row = getByRole("button", { name: /plain-sub/ });
    expect(row.textContent).toContain("No live task reported");
    expect(row.textContent).toContain("No live tool reported");
  });

  it("renders the class from the view model, never a guess", () => {
    const { getByRole } = render(
      <AgentsCenter views={Object.values(roster())} activity={{}} onSelect={vi.fn()} onBack={vi.fn()} />,
    );
    expect(getByRole("button", { name: /director, main/ }).textContent).toContain("main");
    expect(getByRole("button", { name: /vibe-worker, worker/ }).textContent).toContain("worker");
    expect(getByRole("button", { name: /plain-sub, subagent/ }).textContent).toContain("subagent");
  });

  it("filters to running and finished agents", () => {
    const views = agentViews(
      [
        snapshot({ id: "run-1", displayName: "runner", status: "running" }),
        snapshot({ id: "idle-1", displayName: "sleeper", status: "idle" }),
        snapshot({ id: "dead-1", displayName: "gone", status: "aborted" }),
      ],
      new Set(),
    );
    const { getByRole, queryByRole } = render(
      <AgentsCenter views={views} activity={{}} onSelect={vi.fn()} onBack={vi.fn()} />,
    );
    expect(getByRole("heading").textContent).toBe("Agents (3)");

    fireEvent.click(getByRole("button", { name: "Running" }));
    expect(getByRole("button", { name: /runner/ })).toBeTruthy();
    expect(queryByRole("button", { name: /sleeper/ })).toBeNull();
    expect(getByRole("heading").textContent).toBe("Agents (1)");

    fireEvent.click(getByRole("button", { name: "Finished" }));
    expect(queryByRole("button", { name: /runner/ })).toBeNull();
    expect(getByRole("button", { name: /sleeper/ })).toBeTruthy();
    expect(getByRole("button", { name: /gone/ })).toBeTruthy();
    expect(getByRole("heading").textContent).toBe("Agents (2)");

    fireEvent.click(getByRole("button", { name: "All" }));
    expect(getByRole("heading").textContent).toBe("Agents (3)");
  });

  it("hands the selected id to onSelect and does not render transcripts", () => {
    const onSelect = vi.fn();
    const { getByRole, container } = render(
      <AgentsCenter
        views={Object.values(roster())}
        activity={{ "sub-1": activity({ agentId: "sub-1", task: "do the thing" }) }}
        onSelect={onSelect}
        onBack={vi.fn()}
      />,
    );
    fireEvent.click(getByRole("button", { name: /plain-sub/ }));
    expect(onSelect).toHaveBeenCalledWith("sub-1");
    expect(container.querySelector("pre")).toBeNull();
  });
});

describe("AgentDetail", () => {
  const props = (id: string, over: Record<string, unknown> = {}) => ({
    view: roster()[id]!,
    activity: activity({ agentId: id, task: "short task" }),
    transcript: undefined,
    transcriptError: null,
    loading: false,
    onFetchTranscript: vi.fn(),
    onBack: vi.fn(),
    ...over,
  });

  it("shows the FULL 5,000-char task, which the list only previewed", () => {
    const long = Array.from({ length: 5_000 }, (_, i) => (i % 97 === 0 ? "\n" : "y")).join("");
    const view = roster()["sub-1"]!;
    const list = render(
      <AgentsCenter
        views={[view]}
        activity={{ "sub-1": activity({ agentId: "sub-1", task: long }) }}
        onSelect={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    // Absent from the list...
    const listRow = list.getByRole("button", { name: /plain-sub/ });
    expect(listRow.textContent).not.toContain(long);
    expect(listRow.querySelector("pre")).toBeNull();
    cleanup();

    // ...present in full on detail.
    const detail = render(
      <AgentDetail {...props("sub-1", { activity: activity({ agentId: "sub-1", task: long }) })} />,
    );
    fireEvent.click(detail.getByText("Show full task"));
    expect(detail.getByRole("code").textContent).toBe(long);
  });

  it("states when the host reported no task, and never invents one", () => {
    const { getByText } = render(<AgentDetail {...props("sub-1", { activity: undefined })} />);
    expect(getByText("The host reported no task for this agent.")).toBeTruthy();
  });

  it("names the model as not reported, because the wire snapshot has none", () => {
    const { getByText } = render(<AgentDetail {...props("sub-1")} />);
    expect(getByText(/model: not reported/)).toBeTruthy();
  });

  it("notes that a live-only task may not survive reconnect", () => {
    const { getAllByRole } = render(<AgentDetail {...props("sub-1")} />);
    const notes = getAllByRole("note").map((note) => note.textContent ?? "");
    expect(notes.some((text) => text.includes("live-only") && text.includes("reconnect"))).toBe(true);
  });

  it("offers Kill for a proven worker only", () => {
    const onKillWorker = vi.fn();
    const { getByRole } = render(<AgentDetail {...props("worker-1", { onKillWorker })} />);
    fireEvent.click(getByRole("button", { name: "Kill worker" }));
    expect(onKillWorker).toHaveBeenCalledWith("worker-1");
  });

  it("never offers Kill to the main agent, and shows why it is read-only", () => {
    const view = props("main").view;
    const { queryByRole, getByText } = render(<AgentDetail {...props("main")} />);
    expect(queryByRole("button", { name: "Kill worker" })).toBeNull();
    expect(getByText(view.readOnlyReason!)).toBeTruthy();
  });

  it("does not offer Kill on a read-only link, and says why", () => {
    // The host would refuse the frame, so the control must not be presented as
    // available. Same rule the Vibe panel applies.
    const worker = props("w1", { view: { ...props("w1").view, class: "worker", canKillWorker: true, readOnlyReason: null } });
    const { queryByRole, getByText } = render(<AgentDetail {...worker} readOnly />);
    expect(queryByRole("button", { name: "Kill worker" })).toBeNull();
    expect(getByText(/read-only/)).toBeTruthy();
  });

  it("never offers Kill to a plain subagent, and shows why it is read-only", () => {
    const view = props("sub-1").view;
    const { queryByRole, getByText } = render(<AgentDetail {...props("sub-1")} />);
    expect(queryByRole("button", { name: "Kill worker" })).toBeNull();
    expect(getByText(view.readOnlyReason!)).toBeTruthy();
  });

  it("renders an unavailable transcript state when the host reported no session file", () => {
    const { getByRole, queryByText } = render(
      <AgentDetail {...props("sub-1", { view: { ...props("sub-1").view, hasSessionFile: false } })} />,
    );
    expect(getByRole("status").textContent).toContain("No session file was reported");
    expect(queryByText("No transcript bytes received yet.")).toBeNull();
  });

  it("reports a transcript fetch failure instead of an empty success", () => {
    const { getByRole, container } = render(
      <AgentDetail {...props("sub-1", { transcriptError: "Transcript request timed out." })} />,
    );
    expect(getByRole("alert").textContent).toContain("Transcript request timed out.");
    expect(container.querySelector("pre.agent-transcript")).toBeNull();
  });

  it("distinguishes loading from an agent that has said nothing", () => {
    const { getByRole } = render(<AgentDetail {...props("sub-1", { loading: true })} />);
    expect(getByRole("status").textContent).toBe("Loading transcript…");
  });

  it("stops polling a finished agent once its cursor settles", () => {
    vi.useFakeTimers();
    try {
      const onFetchTranscript = vi.fn();
      const finished = { ...props("sub-1").view, status: "idle" as const };
      const view = render(<AgentDetail {...props("sub-1", { onFetchTranscript, view: finished })} />);
      vi.advanceTimersByTime(10_000);
      const settled = onFetchTranscript.mock.calls.length;
      vi.advanceTimersByTime(10_000);
      expect(onFetchTranscript.mock.calls.length).toBe(settled);
      // The last request still happened: stopping the loop did not drop the tail.
      expect(settled).toBeGreaterThan(0);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls the transcript while the agent is running and shows the received bytes", () => {
    vi.useFakeTimers();
    try {
      const onFetchTranscript = vi.fn();
      const view = render(
        <AgentDetail {...props("sub-1", { onFetchTranscript, transcript: { text: "hello\n", newSize: 6, carry: "" } })} />,
      );
      expect(onFetchTranscript).toHaveBeenCalledWith("sub-1", 6);
      view.rerender(
        <AgentDetail
          {...props("sub-1", { onFetchTranscript, transcript: { text: "hello\n", newSize: 6, carry: "" } })}
        />,
      );
      vi.advanceTimersByTime(2400);
      expect(onFetchTranscript.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(view.getByText(/hello/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
