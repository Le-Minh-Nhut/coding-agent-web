// @vitest-environment jsdom
/**
 * The activity card: fewer cards, still every fact.
 *
 * Three claims are pinned here, each with the evidence it is derived from.
 *
 *  1. **The fold is lossless.** `flattenActivity(groupActivity(rows))` is `rows`,
 *     in order, so neither the merge nor the echo-folding can drop an operation.
 *  2. **A run is one card.** Assistant rows the renderer draws as nothing (a
 *     `toolCall` block whose result row is on screen) no longer split a run; a row
 *     that *does* draw — prose, an unrepresented call, a notice — still does.
 *  3. **No claim without proof.** A label is printed only from the records behind
 *     it: a file count from distinct proven paths, a test metric only from a
 *     runner's own summary line, and a failure announced in words even when the
 *     wire flagged the call clean.
 */
import { describe, expect, it } from "vitest";
import {
  flattenActivity,
  groupActivity,
  groupEvidence,
  groupState,
  groupSummary,
  pairToolArguments,
  runningSubagents,
  subagentLabel,
  stateGlyph,
  stateWord,
  testSummaryOf,
  toolMembers,
  type ActivityGroup,
  type ToolActivityRow,
} from "../../apps/web/src/tool-activity.js";

function toolRow(over: Partial<ToolActivityRow> & { id: string }): ToolActivityRow {
  return { role: "tool", text: "", toolName: "read", ...over };
}

/** An assistant row that renders nothing: a call whose result row is on screen. */
function echo(id: string, callId: string, toolName = "read"): ToolActivityRow {
  return {
    id,
    role: "assistant",
    text: "",
    blocks: [{ type: "toolCall", name: toolName, arguments: { path: `/w/${id}.ts` }, id: callId }],
  };
}

const DIFF = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n";

const VITEST_FAILING = [" Test Files  1 failed (1)", "      Tests  3 failed | 15 passed (18)"].join("\n");
const VITEST_CLEAN = [" Test Files  2 passed (2)", "      Tests  7 passed (7)"].join("\n");

const groups = (rows: readonly ToolActivityRow[]): ActivityGroup[] =>
  groupActivity(rows).flatMap((entry) => (entry.kind === "group" ? [entry.group] : []));

