// @vitest-environment jsdom
/**
 * The activity card as it renders: one head, a state word, an honest metric, and
 * an expanded body that is exactly the member rows.
 *
 * The accessibility claims are asserted on the real DOM, because they are the
 * part a restyle quietly breaks: the head is a button with `aria-expanded`, its
 * accessible name carries the state **and** the summary in words (so a failure is
 * announced, not only coloured), and the summary the user reads is the same one a
 * screen reader hears — one `groupSummary` call, not two implementations.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ActivityGroupRow, SubagentActivityRow } from "../../apps/web/src/components/ToolActivity.js";
import { TranscriptList } from "../../apps/web/src/components/MessageRow.js";
import { groupActivity, pairToolArguments, type ActivityGroup, type ToolActivityRow } from "../../apps/web/src/tool-activity.js";

const VITEST_FAILING = [" Test Files  1 failed (1)", "      Tests  3 failed | 15 passed (18)"].join("\n");

function toolRow(over: Partial<ToolActivityRow> & { id: string }): ToolActivityRow {
  return { role: "tool", text: "", toolName: "read", ...over };
}

/** The group the real pipeline builds for these rows, so the test cannot construct
 * a shape `groupActivity` would never produce. */
function groupOf(rows: readonly ToolActivityRow[]): { group: ActivityGroup; paired: Map<string, Record<string, unknown>> } {
  const entries = groupActivity(rows);
  const found = entries.find((entry) => entry.kind === "group");
  if (found === undefined || found.kind !== "group") throw new Error("no group in these rows");
  return { group: found.group, paired: pairToolArguments(rows) };
}

const headOf = (container: HTMLElement): HTMLElement => container.querySelector(".activity-group-head") as HTMLElement;

afterEach(cleanup);

