// @vitest-environment jsdom
/**
 * The flattened tool-activity hierarchy: an edit is ONE level of file rows.
 *
 * Before this, an edit expanded into Group → Tool → Changes → File → Diff → Raw
 * details — six levels before a change was readable, with a `DiffBlock` mounted
 * inside the conversation. Now the `edit` body is a flat list, each row opens the
 * dedicated viewer through `onOpenFile`, and every other tool keeps its guest
 * body untouched.
 *
 * The honesty rules are pinned here too, because flattening a list is exactly
 * where a count or a failure message gets dropped: a failed edit shows the host's
 * real `details.error`, and a file with unknown counts prints nothing rather than
 * `+0 −0`.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ToolRow } from "../../apps/web/src/components/ToolActivity.js";
import { fileChangesOf, toolResultError, type ToolActivityRow } from "../../apps/web/src/tool-activity.js";

const pairedArgs = new Map<string, Record<string, unknown>>();

const ALPHA_DIFF = [
  "--- a/src/auth/advisor.ts",
  "+++ b/src/auth/advisor.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const advisorSentinel = 1;",
  "+const c = 4;",
].join("\n");

function row(over: Partial<ToolActivityRow> & { id: string }): ToolActivityRow {
  return { role: "tool", text: "", toolName: "edit", ...over };
}

function toolResult(details: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: "done" }], details, ...over };
}

/** Render a row and open its body, the way a thumb would. */
function mountOpen(over: Partial<ToolActivityRow> & { id: string }, onOpenFile?: (path: string) => void) {
  const view = render(<ToolRow row={row(over)} pairedArgs={pairedArgs} onOpenFile={onOpenFile} />);
  fireEvent.click(view.container.querySelector(".tool-row-head") as HTMLElement);
  return view;
}

const fileHeads = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>(".tv-file-change-head")];

afterEach(cleanup);

describe("edit expands to exactly one level of file rows", () => {
  it("renders one flat button per file, with the name and the stripped directory", () => {
    const view = mountOpen({
      id: "flat-1",
      toolResult: toolResult({
        perFileResults: [
          { path: "apps/web/src/auth/advisor.ts", op: "update", diff: ALPHA_DIFF },
          { path: "apps/web/src/auth/token.ts", op: "update", diff: ALPHA_DIFF },
        ],
      }),
    });

    const heads = fileHeads(view.container);
    expect(heads).toHaveLength(2);
    // One level: nothing inside a file row is itself a row or a disclosure.
    expect(view.container.querySelectorAll(".tv-file-change-body")).toHaveLength(0);
    expect(view.container.querySelectorAll("details")).toHaveLength(1);
    expect(view.container.querySelector(".tv-file-name")?.textContent).toBe("advisor.ts");
    // The directory line is the path with the filename stripped.
    expect(view.container.querySelector(".tv-file-dir")?.textContent).toBe("apps/web/src/auth");
    // The absolute path is not printed twice anywhere.
    const text = view.container.textContent ?? "";
    expect(text.split("apps/web/src/auth/advisor.ts")).toHaveLength(1);
    expect(text).toContain("advisor.ts");
    expect(text).toContain("apps/web/src/auth");
  });

  it("mounts no diff inside the conversation for an edit", () => {
    const view = mountOpen({
      id: "flat-2",
      toolResult: toolResult({ perFileResults: [{ path: "src/a.ts", op: "update", diff: ALPHA_DIFF }] }),
    });
    expect(view.container.querySelectorAll(".tv-diff")).toHaveLength(0);
    expect(view.container.querySelectorAll(".tv-diff-row")).toHaveLength(0);
    // The patch text is not smuggled in anywhere else either.
    expect(view.container.textContent).not.toContain("advisorSentinel");
  });

  it("is a >=44px control that hands the full path to onOpenFile", () => {
    const onOpenFile = vi.fn();
    const view = mountOpen(
      { id: "flat-3", toolResult: toolResult({ perFileResults: [{ path: "apps/web/src/deep/thing.ts", op: "update", diff: ALPHA_DIFF }] }) },
      onOpenFile,
    );

    const head = fileHeads(view.container)[0]!;
    expect(head.tagName).toBe("BUTTON");
    // The class carries the 44px minimum in styles.css; assert the class is wired
    // rather than read a stylesheet jsdom does not apply.
    expect(head.className).toContain("tv-file-change-head");
    fireEvent.click(head);
    expect(onOpenFile).toHaveBeenCalledWith("apps/web/src/deep/thing.ts");
  });

  it("keeps the raw details reachable behind one disclosure, closed by default", () => {
    const view = mountOpen({
      id: "flat-4",
      text: "RAW_TRANSPORT_SENTINEL",
      toolResult: toolResult({ perFileResults: [{ path: "src/a.ts", op: "update", diff: ALPHA_DIFF }] }),
    });

    const details = [...view.container.querySelectorAll("details")];
    expect(details).toHaveLength(1);
    expect(details[0]!.hasAttribute("open")).toBe(false);
    expect(details[0]!.querySelector("summary")?.textContent).toContain("View technical details");
    // Not mounted while closed: an always-mounted record would put every edit's
    // full transport text in the DOM.
    expect(view.container.querySelector(".tool-raw-output")).toBeNull();
    fireEvent.click(details[0]!.querySelector("summary") as HTMLElement);
    details[0]!.open = true;
    fireEvent(details[0]!, new Event("toggle"));
    expect(view.container.querySelector(".tool-raw-output")?.textContent).toBe("RAW_TRANSPORT_SENTINEL");
  });
});

