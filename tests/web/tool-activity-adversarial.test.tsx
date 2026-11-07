// @vitest-environment jsdom
/**
 * Adversarial checks on the activity card: the ways it could lie or merge
 * something it has no right to merge.
 *
 * Every claim here is asserted at the level where it is decided, not at the
 * level where it is displayed: the fold predicate for merging, `groupState` for
 * the verdict, `testSummaryOf` for a fabricated metric, and the mounted DOM for
 * the accessible name. A restyle cannot make these pass or fail.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ActivityGroupRow } from "../../apps/web/src/components/ToolActivity.js";
import {
  categoryLabel,
  flattenActivity,
  groupActivity,
  groupEvidence,
  groupState,
  groupSummary,
  pairToolArguments,
  testSummaryOf,
  toolMembers,
  type ActivityGroup,
  type ToolActivityRow,
} from "../../apps/web/src/tool-activity.js";

const VITEST_CLEAN = [" Test Files  1 passed (1)", "      Tests  15 passed (15)"].join("\n");
const VITEST_FAILING = [" Test Files  1 failed (1)", "      Tests  3 failed | 15 passed (18)"].join("\n");

function toolRow(over: Partial<ToolActivityRow> & { id: string }): ToolActivityRow {
  return { role: "tool", text: "", toolName: "bash", ...over };
}

function bashRow(id: string, callId: string, text: string, over: Partial<ToolActivityRow> = {}): ToolActivityRow {
  return toolRow({ id, toolCallId: callId, text, toolResult: { content: [{ type: "text", text }], details: {} }, ...over });
}

/** An assistant request block; renders nothing once its result row is on screen. */
function callBlock(id: string, callId: string, toolName = "bash"): ToolActivityRow {
  return {
    id,
    role: "assistant",
    text: "",
    blocks: [{ type: "toolCall", name: toolName, arguments: { command: `step-${id}` }, id: callId }],
  };
}

const groupsOf = (rows: readonly ToolActivityRow[]): ActivityGroup[] =>
  groupActivity(rows).flatMap((entry) => (entry.kind === "group" ? [entry.group] : []));

const evidenceOf = (group: ActivityGroup, rows: readonly ToolActivityRow[] = []) =>
  groupEvidence(group, pairToolArguments(rows));

afterEach(cleanup);

/* ------------------------------------------------------------------ */
/* 1. Cross-turn merging                                              */
/* ------------------------------------------------------------------ */

