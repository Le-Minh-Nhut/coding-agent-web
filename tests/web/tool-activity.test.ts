// @vitest-environment jsdom
/**
 * Tool activity grouping and file-change summaries.
 *
 * The rules this file defends are the ones that would silently lie if broken:
 * counts come only from real diff data, a failing or running member changes the
 * group's state, a file changed twice is not merged into one "final diff", and
 * an unknown tool keeps an honest fallback rather than an invented summary.
 */
import { describe, expect, it } from "vitest";
import {
  argumentsFor,
  categoryLabel,
  categoryOf,
  diffStats,
  fileChangesOf,
  groupActivity,
  pairToolArguments,
  stateGlyph,
  summarizeFileChanges,
  STATUS_LETTER,
  type ToolActivityRow,
} from "../../apps/web/src/tool-activity.js";
import { resolveGuestRenderer, hasGuestRenderer } from "../../apps/web/src/guest-tools.js";

function toolRow(over: Partial<ToolActivityRow> & { id: string }): ToolActivityRow {
  return { role: "tool", text: "", toolName: "read", ...over };
}

const DIFF = [
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
].join("\n");

describe("categories", () => {
  it("maps tool names and never guesses for an unknown tool", () => {
    expect(categoryOf("read")).toBe("read");
    expect(categoryOf("grep")).toBe("search");
    expect(categoryOf("bash")).toBe("command");
    expect(categoryOf("apply_patch")).toBe("patch");
    expect(categoryOf("write")).toBe("edit");
    expect(categoryOf("totally_new_tool")).toBe("other");
    expect(categoryOf(undefined)).toBe("other");
  });

  it("labels a group by category and count", () => {
    expect(categoryLabel("read", 8)).toBe("Read 8 files");
    expect(categoryLabel("read", 1)).toBe("Read 1 file");
    expect(categoryLabel("other", 1)).toBe("Run 1 tool");
  });

  it("keeps state honest: one running member makes the group running", () => {
    expect(stateGlyph("running")).toBe("◌");
    expect(stateGlyph("failed")).toBe("✕");
    expect(stateGlyph("completed")).toBe("✓");
  });
});