describe("counts are honest", () => {
  it("keeps the verified +N −M on the file row", () => {
    const view = mountOpen({
      id: "counts-1",
      toolResult: toolResult({ perFileResults: [{ path: "src/a.ts", op: "update", diff: ALPHA_DIFF }] }),
    });
    const head = fileHeads(view.container)[0]!;
    expect(head.querySelector(".tv-count-add")?.textContent).toBe("+2");
    expect(head.querySelector(".tv-count-del")?.textContent).toBe("−1");
  });

  it("prints nothing rather than +0 −0 when the counts are unknown", () => {
    // A bare `additions`/`deletions` assertion with no diff behind it is not
    // verified change data, so the row must say so instead of inventing zeroes.
    const view = mountOpen({
      id: "counts-2",
      toolResult: toolResult({ path: "src/a.ts", op: "update", additions: 999, deletions: 42 }),
    });
    const head = fileHeads(view.container)[0]!;
    expect(head.querySelector(".tv-count-add")).toBeNull();
    expect(head.querySelector(".tv-count-del")).toBeNull();
    expect(head.textContent).toContain("counts unavailable");
    expect(head.textContent).not.toContain("+0");
  });

  it("sums the edit summary from real diffs, and omits counts when any file lacks them", () => {
    const view = mountOpen({
      id: "counts-3",
      toolResult: toolResult({
        perFileResults: [
          { path: "src/a.ts", op: "update", diff: ALPHA_DIFF },
          { path: "src/b.ts", op: "update", diff: ALPHA_DIFF },
        ],
      }),
    });
    expect(view.container.querySelector(".tool-row-note")?.textContent).toBe("Edited 2 files");
    const sum = view.container.querySelector(".tool-row-sum")?.textContent ?? "";
    expect(sum).toContain("+4");
    expect(sum).toContain("−2");

    cleanup();
    const partial = mountOpen({
      id: "counts-4",
      toolResult: toolResult({ perFileResults: [{ path: "src/a.ts", op: "update", diff: ALPHA_DIFF }, { path: "src/b.ts", op: "update" }] }),
    });
    // One file has no diff: no total may be printed at all.
    const partialSum = partial.container.querySelector(".tool-row-sum")?.textContent ?? "";
    expect(partialSum).not.toContain("+4");
    expect(partialSum).not.toContain("−2");
  });
});

