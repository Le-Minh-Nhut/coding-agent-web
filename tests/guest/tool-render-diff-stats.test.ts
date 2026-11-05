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
});