describe("1 — a run is broken by every row that actually renders", () => {
  it("does NOT merge two commands separated by a prose row", () => {
    const rows = [
      callBlock("a1", "c1"),
      toolRow({ id: "t1", toolCallId: "c1" }),
      // The turn boundary: an assistant message with words in it. Nothing about
      // `c2`'s result can be known yet, and the reader sees this sentence between
      // the two commands.
      { id: "a2", role: "assistant" as const, text: "That worked; now the tests." },
      callBlock("a3", "c2"),
      toolRow({ id: "t2", toolCallId: "c2" }),
    ];
    const groups = groupsOf(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => toolMembers(group).length)).toEqual([1, 1]);
  });

  it("DOES merge two commands separated only by suppression echoes", () => {
    const rows = [
      callBlock("a1", "c1"),
      toolRow({ id: "t1", toolCallId: "c1" }),
      callBlock("a2", "c2"),
      toolRow({ id: "t2", toolCallId: "c2" }),
    ];
    const groups = groupsOf(rows);
    expect(groups).toHaveLength(1);
    expect(toolMembers(groups[0]!)).toHaveLength(2);
  });

  it("does NOT merge across a user row, a notice, an advisor card, or an image", () => {
    const splits: Array<[string, ToolActivityRow]> = [
      ["user", { id: "u1", role: "user", text: "next prompt" }],
      ["notice", { id: "n1", role: "notice", text: "Model changed: x" }],
      // An advisor card is a `notice` row with structured details; `MessageRow`
      // renders it structurally, so it is visible and must break the run.
      ["advisor", { id: "adv1", role: "notice", text: "Advisor", customType: "advisor" } as ToolActivityRow],
      // An assistant row carrying an image block is not a call echo.
      ["image", { id: "img1", role: "assistant", text: "", blocks: [{ type: "image", label: "shot.png" }] }],
    ];
    for (const [name, breaker] of splits) {
      const rows = [
        toolRow({ id: `t-${name}-1`, toolCallId: `c-${name}-1` }),
        breaker,
        toolRow({ id: `t-${name}-2`, toolCallId: `c-${name}-2` }),
      ];
      expect(groupsOf(rows), `${name} must break the run`).toHaveLength(2);
    }
  });

  it("does NOT merge an assistant row whose toolCall has no result on screen", () => {
    // The gap case: the result never arrived (or never will). The request is the
    // only record of the operation, so it renders, so it breaks the run.
    const rows = [
      toolRow({ id: "t1", toolCallId: "c1" }),
      callBlock("a2", "c-missing"),
      toolRow({ id: "t2", toolCallId: "c2" }),
    ];
    expect(groupsOf(rows)).toHaveLength(2);
    expect(flattenActivity(groupActivity(rows)).map((row) => row.id)).toEqual(["t1", "a2", "t2"]);
  });

  it("does NOT merge a call whose arguments are not a record", () => {
    // `MessageRow` cannot suppress this one (it must not lose the arguments), so
    // the fold must not absorb it either.
    const rows = [
      toolRow({ id: "t1", toolCallId: "c1" }),
      { id: "a2", role: "assistant" as const, text: "", blocks: [{ type: "toolCall" as const, name: "bash", arguments: [1, 2], id: "c2" }] },
      toolRow({ id: "t2", toolCallId: "c2" }),
    ];
    expect(groupsOf(rows)).toHaveLength(2);
  });

  it("still splits a merged run by category", () => {
    const rows = [
      callBlock("a1", "c1"),
      toolRow({ id: "t1", toolCallId: "c1", toolName: "read", toolArgs: { path: "/a.ts" } }),
      callBlock("a2", "c2"),
      toolRow({ id: "t2", toolCallId: "c2", toolName: "bash" }),
    ];
    expect(groupsOf(rows).map((group) => group.category)).toEqual(["read", "command"]);
  });

  it("never spans a slice that is not contiguous tool/assistant rows", () => {
    const rows = [
      { id: "u1", role: "user" as const, text: "go" },
      callBlock("a1", "c1"),
      toolRow({ id: "t1", toolCallId: "c1" }),
      { id: "a2", role: "assistant" as const, text: "done" },
      { id: "u2", role: "user" as const, text: "again" },
      callBlock("a3", "c2"),
      toolRow({ id: "t2", toolCallId: "c2" }),
    ];
    const entries = groupActivity(rows);
    for (const entry of entries) {
      if (entry.kind !== "group") continue;
      const ids = entry.group.rows.map((row) => row.id);
      const start = rows.findIndex((row) => row.id === ids[0]);
      expect(rows.slice(start, start + ids.length).map((row) => row.id)).toEqual(ids);
      // ...and no member is a user/notice row.
      expect(entry.group.rows.every((row) => row.role === "tool" || row.role === "assistant")).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. State honesty                                                    */
/* ------------------------------------------------------------------ */

describe("2 — the verdict is the worst member, and never contradicts its own metric", () => {
  it("reports failed when one member failed", () => {
    const groups = groupsOf([toolRow({ id: "t1" }), toolRow({ id: "t2", isError: true })]);
    expect(groupState(groups[0]!, evidenceOf(groups[0]!))).toBe("failed");
  });

  it("reports running when one member is running, even beside a failure", () => {
    const groups = groupsOf([toolRow({ id: "t1", isError: true }), toolRow({ id: "t2", isRunning: true })]);
    expect(groupState(groups[0]!, evidenceOf(groups[0]!))).toBe("running");
  });

  it("escalates a text-proven failure, so state and metric can never disagree", () => {
    const rows = [bashRow("t1", "c1", VITEST_FAILING)];
    const groups = groupsOf(rows);
    const evidence = evidenceOf(groups[0]!, rows);
    // The wire said nothing about failure...
    expect(rows[0]!.isError).toBeUndefined();
    // ...but the group's own output did.
    expect(evidence.failed).toBe(0);
    expect(evidence.test?.failed).toBe(3);
    expect(groupState(groups[0]!, evidence)).toBe("failed");
    // The invariant: whenever the metric reports a failure, the state is `failed`.
    expect(groupSummary(groups[0]!, evidence).metric).toContain("3 failed");
  });

  it("takes the WORST summary in the group, not the first", () => {
    // The hole this pins: `[clean, failing]` used to print `15 passed` under `✓`.
    const rows = [bashRow("t1", "c1", VITEST_CLEAN), bashRow("t2", "c2", VITEST_FAILING)];
    const groups = groupsOf(rows);
    const evidence = evidenceOf(groups[0]!, rows);
    expect(evidence.test?.failed).toBe(3);
    expect(groupState(groups[0]!, evidence)).toBe("failed");
  });

  it("keeps a clean group clean when every summary is clean", () => {
    const rows = [bashRow("t1", "c1", VITEST_CLEAN), bashRow("t2", "c2", VITEST_CLEAN)];
    const groups = groupsOf(rows);
    const evidence = evidenceOf(groups[0]!, rows);
    expect(groupState(groups[0]!, evidence)).toBe("completed");
    expect(groupSummary(groups[0]!, evidence).metric).toBe("15 passed");
  });

  it("moves the metric, not the state, when a command merely prints the word passed", () => {
    const rows = [bashRow("t1", "c1", "all good, everything has passed the review")];
    const groups = groupsOf(rows);
    const evidence = evidenceOf(groups[0]!, rows);
    expect(evidence.test).toBeNull();
    expect(groupState(groups[0]!, evidence)).toBe("completed");
    expect(groupSummary(groups[0]!, evidence).metric).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Evidence parsing safety                                          */
/* ------------------------------------------------------------------ */

describe("3 — a metric is parsed only from a runner's own summary line", () => {
  const parse = (text: string, toolName = "bash") =>
    testSummaryOf(toolRow({ id: "c1", toolName, text, toolResult: { content: [{ type: "text", text }], details: {} } }), "command");

  it("ignores prose that contains the word passed", () => {
    expect(parse("The tests passed. All 12 checks passed on review.")).toBeNull();
    expect(parse("has passed review by two people")).toBeNull();
    expect(parse("Tests failing since Tuesday — see the ticket")).toBeNull();
  });

  it("ignores a JSON payload with passed/failed keys", () => {
    expect(parse('{"passed": 12, "failed": 0}')).toBeNull();
    expect(parse('{"Tests": "12 passed"}')).toBeNull();
    expect(parse('{ "tests": { "passed": 3, "failed": 1 } }')).toBeNull();
  });

  it("ignores a truncated summary with no total", () => {
    expect(parse("      Tests  3 failed | 15 pas")).toBeNull();
    expect(parse("      Tests  3 failed | 15")).toBeNull();
    expect(parse("      Tests  passed")).toBeNull();
  });

  it("ignores numbers that contradict the runner's own total", () => {
    // Sum exceeds the declared total: two different counts glued together.
    expect(parse("      Tests  10 passed | 9 failed (12)")).toBeNull();
    // Equal to the total is fine, and skipped explains a lower sum.
    expect(parse("      Tests  9 passed | 3 failed (12)")).toEqual({ passed: 9, failed: 3, source: "Tests  9 passed | 3 failed (12)" });
    expect(parse("      Tests  3 failed | 1343 passed | 8 skipped (1354)")).toEqual({
      passed: 1343,
      failed: 3,
      source: "Tests  3 failed | 1343 passed | 8 skipped (1354)",
    });
  });

  it("accepts the pytest banner and nothing that merely ends in 'in 1.2s'", () => {
    expect(parse("=== 5 passed, 1 failed in 0.52s ===")).toEqual({ passed: 5, failed: 1, source: "=== 5 passed, 1 failed in 0.52s ===" });
    expect(parse("tests finished in 1.2s")).toBeNull();
  });

  it("never parses a file read, so a logged run is not this session's run", () => {
    const read = toolRow({
      id: "r1",
      toolName: "read",
      text: VITEST_FAILING,
      toolResult: { content: [{ type: "text", text: VITEST_FAILING }], details: { resolvedPath: "/w/ci.log" } },
    });
    expect(testSummaryOf(read, "read")).toBeNull();
  });

  it("reads the newest summary when one result holds two runs", () => {
    const twoRuns = [VITEST_FAILING, VITEST_CLEAN].join("\n");
    expect(parse(twoRuns)?.passed).toBe(15);
    expect(parse(twoRuns)?.failed).toBe(0);
  });

  it("reads only a bounded tail, so a huge result costs no full scan", () => {
    // The summary sits past the tail window: not claimed. This is the documented
    // ceiling — a runner prints its summary last, and the cost bound is the reason.
    const buried = [VITEST_FAILING, ...Array.from({ length: 500 }, (_, index) => `noise ${index}`)].join("\n");
    expect(parse(buried)).toBeNull();
    // Inside the window it is still found.
    const nearTail = ["noise", ...Array.from({ length: 50 }, (_, index) => `noise ${index}`), VITEST_FAILING].join("\n");
    expect(parse(nearTail)?.failed).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* 4/6. The head's accessible name and the keyboard path               */
/* ------------------------------------------------------------------ */

describe("4 — the head's accessible name is the whole truth", () => {
  it("includes state, label, note and counts for an edit group", () => {
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n";
    const rows = [
      toolRow({
        id: "e1",
        toolName: "edit",
        // A test log inside an edit result is deliberately NOT parsed: editing a
        // file does not run tests. See the category gate in `testSummaryOf`.
        text: VITEST_FAILING,
        toolResult: {
          content: [{ type: "text", text: VITEST_FAILING }],
          details: { perFileResults: [{ path: "src/a.ts", op: "edit", diff }] },
        },
      }),
    ];
    const groups = groupsOf(rows);
    const view = render(<ActivityGroupRow group={groups[0]!} pairedArgs={pairToolArguments(rows)} />);
    const head = view.container.querySelector(".activity-group-head") as HTMLElement;
    const spoken = head.getAttribute("aria-label") ?? "";
    expect(spoken).toBe("Completed: Edit 1 operation, Changed 1 file, +2 −1");
    // The glyph is decoration and must not double-read.
    expect(view.container.querySelector(".activity-group-state")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("includes state, label and metric for a failed command group", () => {
    const rows = [bashRow("t1", "c1", VITEST_FAILING)];
    const groups = groupsOf(rows);
    const view = render(<ActivityGroupRow group={groups[0]!} pairedArgs={pairToolArguments(rows)} />);
    const head = view.container.querySelector(".activity-group-head") as HTMLElement;
    // The visible text a sighted user reads, and the same words in the name.
    expect(head.textContent).toContain("Run 1 command");
    expect(head.textContent).toContain("3 failed | 15 passed");
    expect(head.getAttribute("aria-label")).toBe("Failed: Run 1 command, 3 failed | 15 passed");
  });

  it("is reachable by keyboard and reports its expanded state", () => {
    const rows = [bashRow("t1", "c1", "exit 0")];
    const groups = groupsOf(rows);
    const view = render(<ActivityGroupRow group={groups[0]!} pairedArgs={new Map()} />);
    const head = view.container.querySelector(".activity-group-head") as HTMLElement;
    // A real button: focusable and activatable without a pointer.
    expect(head.tagName).toBe("BUTTON");
    expect(head.hasAttribute("disabled")).toBe(false);
    head.focus();
    expect(document.activeElement).toBe(head);
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(view.container.querySelectorAll(".tool-row").length).toBe(1);
  });

  it("announces the failing member's text, which is real visible text under the head", () => {
    const rows = [bashRow("t1", "c1", "ERR_SENTINEL\nstack line", { isError: true })];
    const groups = groupsOf(rows);
    const view = render(<ActivityGroupRow group={groups[0]!} pairedArgs={new Map()} />);
    const preview = view.container.querySelector(".tool-output-preview") as HTMLElement;
    expect(preview.textContent).toContain("ERR_SENTINEL");
    // Not aria-hidden and not behind a control: it is in the accessibility tree of
    // the collapsed card, read after the head's own name.
    expect(preview.getAttribute("aria-hidden")).toBeNull();
    expect(preview.closest("[aria-hidden='true']")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 5. A failure proven by output alone is still readable when collapsed */
/* ------------------------------------------------------------------ */

describe("5 — output-only failure is legible without a tap (W7)", () => {
  it("shows the runner's own summary line when no member was flagged", () => {
    // The wire says every call was clean; only the runner's output says otherwise.
    // This is the group where a head-only `✕` would be the reader's only clue.
    const rows = [bashRow("t1", "c1", `> pnpm vitest run\n${VITEST_FAILING}`)];
    expect(rows[0]!.isError).toBeUndefined();
    const groups = groupsOf(rows);
    const view = render(<ActivityGroupRow group={groups[0]!} pairedArgs={pairToolArguments(rows)} />);
    const head = view.container.querySelector(".activity-group-head") as HTMLElement;
    expect(head.textContent).toContain("3 failed | 15 passed");
    const preview = view.container.querySelector(".activity-group > .tool-output-preview") as HTMLElement;
    expect(preview).not.toBeNull();
    // The runner's line, verbatim, and honestly attributed: not "Error:", because
    // no member reported an error.
    expect(preview.textContent).toBe("Runner reported: Tests  3 failed | 15 passed (18)");
    expect(preview.textContent).not.toContain("Error");
    // Still in the accessibility tree after the head, so a screen reader hears it.
    expect(preview.getAttribute("aria-hidden")).toBeNull();
    expect(preview.closest("[aria-hidden='true']")).toBeNull();
  });

  it("prefers a wire-failed member's own text, which is richer", () => {
    const rows = [
      bashRow("t1", "c1", `ERR_SENTINEL\nsome detail\n${VITEST_FAILING}`, { isError: true }),
    ];
    const groups = groupsOf(rows);
    const view = render(<ActivityGroupRow group={groups[0]!} pairedArgs={pairToolArguments(rows)} />);
    const preview = view.container.querySelector(".activity-group > .tool-output-preview") as HTMLElement;
    expect(preview.textContent).toContain("ERR_SENTINEL");
    expect(preview.textContent).not.toContain("Runner reported:");
  });

  it("shows nothing for a clean group, and nothing for a running one", () => {
    const clean = groupsOf([bashRow("t1", "c1", `ok\n${VITEST_CLEAN}`)]);
    const cleanView = render(<ActivityGroupRow group={clean[0]!} pairedArgs={new Map()} />);
    expect(cleanView.container.querySelector(".activity-group > .tool-output-preview")).toBeNull();
    cleanup();

    const running = groupsOf([toolRow({ id: "t1", isRunning: true, text: "partial output" })]);
    const runningView = render(<ActivityGroupRow group={running[0]!} pairedArgs={new Map()} />);
    expect(runningView.container.querySelector(".activity-group--running")).not.toBeNull();
    // A running group is not a failure: its partial output is not a preview claim,
    // and it must never render under a `✕`.
    expect(runningView.container.querySelector(".activity-group > .tool-output-preview")).toBeNull();
  });

  it("keeps the preview open-independent: expanding replaces it with the members", () => {
    const rows = [bashRow("t1", "c1", VITEST_FAILING)];
    const groups = groupsOf(rows);
    const view = render(<ActivityGroupRow group={groups[0]!} pairedArgs={new Map()} />);
    const head = view.container.querySelector(".activity-group-head") as HTMLElement;
    expect(view.container.querySelector(".activity-group > .tool-output-preview")).not.toBeNull();
    fireEvent.click(head);
    // Expanded: the member row is on screen and carries the same text itself, so
    // the preview is gone rather than duplicated.
    expect(view.container.querySelector(".activity-group > .tool-output-preview")).toBeNull();
    expect(view.container.querySelector(".tool-row .tool-output-preview")).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 6. A zero count never prints an operation noun                     */
/* ------------------------------------------------------------------ */

describe("6 — a zero-count label (W21)", () => {
  it("says 'No operations' rather than 'Run 0 commands'", () => {
    for (const category of ["read", "search", "command", "test", "edit", "patch", "diff", "other"] as const) {
      expect(categoryLabel(category, 0)).toBe("No operations");
      expect(categoryLabel(category, 0)).not.toMatch(/\b0\b/);
    }
    // Real counts are unchanged.
    expect(categoryLabel("command", 1)).toBe("Run 1 command");
    expect(categoryLabel("command", 4)).toBe("Run 4 commands");
    expect(categoryLabel("read", 8)).toBe("Read 8 files");
  });
});