describe("the fold is lossless", () => {
  it("returns every row in order, grouped or not", () => {
    const rows: ToolActivityRow[] = [
      { id: "u1", role: "user", text: "go" },
      echo("a1", "c1"),
      toolRow({ id: "t1", toolName: "read", toolCallId: "c1" }),
      echo("a2", "c2", "bash"),
      toolRow({ id: "t2", toolName: "bash", toolCallId: "c2" }),
      { id: "a3", role: "assistant", text: "done" },
      toolRow({ id: "t3", toolName: "grep" }),
    ];
    expect(flattenActivity(groupActivity(rows)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });

  it("keeps a group's echoes as rows while never counting them", () => {
    const rows = [echo("a1", "c1"), echo("a2", "c2"), toolRow({ id: "t1", toolCallId: "c1" }), toolRow({ id: "t2", toolCallId: "c2" })];
    const [group] = groups(rows);
    // Carried, so nothing is lost...
    expect(group!.rows.map((row) => row.id)).toEqual(["a1", "a2", "t1", "t2"]);
    // ...but the label counts operations, not echoes, and its paths come from the
    // paired request blocks the echoes carry.
    expect(toolMembers(group!).map((row) => row.id)).toEqual(["t1", "t2"]);
    expect(groupSummary(group!, groupEvidence(group!, pairToolArguments(rows))).label).toBe("Read 2 files");
  });

  it("keeps an echo that no tool row ever follows as its own entry", () => {
    const rows = [{ id: "u1", role: "user", text: "go" }, echo("a1", "c1")];
    expect(flattenActivity(groupActivity(rows)).map((row) => row.id)).toEqual(["u1", "a1"]);
    expect(groups(rows)).toHaveLength(0);
  });
});

describe("one card per related run", () => {
  it("merges a run the suppressed call echoes used to split", () => {
    const rows = [
      echo("a1", "c1", "bash"),
      toolRow({ id: "t1", toolName: "bash", toolCallId: "c1" }),
      echo("a2", "c2", "bash"),
      toolRow({ id: "t2", toolName: "bash", toolCallId: "c2" }),
      echo("a3", "c3", "bash"),
      toolRow({ id: "t3", toolName: "bash", toolCallId: "c3" }),
    ];
    const found = groups(rows);
    // Was three cards ("Run 1 command" three times); now one.
    expect(found).toHaveLength(1);
    expect(found[0]!.rows.filter((row) => row.role === "tool")).toHaveLength(3);
  });

  it("splits on a category change, and on a row that actually draws", () => {
    const found = groups([
      toolRow({ id: "t1", toolName: "read" }),
      toolRow({ id: "t2", toolName: "bash" }),
      { id: "a1", role: "assistant", text: "Now the edits." },
      toolRow({ id: "t3", toolName: "edit" }),
    ]);
    expect(found.map((group) => [group.category, toolMembers(group).length])).toEqual([
      ["read", 1],
      ["command", 1],
      ["edit", 1],
    ]);
  });

  it("lets no echo bridge prose or an unrepresented call", () => {
    const withProse = groups([
      toolRow({ id: "t1" }),
      { id: "a1", role: "assistant", text: "text", blocks: [{ type: "toolCall", name: "read", arguments: { path: "/x" }, id: "c1" }, { type: "text", text: "why" }] },
      toolRow({ id: "t2", toolCallId: "c1" }),
    ]);
    expect(withProse).toHaveLength(2);

    // No result row for `c9`, so that request is the only record of itself: it must
    // render, and it must break the run.
    const withOrphan = groups([
      toolRow({ id: "t1" }),
      { id: "a1", role: "assistant", text: "", blocks: [{ type: "toolCall", name: "read", arguments: { path: "/x" }, id: "c9" }] },
      toolRow({ id: "t2" }),
    ]);
    expect(withOrphan).toHaveLength(2);
  });

  it("renders a one-member run as one card", () => {
    const found = groups([toolRow({ id: "t1", toolName: "bash" })]);
    expect(found).toHaveLength(1);
    expect(groupSummary(found[0]!, groupEvidence(found[0]!, new Map())).label).toBe("Run 1 command");
  });
});

describe("a label is printed only from the records behind it", () => {
  it("counts distinct proven read paths, not calls", () => {
    const paired = pairToolArguments([
      { id: "a1", role: "assistant", text: "", blocks: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" }, id: "c1" }] },
      { id: "a2", role: "assistant", text: "", blocks: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" }, id: "c2" }] },
    ]);
    const found = groups([toolRow({ id: "t1", toolCallId: "c1" }), toolRow({ id: "t2", toolCallId: "c2" })]);
    const summary = groupSummary(found[0]!, groupEvidence(found[0]!, paired));
    // Two calls, one file: the file count is what the paths prove.
    expect(summary.label).toBe("Read 1 file");
    expect(summary.metric).toBe("2 calls");
  });

  it("says calls, never files, when no path is proven", () => {
    const found = groups([toolRow({ id: "t1" }), toolRow({ id: "t2" })]);
    const summary = groupSummary(found[0]!, groupEvidence(found[0]!, new Map()));
    expect(summary.label).toBe("Read 2 calls");
    expect(summary.metric).toBe("2 path unverified");
  });

  it("never claims a test result the output does not contain", () => {
    const options = { content: [{ type: "text", text: "exit 0" }], details: {} };
    const row = toolRow({ id: "c1", toolName: "bash", text: "exit 0", toolResult: options });
    expect(testSummaryOf(row, "command")).toBeNull();
    const found = groups([row]);
    expect(groupSummary(found[0]!, groupEvidence(found[0]!, new Map())).metric).toBeNull();
  });

  it("reports the runner's own numbers when the output contains them", () => {
    const row = toolRow({
      id: "c1",
      toolName: "bash",
      text: VITEST_CLEAN,
      toolResult: { content: [{ type: "text", text: VITEST_CLEAN }], details: {} },
    });
    expect(testSummaryOf(row, "command")).toEqual({ passed: 7, failed: 0, source: "Tests  7 passed (7)" });
    const found = groups([row]);
    expect(groupSummary(found[0]!, groupEvidence(found[0]!, new Map())).metric).toBe("7 passed");
  });

  it("never parses a summary out of a file read", () => {
    const row = toolRow({ id: "r1", text: VITEST_CLEAN, toolResult: { content: [{ type: "text", text: VITEST_CLEAN }], details: { resolvedPath: "src/a.ts" } } });
    expect(testSummaryOf(row, "read")).toBeNull();
  });

  it("counts diff statistics only from real unified diffs", () => {
    const real = toolRow({
      id: "e1",
      toolName: "edit",
      toolResult: { content: [], details: { perFileResults: [{ path: "src/a.ts", op: "edit", diff: DIFF }] } },
    });
    const asserted = toolRow({
      id: "e2",
      toolName: "edit",
      toolResult: { content: [], details: { path: "src/b.ts", op: "edit", additions: 999, deletions: 42 } },
    });
    const found = groups([real, asserted]);
    const summary = groupSummary(found[0]!, groupEvidence(found[0]!, new Map()));
    expect(summary.label).toBe("Edit 2 operations");
    // `summarizeFileChanges` reports counts as unavailable rather than the asserted
    // numbers; the card's own label never invents a file count for an edit call.
    expect(summary.label).not.toContain("file");
  });
});

describe("a failure or a running operation is never a clean success", () => {
  it("reports a wire failure as failed and spells it out", () => {
    const found = groups([toolRow({ id: "t1" }), toolRow({ id: "t2", isError: true, text: "boom" })]);
    const evidence = groupEvidence(found[0]!, new Map());
    expect(groupState(found[0]!, evidence)).toBe("failed");
    expect(stateGlyph("failed")).toBe("✕");
    expect(stateWord("failed")).toBe("Failed");
  });

  it("escalates a clean wire flag when the runner's own output shows failures", () => {
    // Measured on this machine: 59 results were flagged `isError: false` while
    // their output said `3 failed`. A green card for those is the lie to prevent.
    const row = toolRow({
      id: "c1",
      toolName: "bash",
      text: VITEST_FAILING,
      toolResult: { content: [{ type: "text", text: VITEST_FAILING }], details: {} },
    });
    expect(row.isError).toBeUndefined();
    const found = groups([row]);
    const evidence = groupEvidence(found[0]!, new Map());
    expect(groupState(found[0]!, evidence)).toBe("failed");
    expect(groupSummary(found[0]!, evidence).metric).toBe("3 failed | 15 passed");
  });

  it("keeps running running even when every finished member succeeded", () => {
    const found = groups([toolRow({ id: "t1" }), toolRow({ id: "t2", isRunning: true })]);
    const evidence = groupEvidence(found[0]!, new Map());
    expect(groupState(found[0]!, evidence)).toBe("running");
    expect(stateWord("running")).toBe("Running");
    expect(stateGlyph("running")).toBe("◌");
  });

  it("never folds a running row into a completed summary", () => {
    // A running member makes the group running, whatever the other members say.
    const found = groups([toolRow({ id: "t1", isError: true }), toolRow({ id: "t2", isRunning: true })]);
    expect(groupState(found[0]!, groupEvidence(found[0]!, new Map()))).toBe("running");
  });
});

describe("the subagent roll-up", () => {
  it("counts only sub agents the host calls running", () => {
    expect(runningSubagents([
      { kind: "main", status: "running" },
      { kind: "sub", status: "running" },
      { kind: "sub", status: "idle" },
      { kind: "sub", status: "parked" },
    ])).toBe(1);
    expect(runningSubagents([])).toBe(0);
  });

  it("phrases the line and leaves the glyph to the state", () => {
    expect(subagentLabel(1)).toBe("1 subagent working");
    expect(subagentLabel(2)).toBe("2 subagents working");
  });
});
