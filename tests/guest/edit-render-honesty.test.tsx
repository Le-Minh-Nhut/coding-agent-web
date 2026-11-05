// @vitest-environment jsdom
/**
 * The `edit` renderer must not lie about two things:
 *
 * - Defect A: a move's header is `sourcePath → path`. The host's `path` is
 *   *already* the destination and `move` repeats it, so rendering
 *   `path → move` printed the same path twice and hid the source.
 * - Defect B: a truncated diff is a prefix of the real one. Printing its
 *   `+`/`−` counts as badges presents partial numbers as the file's totals.
 *
 * Assertions are on rendered text and classes, never on internals.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { editRenderer } from "../../packages/guest/src/tool-render/tools/edit";
import type { ToolResultLike } from "../../packages/guest/src/tool-render/types";

/** A real unified diff: 2 additions, 1 deletion. */
const DIFF = [
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
].join("\n");

const TRUNCATION = {
  direction: "head",
  truncatedBy: "lines",
  totalLines: 900,
  totalBytes: 0,
  outputLines: 40,
  outputBytes: 0,
};

function result(details: unknown): ToolResultLike {
  return {
    content: [{ type: "text", text: "ok" }],
    details,
  } as unknown as ToolResultLike;
}

function renderBody(details: unknown, args: Record<string, unknown> = {}): HTMLElement {
  const { container } = render(
    <editRenderer.Body name="edit" args={args} result={result(details)} />,
  );
  return container;
}

function renderSummary(details: unknown): HTMLElement {
  const { container } = render(
    <editRenderer.Summary name="edit" args={{ file_path: "/tmp/app.ts" }} result={result(details)} />,
  );
  return container;
}

/** Text of every `.tv-badge` in the tree. */
function badgeTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".tv-badge")].map((b) => b.textContent ?? "");
}

/** True when any badge reads as a `+n` / `−n` change count. */
function hasCountBadge(container: HTMLElement): boolean {
  return badgeTexts(container).some((t) => /^[+−]\d/.test(t));
}

describe("edit renderer — move direction (Defect A)", () => {
  it("renders source → destination once, not the destination twice", () => {
    const container = renderBody({
      perFileResults: [
        {
          path: "/tmp/moved.txt",
          move: "/tmp/moved.txt",
          sourcePath: "/tmp/move.txt",
          op: "update",
          diff: DIFF,
        },
        {
          path: "/tmp/other.txt",
          op: "update",
          diff: DIFF,
        },
      ],
    });

    const text = container.textContent ?? "";
    expect(text).toContain("/tmp/move.txt");
    expect(text).toContain("/tmp/moved.txt");
    expect(text).toContain("→");

    // The direction reads source → destination.
    expect(text.indexOf("/tmp/move.txt")).toBeLessThan(text.indexOf("/tmp/moved.txt"));
    // ...and the destination appears exactly once: `path → move` is not printed.
    expect(text.split("/tmp/moved.txt").length - 1).toBe(1);
  });

  it("renders the destination alone when no source is known", () => {
    const container = renderBody({
      perFileResults: [
        { path: "/tmp/solo.txt", op: "update", diff: DIFF },
        { path: "/tmp/other.txt", op: "update", diff: DIFF },
      ],
    });

    const text = container.textContent ?? "";
    expect(text.split("/tmp/solo.txt").length - 1).toBe(1);
    expect(text).not.toContain("→");
  });
});

describe("edit renderer — truncated statistics (Defect B)", () => {
  it("drops the per-file counts and says they are partial", () => {
    const container = renderBody({
      perFileResults: [
        { path: "/tmp/big.txt", op: "update", diff: DIFF, meta: { truncation: TRUNCATION } },
      ],
    });

    expect(hasCountBadge(container)).toBe(false);
    const text = container.textContent ?? "";
    expect(text).toMatch(/partial/i);
    expect(text).toMatch(/truncat/i);
    const muted = [...container.querySelectorAll(".tv-muted")].map((n) => n.textContent ?? "");
    expect(muted.join(" ")).toMatch(/partial/i);
    // The diff itself still renders.
    expect(container.querySelector(".tv-diff")).not.toBeNull();
  });

  it("treats a flat `truncated: true` entry the same way", () => {
    const container = renderBody({
      perFileResults: [{ path: "/tmp/big.txt", op: "update", diff: DIFF, truncated: true }],
    });

    expect(hasCountBadge(container)).toBe(false);
    expect(container.textContent).toMatch(/partial/i);
  });

  it("drops the summary counts and says they are partial", () => {
    const container = renderSummary({ diff: DIFF, meta: { truncation: TRUNCATION } });

    expect(hasCountBadge(container)).toBe(false);
    expect(container.textContent).toMatch(/partial/i);
  });

  it("still shows +/− badges for an untruncated summary diff", () => {
    const container = renderSummary({ diff: DIFF });

    expect(badgeTexts(container)).toContain("+2");
    expect(badgeTexts(container)).toContain("−1");
    expect(container.textContent).not.toMatch(/partial/i);
  });

  it("shows no partial note for an untruncated per-file entry", () => {
    const container = renderBody({
      perFileResults: [
        { path: "/tmp/small.txt", op: "update", diff: DIFF },
        { path: "/tmp/other.txt", op: "update", diff: DIFF },
      ],
    });

    expect(container.textContent).not.toMatch(/partial/i);
    expect(container.querySelector(".tv-diff")).not.toBeNull();
  });
});
