/**
 * Round 53 regression tests for the defects this round fixes.
 *
 * Each case is written against the behaviour that was actually broken, not
 * against the implementation that replaced it:
 *
 *  - B10: a `task:subagent:progress` frame carrying a multi-page task used to be
 *    concatenated into one `notice` string and rendered as a banner. The task body
 *    must now live in structured activity, and the notice path must stay bounded.
 *  - B01: the Vibe panel was handed the whole roster and offered Kill for any
 *    running agent. Classification must come from journal evidence, and only a
 *    proven worker may carry the destructive control.
 *  - B09: the advisor chip painted a live alarm from historical notes.
 */
import { describe, expect, it } from "vitest";
import { createTranscriptState, reduceHostFrame } from "../../apps/web/src/transcript.js";
import { agentCounts, agentViews, taskPreview, vibeWorkerIds } from "../../apps/web/src/agent-model.js";
import type { AgentSnapshot } from "@caw/collab-protocol";

// ── B10: bounded activity, never a giant banner ────────────────────────────────

function progressFrame(task: string, id = "sub-1") {
  return {
    t: "bus",
    channel: "task:subagent:progress",
    data: { index: 0, agent: "caw-deepseek", task, progress: { id, status: "running", currentTool: "edit" } },
  } as never;
}

describe("B10 — subagent progress is structured, and the banner stays bounded", () => {
  // The sizes the task named, including the two that make a banner unusable.
  for (const [label, size] of [["50 chars", 50], ["500 chars", 500], ["5,000 chars", 5_000], ["50,000 chars", 50_000]] as const) {
    it(`keeps a ${label} task out of the banner and intact in activity`, () => {
      const task = "A".repeat(size);
      const state = reduceHostFrame(createTranscriptState(), progressFrame(task));
      expect(state.agentActivity["sub-1"]!.task).toBe(task);
      // The whole point: no banner was created at all for an identified agent.
      expect(state.notice).toBeNull();
    });
  }

  it("accepts markdown, code fences, newlines and unicode without truncating", () => {
    const task = [
      "# Heading", "", "```ts", "const x = 1;", "```", "",
      "- item\n- item", "", "| a | b |", "| - | - |", "",
      "Tiếng Việt có dấu — emoji 🚀", "€ £ ¥", "<script>alert(1)</script>",
    ].join("\n");
    const state = reduceHostFrame(createTranscriptState(), progressFrame(task));
    // Stored verbatim: escaping is the renderer's job, not the reducer's, and
    // mangling here would lose the original.
    expect(state.agentActivity["sub-1"]!.task).toBe(task);
  });

  it("does not let rapid updates to one agent multiply rows", () => {
    let state = createTranscriptState();
    for (let i = 0; i < 50; i += 1) state = reduceHostFrame(state, progressFrame(`task ${i}`, "sub-1"));
    expect(Object.keys(state.agentActivity)).toEqual(["sub-1"]);
    expect(state.agentActivity["sub-1"]!.task).toBe("task 49");
  });

  it("keeps the earlier full brief when a later frame carries only a tool update", () => {
    // Real hosts send the brief once and then short tool deltas; dropping the
    // brief would lose the only copy on a live-only channel.
    let state = reduceHostFrame(createTranscriptState(), progressFrame("the full brief", "sub-1"));
    state = reduceHostFrame(state, progressFrame("", "sub-1"));
    expect(state.agentActivity["sub-1"]!.task).toBe("the full brief");
  });

  it("marks the activity live-only, because OMP does not persist bus frames", () => {
    const state = reduceHostFrame(createTranscriptState(), progressFrame("brief"));
    expect(state.agentActivity["sub-1"]!.liveOnly).toBe(true);
  });

  it("falls back to a bounded notice when the host sends no agent id", () => {
    const state = reduceHostFrame(createTranscriptState(), {
      t: "bus", channel: "task:subagent:progress",
      data: { agent: "anon", task: "Z".repeat(50_000), progress: { status: "running" } },
    } as never);
    // Unattributable ⇒ nothing invented: no activity key, and a short notice that
    // cannot carry the task body.
    expect(state.agentActivity).toEqual({});
    expect(state.notice!.message.length).toBeLessThan(120);
    expect(state.notice!.message).not.toContain("ZZZ");
  });

  it("reports a failure as an error level without a giant banner", () => {
    const state = reduceHostFrame(createTranscriptState(), {
      t: "bus", channel: "task:subagent:lifecycle",
      data: { id: "sub-9", agent: "reviewer", description: "E".repeat(9_000), status: "failed" },
    } as never);
    expect(state.agentActivity["sub-9"]!.level).toBe("error");
    expect(state.notice).toBeNull();
  });

  it("clears activity on a fresh welcome, so a reconnect cannot duplicate rows", () => {
    const withActivity = reduceHostFrame(createTranscriptState(), progressFrame("brief", "sub-1"));
    const reconnected = reduceHostFrame(withActivity, {
      t: "welcome", proto: 3,
      header: { sessionId: "s", cwd: "/", timestamp: null, version: 1, title: "t" },
      state: { isStreaming: false, queuedMessageCount: 0, cwd: "/", participants: [] },
      agents: [], entryCount: 0,
    } as never);
    expect(reconnected.agentActivity).toEqual({});
  });
});