describe("groupActivity", () => {
  it("groups only contiguous tool runs and passes other rows through", () => {
    const entries = groupActivity([
      { id: "u1", role: "user", text: "hi" },
      toolRow({ id: "t1", toolName: "read" }),
      toolRow({ id: "t2", toolName: "read" }),
      toolRow({ id: "t3", toolName: "bash" }),
      { id: "a1", role: "assistant", text: "done" },
      toolRow({ id: "t4", toolName: "grep" }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["row", "group", "group", "row", "group"]);
    const [first, second] = entries.filter((entry) => entry.kind === "group");
    expect(first?.kind === "group" && first.group.rows.map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(second?.kind === "group" && second.group.rows.map((r) => r.id)).toEqual(["t3"]);
  });

  it("reports a run containing a failure as failed and a run with a live row as running", () => {
    const [failed] = groupActivity([toolRow({ id: "t1" }), toolRow({ id: "t2", isError: true })]);
    expect(failed?.kind === "group" && failed.group.state).toBe("failed");
    const [running] = groupActivity([toolRow({ id: "t1", isRunning: true })]);
    expect(running?.kind === "group" && running.group.state).toBe("running");
  });
});

describe("arguments", () => {
  it("pairs a result row with the args of the call that produced it", () => {
    const messages = [
      { id: "a1", role: "assistant" as const, text: "", blocks: [
        { type: "toolCall" as const, name: "read", arguments: { path: "src/auth.ts" }, id: "call-1" },
      ] },
      toolRow({ id: "t1", toolCallId: "call-1" }),
    ];
    const paired = pairToolArguments(messages);
    expect(argumentsFor(messages[1]!, paired)).toEqual({ path: "src/auth.ts" });
    // An unpaired row degrades to no args, never to another call's args.
    expect(argumentsFor(toolRow({ id: "t2", toolCallId: "missing" }), paired)).toEqual({});
  });
});

describe("file changes", () => {
  it("counts additions and deletions from the real diff, not the summary text", () => {
    expect(diffStats(DIFF)).toEqual({ additions: 2, deletions: 1 });
  });

  it("reads perFileResults and keeps counts that a diff backs", () => {
    const row = toolRow({ id: "e1", toolName: "edit", toolResult: {
      content: [{ type: "text", text: "edited" }],
      details: { perFileResults: [
        { path: "src/auth.ts", diff: DIFF, op: "edit" },
        { path: "src/new.ts", diff: "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+x\n", op: "create" },
      ] },
    } });
    const files = fileChangesOf(row);
    expect(files.map((file) => file.path)).toEqual(["src/auth.ts", "src/new.ts"]);
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.deletions).toBe(1);
    expect(files[1]!.status).toBe("added");
    const summary = summarizeFileChanges([row]);
    expect(summary?.additions).toBe(3);
    expect(summary?.deletions).toBe(1);
    expect(summary?.note).toBe("Changed 2 files");
  });

  it("ignores declared additions/deletions that no diff backs", () => {
    // P2-6: a payload may assert `details.additions: 999` with no diff. Those
    // numbers are not verified change data, so they must not become a badge.
    const row = toolRow({ id: "d1", toolName: "edit", toolResult: { content: [], details: {
      path: "src/auth.ts", op: "edit", additions: 999, deletions: 42,
    } } });
    const [file] = fileChangesOf(row);
    expect(file!.diff).toBeNull();
    expect(file!.additions).toBeNull();
    expect(file!.deletions).toBeNull();
    const summary = summarizeFileChanges([row]);
    expect(summary!.additions).toBeNull();
    expect(summary!.deletions).toBeNull();
    expect(summary!.note).toContain("counts incomplete");
  });

  it("never invents counts when the transport carried no diff", () => {
    const row = toolRow({ id: "e2", toolName: "edit", toolResult: {
      content: [{ type: "text", text: "Applied 3 edits" }],
      details: { path: "src/auth.ts", op: "edit" },
    } });
    const files = fileChangesOf(row);
    expect(files).toHaveLength(1);
    expect(files[0]!.diff).toBeNull();
    expect(files[0]!.additions).toBeNull();
    expect(files[0]!.deletions).toBeNull();
    // A summary with unverifiable counts says so instead of printing totals.
    expect(summarizeFileChanges([row])?.additions).toBeNull();
    expect(summarizeFileChanges([row])?.note).toContain("counts incomplete");
  });

  it("does not merge the same file changed twice into one final diff", () => {
    const first = toolRow({ id: "e3", toolName: "edit", toolResult: {
      content: [], details: { path: "src/auth.ts", diff: DIFF, op: "edit" },
    } });
    const second = toolRow({ id: "e4", toolName: "edit", toolResult: {
      content: [], details: { path: "src/auth.ts", diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1,2 @@\n a\n+b\n", op: "edit" },
    } });
    const summary = summarizeFileChanges([first, second]);
    expect(summary?.files).toHaveLength(2);
    expect(summary?.files.map((file) => file.path)).toEqual(["src/auth.ts", "src/auth.ts"]);
  });

  it("returns null for a row with no structured result at all", () => {
    expect(fileChangesOf(toolRow({ id: "e5", text: "raw text only" }))).toEqual([]);
    expect(summarizeFileChanges([toolRow({ id: "e6", text: "raw" })])).toBeNull();
  });

  // ---- GATE UI-04 cases that are decided by this module, not by the harness ----

  it("marks a rename and keeps both names", () => {
    const row = toolRow({ id: "u1", toolName: "bash", toolResult: { content: [], details: { perFileResults: [
      { path: "src/new.ts", move: "src/old.ts", diff: null },
    ] } } });
    const [file] = fileChangesOf(row);
    expect(file!.status).toBe("renamed");
    expect(file!.moveFrom).toBe("src/old.ts");
    expect(STATUS_LETTER[file!.status]).toBe("R");
  });

  it("marks a delete and shows zero additions from its real diff", () => {
    const row = toolRow({ id: "u2", toolName: "edit", toolResult: { content: [], details: {
      path: "src/gone.ts", op: "delete",
      diff: "--- a/src/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n",
    } } });
    const [file] = fileChangesOf(row);
    expect(file!.status).toBe("deleted");
    expect(file!.additions).toBe(0);
    expect(file!.deletions).toBe(2);
  });

  it("keeps a binary file with unknown counts instead of inventing +0 −0", () => {
    const row = toolRow({ id: "u3", toolName: "edit", toolResult: { content: [], details: {
      perFileResults: [{ path: "assets/logo.png", op: "binary", diff: null }],
    } } });
    const [file] = fileChangesOf(row);
    expect(file!.status).toBe("binary");
    // A binary has no line counts. 0/0 would read as "no change".
    expect(file!.additions).toBeNull();
    expect(file!.deletions).toBeNull();
    expect(summarizeFileChanges([row])?.note).toContain("counts incomplete");
  });

  it("treats an empty diff as zero lines changed, not as missing data", () => {
    // `diff: ""` is real, verified change data that happens to contain no hunks.
    const row = toolRow({ id: "u4", toolName: "edit", toolResult: { content: [], details: {
      path: "src/untouched.ts", op: "edit", diff: "",
    } } });
    const [file] = fileChangesOf(row);
    expect(file!.diff).toBe("");
    expect(file!.additions).toBe(0);
    expect(file!.deletions).toBe(0);
    expect(summarizeFileChanges([row])?.additions).toBe(0);
  });

  it("carries a truncated flag through without counting the missing hunks", () => {
    const row = toolRow({ id: "u5", toolName: "edit", toolResult: { content: [], details: {
      path: "src/big.ts", op: "edit", truncated: true,
      diff: "--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1 +1 @@\n-a\n+b\n",
    } } });
    const [file] = fileChangesOf(row);
    expect(file!.truncated).toBe(true);
    expect(file!.additions).toBe(1);
  });

  it("scales to many files and a large diff without losing a file", () => {
    const perFileResults = Array.from({ length: 100 }, (_, index) => ({
      path: `src/file-${index}.ts`, op: "edit",
      diff: `--- a/src/file-${index}.ts\n+++ b/src/file-${index}.ts\n@@ -1 +1,2 @@\n a\n+b\n`,
    }));
    const summary = summarizeFileChanges([toolRow({ id: "u6", toolName: "edit", toolResult: { content: [], details: { perFileResults } } })]);
    expect(summary!.files).toHaveLength(100);
    expect(summary!.additions).toBe(100);
    expect(summary!.deletions).toBe(0);
    expect(summary!.note).toBe("Changed 100 files");
  });

  it("counts a 5000-line diff exactly, matching its hunk headers", () => {
    const body = Array.from({ length: 5000 }, (_, index) => `+line ${index}`);
    const summary = summarizeFileChanges([toolRow({ id: "u7", toolName: "edit", toolResult: { content: [], details: {
      path: "src/huge.ts", op: "edit",
      diff: ["--- a/src/huge.ts", "+++ b/src/huge.ts", "@@ -0,0 +1,5000 @@", ...body].join("\n"),
    } } })]);
    expect(summary!.additions).toBe(5000);
    expect(summary!.deletions).toBe(0);
  });

  it("reports an invalid path verbatim rather than dropping the row", () => {
    // The server authorizes and rejects paths; the client must show what it got
    // instead of silently hiding a rejected write.
    const row = toolRow({ id: "u8", toolName: "edit", toolResult: { content: [], details: {
      path: "../../etc/passwd", op: "edit", diff: null,
    } } });
    const [file] = fileChangesOf(row);
    expect(file!.path).toBe("../../etc/passwd");
    expect(file!.additions).toBeNull();
  });

  it("renders a failed operation as failed, with no file changes claimed", () => {
    const row = toolRow({ id: "u9", toolName: "edit", isError: true, text: "EACCES: permission denied", toolResult: {
      content: [{ type: "text", text: "EACCES: permission denied" }], isError: true,
    } });
    expect(fileChangesOf(row)).toEqual([]);
    expect(summarizeFileChanges([row])).toBeNull();
  });

  it("marks an unknown file status as unknown, never as modified", () => {
    const row = toolRow({ id: "u10", toolName: "edit", toolResult: { content: [], details: {
      perFileResults: [{ path: "src/mystery.ts", op: "frobnicate", diff: null }],
    } } });
    const [file] = fileChangesOf(row);
    expect(file!.status).toBe("unknown");
    expect(STATUS_LETTER[file!.status]).toBe("?");
  });
});

describe("guest renderer seam", () => {
  it("resolves the diff-bearing renderers and falls back for unknown tools", () => {
    expect(hasGuestRenderer("edit")).toBe(true);
    expect(hasGuestRenderer("apply_patch")).toBe(true);
    expect(hasGuestRenderer("write")).toBe(true);
    expect(hasGuestRenderer("ast_edit")).toBe(true);
    // Aliases the guest registry carries must resolve too.
    expect(resolveGuestRenderer("search")).toBe(resolveGuestRenderer("grep"));
    expect(resolveGuestRenderer("shell")).toBe(resolveGuestRenderer("bash"));
    // An unknown tool is a real renderer (the generic fallback), never undefined.
    const unknown = resolveGuestRenderer("brand_new_tool");
    expect(typeof unknown.Summary).toBe("function");
    expect(hasGuestRenderer("brand_new_tool")).toBe(false);
  });
});
