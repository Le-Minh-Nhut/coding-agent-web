// @vitest-environment jsdom
/**
 * Tool-activity fidelity: what the change list may and may not claim.
 *
 * Every case here is one an operator would act on, and each one was a lie before
 * this file existed. The shapes are the ones OMP 18.15.0 actually writes — cited
 * from the upstream checkout rather than invented:
 *
 *  - a satisfied move reports `path` = destination, `move` = destination and
 *    `sourcePath` = the pre-move path (`packages/coding-agent/src/edit/index.ts`
 *    `toPerFileResult`, and `packages/tui/src/tools/edit.ts:98` "The header
 *    renders `sourcePath → path`"). Rendering `path → move` prints one path
 *    twice and never names the source;
 *  - a failed file sets `perFileResults[i].isError` with `errorText` and its own
 *    diff is not an applied change (`packages/tui/src/tools/edit.ts:1281-1316`);
 *  - a truncated output is reported structurally as `meta.truncation`, never as
 *    a `truncated` boolean (`packages/tui/src/tools/output-meta.ts:85`).
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ActivityGroupRow, ToolRow } from "../../apps/web/src/components/ToolActivity.js";
import {
  categoryLabel,
  fileChangesOf,
  summarizeFileChanges,
  type ActivityGroup,
  type ToolActivityRow,
} from "../../apps/web/src/tool-activity.js";

const pairedArgs = new Map<string, Record<string, unknown>>();

function row(over: Partial<ToolActivityRow> & { id: string }): ToolActivityRow {
  return { role: "tool", text: "", toolName: "edit", ...over };
}

const ALPHA_DIFF = [
  "--- a/src/alpha.ts",
  "+++ b/src/alpha.ts",
  "@@ -1,2 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const alphaSentinel = 1;",
  "+const c = 4;",
].join("\n");

const BETA_DIFF = [
  "--- a/src/beta.ts",
  "+++ b/src/beta.ts",
  "@@ -1 +1,2 @@",
  " const a = 1;",
  "+const betaSentinel = 1;",
].join("\n");

/** Truncation exactly as OMP reports it: structured meta, not a boolean flag. */
const TRUNCATION_META = {
  direction: "head" as const,
  truncatedBy: "lines" as const,
  totalLines: 900,
  totalBytes: 0,
  outputLines: 40,
  outputBytes: 0,
};

function mountRow(over: Partial<ToolActivityRow> & { id: string }, onOpenFile?: (path: string) => void) {
  const view = render(<ToolRow row={row(over)} pairedArgs={pairedArgs} onOpenFile={onOpenFile} />);
  fireEvent.click(view.container.querySelector(".tool-row-head") as HTMLElement);
  return view;
}

const fileRows = (container: HTMLElement) => [...container.querySelectorAll(".tv-file-change")];
const fileHeads = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".tv-file-change-head")];
const diffs = (container: HTMLElement) => [...container.querySelectorAll(".tv-diff")];

afterEach(cleanup);

describe("R02 — one diff, drawn once", () => {
  it("keeps an edit's patch out of the conversation entirely: the file row is a tap into the viewer", () => {
    // The claim changed shape with the flattening, and strengthened: it is no
    // longer "drawn once" but "not drawn here at all". The patch belongs to the
    // dedicated viewer, so an expanded edit row must mount zero diff rows.
    const onOpenFile = vi.fn();
    const view = mountRow(
      {
        id: "r02",
        toolResult: {
          content: [{ type: "text", text: "Edited src/alpha.ts" }],
          details: { perFileResults: [{ path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF }] },
        },
        toolArgs: { file_path: "src/alpha.ts" },
      },
      onOpenFile,
    );

    const list = view.container.querySelector(".tv-file-changes") as HTMLElement;
    expect(diffs(view.container)).toHaveLength(0);
    expect(list.textContent).toContain("alpha.ts");
    fireEvent.click(fileHeads(view.container)[0]!);
    expect(onOpenFile).toHaveBeenCalledWith("src/alpha.ts");
  });

  it("still draws a non-edit tool's diff on demand, the accordion it always had", () => {
    // `write` carries a diff but has no dedicated viewer, so the per-file
    // disclosure is still how its patch is reached — and still once.
    const view = mountRow({
      id: "r02-write",
      toolName: "write",
      toolResult: {
        content: [{ type: "text", text: "Wrote src/alpha.ts" }],
        details: { perFileResults: [{ path: "src/alpha.ts", op: "add", diff: ALPHA_DIFF }] },
      },
      toolArgs: { file_path: "src/alpha.ts" },
    });

    expect(diffs(view.container)).toHaveLength(0);
    fireEvent.click(fileHeads(view.container)[0]!);
    expect(diffs(view.container)).toHaveLength(1);
    expect(diffs(view.container)[0]!.textContent).toContain("alphaSentinel");
  });
});