describe("the collapsed head", () => {
  it("is a button with aria-expanded and a state + summary accessible name", () => {
    const { group, paired } = groupOf([
      toolRow({ id: "t1", toolName: "bash", toolCallId: "c1" }),
      toolRow({ id: "t2", toolName: "bash", toolCallId: "c2" }),
    ]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    const head = headOf(view.container);
    expect(head.tagName).toBe("BUTTON");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.getAttribute("aria-label")).toBe("Completed: Run 2 commands");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });

  it("announces a failure in words, not only in the glyph's colour", () => {
    const { group, paired } = groupOf([toolRow({ id: "t1", toolName: "bash", isError: true, text: "boom" })]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    const head = headOf(view.container);
    expect(head.getAttribute("aria-label")).toBe("Failed: Run 1 command");
    expect(head.textContent).toContain("✕");
    expect(head.textContent).toContain("Run 1 command");
    // The glyph is decoration; the name carries the meaning.
    expect(view.container.querySelector(".activity-group-state")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("marks a running group running and keeps it out of the completed tone", () => {
    const { group, paired } = groupOf([toolRow({ id: "t1", toolName: "bash", isRunning: true })]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    expect(view.container.querySelector(".activity-group")?.className).toContain("activity-group--running");
    expect(headOf(view.container).getAttribute("aria-label")).toBe("Running: Run 1 command");
  });

  it("spells the runner's numbers as a secondary metric, and the state as failed", () => {
    const { group, paired } = groupOf([toolRow({
      id: "c1",
      toolName: "bash",
      text: VITEST_FAILING,
      toolResult: { content: [{ type: "text", text: VITEST_FAILING }], details: {} },
    })]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    expect(view.container.querySelector(".activity-group-metric")?.textContent).toBe("3 failed | 15 passed");
    expect(headOf(view.container).getAttribute("aria-label")).toBe("Failed: Run 1 command, 3 failed | 15 passed");
  });

  it("prints no metric for a command whose output proves no test run", () => {
    const { group, paired } = groupOf([toolRow({ id: "c1", toolName: "bash", text: "exit 0", toolResult: { content: [{ type: "text", text: "exit 0" }], details: {} } })]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    expect(view.container.querySelector(".activity-group-metric")).toBeNull();
    expect(headOf(view.container).getAttribute("aria-label")).toBe("Completed: Run 1 command");
  });

  it("keeps the verified diff counts on an edit group's head", () => {
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n";
    const { group, paired } = groupOf([toolRow({ id: "e1", toolName: "edit", toolResult: { content: [], details: { perFileResults: [{ path: "src/a.ts", op: "edit", diff }] } } })]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    const counts = view.container.querySelector(".activity-group-counts")?.textContent?.replace(/\s+/g, "");
    expect(counts).toBe("+2−1");
  });
});

describe("the expanded body", () => {
  it("is exactly the member operations, in order, with their errors", () => {
    const { group, paired } = groupOf([
      toolRow({ id: "t1", toolName: "bash", text: "FIRST_OUTPUT" }),
      toolRow({ id: "t2", toolName: "bash", text: "SECOND_OUTPUT", isError: true }),
    ]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    // Collapsed: no member is mounted at all.
    expect(view.container.querySelectorAll(".tool-row")).toHaveLength(0);
    fireEvent.click(headOf(view.container));
    const heads = [...view.container.querySelectorAll<HTMLElement>(".tool-row-head")];
    expect(heads).toHaveLength(2);
    expect(heads[0]!.textContent).toContain("bash");
    // Each member still discloses its own body, and the record is unchanged.
    fireEvent.click(heads[1]!);
    expect(view.container.querySelector(".tool-raw-output")?.textContent).toContain("SECOND_OUTPUT");
    // A failed member reads as failed, not as a clean success.
    expect(view.container.querySelectorAll(".tool-row--error")).toHaveLength(1);
  });

  it("forwards onOpenFile to a member edit row", () => {
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n";
    const onOpenFile = vi.fn();
    const { group, paired } = groupOf([toolRow({ id: "e1", toolName: "edit", toolResult: { content: [], details: { perFileResults: [{ path: "src/a.ts", op: "edit", diff }] } } })]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} onOpenFile={onOpenFile} />);
    fireEvent.click(headOf(view.container));
    fireEvent.click(view.container.querySelector(".tool-row-head") as HTMLElement);
    fireEvent.click(view.container.querySelector(".tv-file-change-head") as HTMLElement);
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("shows a failing member's own text without a tap", () => {
    const { group, paired } = groupOf([toolRow({ id: "t1", toolName: "bash", isError: true, text: "ERR_SENTINEL" })]);
    const view = render(<ActivityGroupRow group={group} pairedArgs={paired} />);
    expect(view.container.querySelector(".tool-output-preview")?.textContent).toContain("ERR_SENTINEL");
  });
});

describe("the real transcript list", () => {
  it("renders one card for a run the echoes used to split, and no row is lost", () => {
    const rows = [
      { id: "u1", role: "user" as const, text: "Please check the build." },
      {
        id: "a1", role: "assistant" as const, text: "",
        blocks: [{ type: "toolCall" as const, name: "bash", arguments: { command: "pnpm typecheck" }, id: "c1" }],
      },
      toolRow({ id: "t1", toolName: "bash", toolCallId: "c1", text: "exit 0" }),
      {
        id: "a2", role: "assistant" as const, text: "",
        blocks: [{ type: "toolCall" as const, name: "bash", arguments: { command: "pnpm test" }, id: "c2" }],
      },
      toolRow({ id: "t2", toolName: "bash", toolCallId: "c2", text: "exit 0" }),
    ];
    const view = render(<TranscriptList rows={rows as never} />);
    // One card, not two — the complaint was the opposite: one card per call.
    expect(view.container.querySelectorAll(".activity-group")).toHaveLength(1);
    expect(view.container.textContent).toContain("Run 2 commands");
    // The request blocks are still suppressed (their result rows carry them), and
    // the user's own row is untouched.
    expect(view.container.textContent).not.toContain("[Tool call:");
    expect(view.container.textContent).toContain("Please check the build.");
    // Every operation is reachable after one tap: exactly the two tool rows.
    fireEvent.click(view.container.querySelector(".activity-group-head") as HTMLElement);
    expect(view.container.querySelectorAll(".tool-row")).toHaveLength(2);
  });

  it("keeps a request whose result is not on screen", () => {
    const rows = [
      toolRow({ id: "t1", toolName: "bash", toolCallId: "c1", text: "exit 0" }),
      {
        id: "a2", role: "assistant" as const, text: "",
        blocks: [{ type: "toolCall" as const, name: "bash", arguments: { command: "orphan" }, id: "c-orphan" }],
      },
      toolRow({ id: "t2", toolName: "bash", toolCallId: "c2", text: "exit 0" }),
    ];
    const view = render(<TranscriptList rows={rows as never} />);
    // Two cards, because the middle row really draws: dropping it would delete the
    // only record of that call.
    expect(view.container.querySelectorAll(".activity-group")).toHaveLength(2);
    expect(view.container.textContent).toContain("[Tool call: bash");
    expect(view.container.textContent).toContain("orphan");
  });
});

describe("the subagent roll-up", () => {
  it("renders nothing when no subagent is running", () => {
    const view = render(<SubagentActivityRow running={0} />);
    expect(view.container.textContent).toBe("");
  });

  it("states the count and offers the Agents panel when a handler exists", () => {
    const onOpenAgents = vi.fn();
    const view = render(<SubagentActivityRow running={2} onOpenAgents={onOpenAgents} />);
    expect(view.container.textContent).toContain("2 subagents working");
    expect(view.container.textContent).toContain("Open Agents to view details");
    fireEvent.click(view.container.querySelector(".subagent-row-head") as HTMLElement);
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it("states the count without a dead control when no handler is wired", () => {
    const view = render(<SubagentActivityRow running={1} />);
    expect(view.container.textContent).toContain("1 subagent working");
    expect(view.container.querySelector("button")).toBeNull();
    // No hint promising a tap that does not exist.
    expect(view.container.textContent).not.toContain("Open Agents");
  });
});