// ── B01/B11: classification and the destructive-control gate ───────────────────

function snapshot(over: Partial<AgentSnapshot> & { id: string }): AgentSnapshot {
  return {
    displayName: over.id, kind: "sub", status: "running",
    hasSessionFile: true, createdAt: 0, lastActivity: 0, ...over,
  } as AgentSnapshot;
}

describe("B01 — only a proven Vibe worker may be a Kill target", () => {
  const roster: AgentSnapshot[] = [
    snapshot({ id: "main", kind: "main", displayName: "director" }),
    snapshot({ id: "sub-1" }),
    snapshot({ id: "sub-2" }),
  ];

  it("accepts the server's id list, which is the shape the route actually returns", () => {
    // Regression for a real defect: `GET /vibe` returns `workerIds: string[]`, and
    // the classifier only understood raw journal records. Every id was therefore
    // dropped, no agent was ever classified as a worker, and the Kill control (and
    // the worker chip count) were unreachable — compiled clean, because the state
    // was typed `unknown[]`.
    expect([...vibeWorkerIds(["w1", "w2"])]).toEqual(["w1", "w2"]);
    const views = agentViews([snapshot({ id: "w1" })], vibeWorkerIds(["w1"]));
    expect(views[0]!.class).toBe("worker");
    expect(views[0]!.canKillWorker).toBe(true);
  });

  it("still drops unreadable or unattributable evidence in both shapes", () => {
    expect([...vibeWorkerIds(["", 42, null, {}, { id: "x" }, { id: "y", ownerId: "main" }])]).toEqual([]);
  });

  it("recognises a worker only from a journal lifecycle record", () => {
    // sub-2 is a real worker; sub-1 is an ordinary subagent. Both are
    // `kind: "sub"` and both are running, so only the journal record separates them.
    const ids = vibeWorkerIds([
      { id: "sub-2", ownerId: "main", parentSessionId: "sess" },
      { id: "", ownerId: "main", parentSessionId: "sess" },
      { id: "sub-3", ownerId: "main" },
      { id: "sub-4", parentSessionId: "sess" },
      null,
    ]);
    // Only the fully-attributable record yields an id. A record missing its owner
    // or parent is not proof of ownership and must not produce one.
    expect([...ids]).toEqual(["sub-2"]);
  });

  it("gives Kill to the worker only — never the main agent, never a plain subagent", () => {
    const views = agentViews(roster, vibeWorkerIds([{ id: "sub-2", ownerId: "main", parentSessionId: "sess" }]));
    const byId = Object.fromEntries(views.map((v) => [v.id, v]));
    expect(byId["sub-2"]!.class).toBe("worker");
    expect(byId["sub-2"]!.canKillWorker).toBe(true);
    expect(byId["main"]!.class).toBe("main");
    expect(byId["main"]!.canKillWorker).toBe(false);
    expect(byId["sub-1"]!.class).toBe("subagent");
    expect(byId["sub-1"]!.canKillWorker).toBe(false);
  });

  it("explains why a read-only row has no control, instead of hiding it", () => {
    const views = agentViews(roster, new Set());
    for (const view of views) {
      expect(view.canKillWorker).toBe(false);
      expect(view.readOnlyReason).not.toBeNull();
    }
  });

  it("counts workers separately from subagents", () => {
    const views = agentViews(roster, vibeWorkerIds([{ id: "sub-2", ownerId: "main", parentSessionId: "sess" }]));
    const counts = agentCounts(views);
    // The header chip must not call three agents "3 workers".
    expect(counts.workers).toBe(1);
    expect(counts.runningWorkers).toBe(1);
    expect(counts.runningSubagents).toBe(1);
    expect(counts.total).toBe(3);
  });

  it("never promotes an unclassified agent to worker when evidence is missing", () => {
    const views = agentViews([snapshot({ id: "x" })], new Set());
    expect(views[0]!.class).toBe("subagent");
  });
});

describe("task preview bounding", () => {
  it("bounds by characters and by lines", () => {
    expect(taskPreview("short")).toBe("short");
    // 300 short lines is as tall as 300 lines even though it is short in chars.
    const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    expect(taskPreview(manyLines).split("\n")).toHaveLength(1);
    expect(taskPreview("x".repeat(5_000)).length).toBeLessThanOrEqual(141);
    expect(taskPreview("x".repeat(5_000)).endsWith("…")).toBe(true);
  });
});