describe("R01 — a failed edit is never reported as applied", () => {
  it("marks the failed file of a partial multi-file edit, and keeps the successful sibling's counts", () => {
    const view = mountRow({
      id: "r01-partial",
      isError: true,
      toolResult: {
        content: [{ type: "text", text: "one file failed" }],
        isError: true,
        details: {
          perFileResults: [
            { path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF },
            { path: "src/beta.ts", op: "update", isError: true, errorText: "stale tag: re-read src/beta.ts", diff: "" },
          ],
        },
      },
    });

    const rows = fileRows(view.container);
    expect(rows).toHaveLength(2);
    // The succeeded file keeps its verified counts.
    expect(rows[0]!.querySelector(".tv-count-add")?.textContent).toBe("+2");
    // The failed file is not an applied change: no +/− at all, and it says so.
    expect(rows[1]!.querySelector(".tv-count-add")).toBeNull();
    expect(rows[1]!.querySelector(".tv-count-del")).toBeNull();
    expect(rows[1]!.textContent).toContain("not applied");
    // Its own error is on the row's alert, labelled by the path it belongs to —
    // the flattened row has no second disclosure to hide it behind.
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(
      "src/beta.ts: stale tag: re-read src/beta.ts",
    );
    expect(summarizeFileChanges([row({
      id: "r01-partial",
      isError: true,
      toolResult: {
        content: [],
        details: {
          perFileResults: [
            { path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF },
            { path: "src/beta.ts", op: "update", isError: true, errorText: "stale tag: re-read src/beta.ts", diff: "" },
          ],
        },
      },
    })])?.note).toContain("1 failed");
  });

  it("does not count a failed file as a change operation", () => {
    // A failed file changed nothing, so it is a failure, never an operation: a
    // summary that counted it would inflate the work the agent actually did.
    const summary = summarizeFileChanges([row({
      id: "r01-op-count",
      toolResult: {
        content: [],
        details: {
          perFileResults: [
            { path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF },
            { path: "src/beta.ts", op: "update", isError: true, errorText: "failed", diff: "" },
          ],
        },
      },
    })]);
    expect(summary?.uniqueFiles).toBe(1);
    expect(summary?.failedFiles).toBe(1);
    expect(summary?.note).toBe("Changed 1 file · 1 failed");
  });

  it("claims no change at all for a call that failed outright", () => {
    const view = mountRow({
      id: "r01-whole",
      isError: true,
      text: "EACCES: permission denied, open 'src/alpha.ts'",
      toolResult: {
        content: [{ type: "text", text: "EACCES: permission denied, open 'src/alpha.ts'" }],
        isError: true,
        details: { diff: "", errorKind: "apply" },
      },
    });

    expect(view.container.querySelector(".tv-file-changes")).toBeNull();
    expect(view.container.querySelector(".tv-count-add")).toBeNull();
    expect(view.container.querySelector(".tool-row-state")?.textContent).toBe("✕");
    expect(view.container.querySelector(".tool-row-status")?.textContent).toContain("failed");
  });

  it("does not read a bare additions/deletions assertion as change data", () => {
    const [file] = fileChangesOf(row({
      id: "r01-claimed",
      toolResult: { content: [], details: { path: "src/alpha.ts", op: "update", additions: 999, deletions: 42 } },
    }));
    expect(file?.additions).toBeNull();
    expect(file?.deletions).toBeNull();
  });
});

