import { describe, expect, it } from "vitest";
import { diffStats } from "../../packages/guest/src/tool-render/util";

/**
 * One implementation, two hosts: the guest `edit` renderer and the web activity
 * list both call this. Its rule must match a real unified diff — the `+++`/`---`
 * file headers are framing, not content — while staying identical on OMP's
 * `NN|` gutter form, which is every payload the guest actually sees.
 */
describe("diffStats", () => {
  it("counts content lines and ignores the +++/--- file headers", () => {
    const diff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
    ].join("\n");
    expect(diffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("counts OMP's gutter form the same as a plain + / - line", () => {
    // OMP prefixes every line with a `NN|` gutter, so nothing ever begins with
    // `+++`/`---`; the skip must therefore be inert here rather than silently
    // dropping real changes.
    const omp = ["+12|const added = true;", "+13|const also = true;", "-7|const removed = false;"].join("\n");
    expect(diffStats(omp)).toEqual({ additions: 2, deletions: 1 });
  });

  it("does not treat a header-only diff as a change", () => {
    expect(diffStats("--- a/x\n+++ b/x\n")).toEqual({ additions: 0, deletions: 0 });
    expect(diffStats("")).toEqual({ additions: 0, deletions: 0 });
  });

  it("counts a hunk line that itself begins with +++ or ---", () => {
    // The header/body distinction is positional: only the lines *before* the
    // first `@@` are framing. Inside a hunk, adding a line that starts with `++`
    // produces `+++…`, and removing one that starts with `--` produces `---…`.
    // Skipping by prefix alone would silently drop both from the total.
    const diff = [
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,2 +1,3 @@",
      " intro",
      "--- horizontal rule (removed)",
      "+--- horizontal rule (added)",
      " tail",
    ].join("\n");
    expect(diffStats(diff)).toEqual({ additions: 1, deletions: 1 });
  });

  it("counts a hunk that adds an empty line", () => {
    const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -1 +1,2 @@", " a", "+"].join("\n");
    expect(diffStats(diff)).toEqual({ additions: 1, deletions: 0 });
  });

  it("counts a concatenation of per-file diffs without reading the next file's headers as changes", () => {
    // OMP joins a multi-file edit's per-file diffs with "\n", so the second
    // file's `---`/`+++` pair arrives after the first file's hunk body.
    const diff = [
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1,2 @@",
      " a",
      "+added in one",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1 +1 @@",
      "-removed in two",
      "+replaced in two",
    ].join("\n");
    expect(diffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });
});