describe("a failed edit shows its real error", () => {
  it("renders the host's details.error in an alert, and marks the file failed", () => {
    const view = mountOpen({
      id: "fail-1",
      isError: true,
      text: "edit failed",
      toolResult: toolResult({ diff: "", errorKind: "apply", error: "EACCES: permission denied, open 'src/a.ts'" }, { isError: true }),
    });

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("EACCES: permission denied, open 'src/a.ts'");
    // An error kind is a classification, never printed as a reason.
    expect(view.container.textContent).not.toContain("apply");
  });

  it("shows every file's reason in a partial multi-file failure", () => {
    const view = mountOpen({
      id: "fail-multi",
      isError: true,
      toolResult: toolResult({
        perFileResults: [
          { path: "src/a.ts", op: "update", diff: ALPHA_DIFF },
          { path: "src/b.ts", op: "update", isError: true, error: "stale tag", diff: "" },
          { path: "src/c.ts", op: "update", isError: true, error: "read-only fs", diff: "" },
        ],
      }, { isError: true }),
    });

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("src/b.ts: stale tag");
    expect(alert?.textContent).toContain("src/c.ts: read-only fs");
  });

  it("reads details.error ahead of the legacy display fields", () => {
    const base = {
      id: "fail-2",
      isError: true,
      toolResult: toolResult(
        {
          perFileResults: [
            { path: "src/a.ts", op: "update", isError: true, error: "REAL_ERROR", errorText: "LEGACY_ERROR", displayErrorText: "OLDER_ERROR" },
          ],
        },
        { isError: true },
      ),
    };
    expect(fileChangesOf(row(base))[0]?.error).toBe("REAL_ERROR");
    // The flat row shows it in the row's own alert, labelled by path.
    const view = mountOpen(base);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("src/a.ts: REAL_ERROR");
  });

  it("falls back to the legacy keys so an older payload is not regressed", () => {
    const [legacy] = fileChangesOf(row({
      id: "fail-3",
      toolResult: toolResult({ perFileResults: [{ path: "src/a.ts", op: "update", isError: true, errorText: "LEGACY_ONLY" }] }),
    }));
    expect(legacy?.error).toBe("LEGACY_ONLY");
  });

  it("prints no alert at all when the host sent no message", () => {
    const bare = row({
      id: "fail-4",
      isError: true,
      toolResult: toolResult({ diff: "", errorKind: "apply" }, { isError: true }),
    });
    expect(toolResultError(bare)).toBeNull();
    const view = mountOpen(bare);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("rename direction", () => {
  it("shows old → new only when moveFrom is genuinely present", () => {
    const renamed = mountOpen({
      id: "move-1",
      toolResult: toolResult({
        perFileResults: [{ path: "src/auth/new.ts", move: "src/auth/new.ts", sourcePath: "src/auth/old.ts", op: "update", diff: ALPHA_DIFF }],
      }),
    });
    const name = renamed.container.querySelector(".tv-file-name")?.textContent ?? "";
    expect(name).toBe("old.ts → new.ts");

    cleanup();
    // `move` equal to `path` is a modify, not a rename: no arrow may appear.
    const modified = mountOpen({
      id: "move-2",
      toolResult: toolResult({ perFileResults: [{ path: "src/auth/same.ts", move: "src/auth/same.ts", op: "update", diff: ALPHA_DIFF }] }),
    });
    expect(modified.container.querySelector(".tv-file-name")?.textContent).toBe("same.ts");
    expect(modified.container.textContent).not.toContain("→");
  });
});

describe("non-edit tools keep their current bodies", () => {
  it("still mounts the guest body for bash", () => {
    const view = render(
      <ToolRow
        row={{ id: "bash-1", role: "tool", text: "OUT", toolName: "bash", toolArgs: { command: "pnpm test" }, toolResult: toolResult({ exitCode: 0 }) }}
        pairedArgs={pairedArgs}
      />,
    );
    fireEvent.click(view.container.querySelector(".tool-row-head") as HTMLElement);
    // The guest bash body, not the flat edit list.
    expect(view.container.querySelector(".tv-file-changes")).toBeNull();
    expect(view.container.querySelector(".tool-body")).not.toBeNull();
    expect(view.container.querySelectorAll(".tv-file-change")).toHaveLength(0);
  });

  it("does not promote a non-edit row's files to the flattened shape", () => {
    // `write` is a change-bearing tool but NOT edit, so the accordion (with its
    // per-file diff) is still what renders.
    const view = mountOpen({
      id: "write-1",
      toolName: "write",
      toolResult: toolResult({ perFileResults: [{ path: "src/a.ts", op: "add", diff: ALPHA_DIFF }] }),
    });
    expect(view.container.querySelector(".tv-file-change-body")).toBeNull();
    expect(view.container.querySelector(".tool-body-heading")).not.toBeNull();
    expect(view.container.querySelector(".tool-row-note")?.textContent ?? "").not.toContain("Edited");
  });
});