describe("R03 — truncated statistics are never printed as totals", () => {
  it("qualifies a file whose output the host truncated, and keeps it out of the totals", () => {
    const payload = row({
      id: "r03",
      toolResult: {
        content: [{ type: "text", text: "Edited src/huge.ts" }],
        details: {
          perFileResults: [{
            path: "src/huge.ts",
            op: "update",
            diff: "--- a/src/huge.ts\n+++ b/src/huge.ts\n@@ -1 +1,2 @@\n a\n+b\n",
            meta: { truncation: TRUNCATION_META },
          }],
        },
      },
    });
    const [file] = fileChangesOf(payload);
    expect(file?.truncated).toBe(true);

    const summary = summarizeFileChanges([payload]);
    expect(summary?.additions).toBeNull();
    expect(summary?.deletions).toBeNull();
    expect(summary?.note).toContain("counts incomplete");

    const view = mountRow({ ...payload } as Partial<ToolActivityRow> & { id: string });
    const list = view.container.querySelector(".tv-file-changes") as HTMLElement;
    expect(list.textContent).toMatch(/partial|truncat/i);
  });

  it("still counts an untruncated diff exactly", () => {
    const summary = summarizeFileChanges([row({
      id: "r03-clean",
      toolResult: {
        content: [],
        details: { perFileResults: [{ path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF }] },
      },
    })]);
    expect(summary?.additions).toBe(2);
    expect(summary?.deletions).toBe(1);
    expect(summary?.note).toBe("Changed 1 file");
  });
});

describe("R05 — rename direction", () => {
  it("never points an arrow from a path to itself", () => {
    // Upstream's `move` is the destination, so a payload whose `move` equals its
    // `path` is a modify, not a rename: it must not gain a `→ name → name` row.
    const [file] = fileChangesOf(row({
      id: "r05-self",
      toolResult: {
        content: [],
        details: { perFileResults: [{ path: "src/same.ts", move: "src/same.ts", op: "update", diff: ALPHA_DIFF }] },
      },
    }));
    expect(file?.moveFrom).toBeUndefined();
    expect(file?.status).toBe("modified");
  });

  it("renders source → destination once each, from the real move payload", () => {
    const view = mountRow({
      id: "r05",
      toolResult: {
        content: [{ type: "text", text: "moved" }],
        details: {
          perFileResults: [
            { path: "src/new.ts", move: "src/new.ts", sourcePath: "src/old.ts", op: "update", diff: ALPHA_DIFF },
            { path: "src/other.ts", op: "update", diff: BETA_DIFF },
          ],
        },
      },
    });

    const rows = fileRows(view.container);
    const renamed = rows[0]!;
    const name = renamed.querySelector(".tv-file-name")?.textContent ?? "";
    // Source leads the arrow, destination follows, each named exactly once.
    expect(name).toBe("old.ts → new.ts");
    expect(name.split("new.ts")).toHaveLength(2);
    expect(name.indexOf("old.ts")).toBeLessThan(name.indexOf("new.ts"));
    // The path is still fully recoverable — name plus its directory line — so
    // shortening the label dropped no information.
    const dir = renamed.querySelector(".tv-file-dir")?.textContent ?? "";
    expect(dir).toBe("src");
    expect(`${dir}/${"new.ts"}`).toBe("src/new.ts");
    // The sibling that did not move carries no arrow.
    const other = rows[1]!;
    expect(other.querySelector(".tv-file-name")?.textContent).toBe("other.ts");
    expect(other.textContent).not.toContain("→");
    expect(fileChangesOf(row({
      id: "r05-parse",
      toolResult: {
        content: [],
        details: { perFileResults: [{ path: "src/new.ts", move: "src/new.ts", sourcePath: "src/old.ts" }] },
      },
    }))[0]?.moveFrom).toBe("src/old.ts");
  });
});

describe("R06 — operations, file changes and unique files are not one number", () => {
  it("names operations, not a file count, when the rows only prove attempts", () => {
    expect(categoryLabel("edit", 1)).not.toContain("file");
    expect(categoryLabel("edit", 3)).not.toContain("file");
    expect(categoryLabel("read", 1)).toBe("Read 1 file");
  });

  it("counts unique files in the summary and keeps the duplicate edits visible", () => {
    const twice = [
      row({ id: "r06-a", toolResult: { content: [], details: { path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF } } }),
      row({ id: "r06-b", toolResult: { content: [], details: { path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF } } }),
    ];
    const summary = summarizeFileChanges(twice);
    expect(summary?.files).toHaveLength(2);
    expect(summary?.uniqueFiles).toBe(1);
    expect(summary?.note).toBe("Changed 1 file · 2 operations");

    const group: ActivityGroup = { category: "edit", rows: twice, state: "completed" };
    const view = render(<ActivityGroupRow group={group} pairedArgs={pairedArgs} />);
    expect(view.container.querySelector(".activity-group-note")?.textContent).toBe("Changed 1 file · 2 operations");
    expect(view.container.querySelector(".activity-group-label")?.textContent).toBe("Edit 2 operations");
  });
});

describe("R07 — per-file drill-down, and the full record behind one more tap", () => {
  it("lists every file once, with no diff in the conversation and one tap per file", () => {
    const onOpenFile = vi.fn();
    const view = mountRow({
      id: "r07",
      text: "RAW_TRANSPORT_SENTINEL",
      toolArgs: { input: "INPUT_SENTINEL\n", file_path: "src/alpha.ts" },
      toolResult: {
        content: [{ type: "text", text: "RAW_TRANSPORT_SENTINEL" }],
        details: {
          perFileResults: [
            { path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF },
            { path: "src/beta.ts", op: "update", diff: BETA_DIFF },
          ],
        },
      },
    }, onOpenFile);

    // Level one is ALL there is now: two file rows, no diff, no nested disclosure.
    expect(fileRows(view.container)).toHaveLength(2);
    expect(diffs(view.container)).toHaveLength(0);
    expect(view.container.querySelector(".tv-file-change-body")).toBeNull();
    expect(fileHeads(view.container).map((element) => element.getAttribute("aria-expanded"))).toEqual([null, null]);

    // Each file opens the viewer for its OWN path, never the other's.
    fireEvent.click(fileHeads(view.container)[0]!);
    expect(onOpenFile).toHaveBeenCalledWith("src/alpha.ts");
    fireEvent.click(fileHeads(view.container)[1]!);
    expect(onOpenFile).toHaveBeenLastCalledWith("src/beta.ts");
    // Still no diff mounted after both taps.
    expect(diffs(view.container)).toHaveLength(0);
  });

  it("keeps the diagnostics the host attached to a file, on that file's row", () => {
    const view = mountRow({
      id: "r07-diagnostics",
      toolResult: {
        content: [{ type: "text", text: "with diagnostics" }],
        details: {
          perFileResults: [{
            path: "src/alpha.ts",
            op: "update",
            diff: ALPHA_DIFF,
            diagnostics: { summary: "2 errors", messages: ["src/alpha.ts:1:1 [error] DIAGNOSTIC_SENTINEL"], errored: true },
          }],
        },
      },
    });
    // No tap needed: flattening the list must not bury the LSP verdict, which is
    // the one part of an edit result a diff cannot show.
    expect(view.container.textContent).toContain("DIAGNOSTIC_SENTINEL");
    expect(view.container.textContent).toContain("2 errors");
    expect(fileRows(view.container)[0]!.querySelector(".tv-diag-note--err")).not.toBeNull();
  });

  it("still reaches the whole raw record — transport text and wire arguments", () => {
    const view = mountRow({
      id: "r07-raw",
      text: "RAW_TRANSPORT_SENTINEL",
      toolArgs: { input: "INPUT_SENTINEL\n", file_path: "src/alpha.ts" },
      toolResult: {
        content: [{ type: "text", text: "RAW_TRANSPORT_SENTINEL" }],
        details: { perFileResults: [{ path: "src/alpha.ts", op: "update", diff: ALPHA_DIFF }] },
      },
    });

    // Closed: nothing of the record is mounted.
    expect(view.container.querySelector(".tool-raw-output")).toBeNull();
    const details = view.container.querySelector("details.tool-raw-details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.querySelector("summary")?.textContent).toBe("View technical details");
    details.open = true;
    fireEvent(details, new Event("toggle"));
    const raw = [...view.container.querySelectorAll(".tool-raw-output")];
    expect(raw.map((element) => element.textContent).join("\n")).toContain("RAW_TRANSPORT_SENTINEL");
    expect(view.container.querySelector(".tool-args-json")?.textContent).toContain("INPUT_SENTINEL");
  });
});
