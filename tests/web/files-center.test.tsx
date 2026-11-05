// @vitest-environment jsdom
/**
 * Files Center data layer and its two views.
 *
 * The cases are written against the honesty rules the brief named, not against
 * the implementation: sums are labelled as observed edit events, a failed edit's
 * error comes from OMP's real `details.error` key, a rename is surfaced only when
 * a move was actually present, and a total is `null` rather than partial when one
 * contributing file lacks counts.
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  changedFileCountsText,
  collectChangedFiles,
  filterChangedFiles,
  hunkHeadersOf,
  parseGutterDiff,
  patchTextOf,
  sortChangedFiles,
  summarizeChangedFiles,
  type ChangedFile,
} from "../../apps/web/src/files.js";
import type { ToolActivityRow } from "../../apps/web/src/tool-activity.js";
import { summarizeFileChanges } from "../../apps/web/src/tool-activity.js";
import { FilesCenter } from "../../apps/web/src/components/FilesCenter.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** An edit tool row carrying one real gutter-format diff. */
function editRow(id: string, path: string, diff: string, over: Record<string, unknown> = {}): ToolActivityRow {
  return {
    id,
    role: "tool",
    text: `Edited ${path}`,
    toolName: "edit",
    toolCallId: `call-${id}`,
    toolResult: { content: [], details: { path, op: "update", diff, ...over } },
  };
}

/**
 * The audit's real two-hunk case, structure taken from this machine's journals.
 *
 * Hunk 0 is `-50,14 +50,11` (delta −3) and hunk 1 sits at old line 116, so its
 * true new start is 113. The old code printed `+oldStart` = 116, which the census
 * measured wrong for 28.9% of synthesized headers.
 *
 * Every credential and host in it is replaced by a documentation placeholder:
 * the tailnet base URL by the RFC 5737 TEST-NET-2 address, and the API key by
 * zeros. The placeholders are kept the same length as the originals so the
 * gutter format stays realistic, and no assertion depends on their values.
 */
const CENSUS_DIFF = [
  " 50|",
  " 51|export default function registerNinerouter(pi: ExtensionAPI) {",
  '-52|  const legacyUrl = process.env.NINEROUTER_URL?.replace(/\\/+$/, "");',
  '-53|  const apiUrl = (process.env.NINEROUTER_API_URL ?? (legacyUrl ? `${legacyUrl}/v1` : "http://localhost:20128/v1")).replace(/\\/+$/, "");',
  "-54|  const key = process.env.NINEROUTER_KEY;",
  '+52|  const apiUrl = "http://198.51.100.255:20128/v1";',
  '+53|  const key = "sk-0000000000000000-000000-00000000";',
  " 55|",
  '-56|  if (!key) throw new Error("NINEROUTER_KEY is not set");',
  "-57|",
  ' 58|  pi.registerProvider("9router", {',
  ' 59|    name: "9Router",',
  " 60|    baseUrl: apiUrl,",
  '-61|    apiKey: "$NINEROUTER_KEY",',
  '+58|    apiKey: "sk-0000000000000000-000000-00000000",',
  ' 62|    api: "openai-completions",',
  " 63|",
  "",
  " 116|  });",
  " 117|}",
].join("\n");

/** Two short hunks separated by a gutter gap, the shape OMP sends. */
const TWO_HUNK_DIFF = [" 1|alpha", " 2|beta", "-3|gamma", "+3|gamma!", "", " 9|delta", "+10|epsilon"].join("\n");

function withoutCounts(files: ChangedFile[]): ChangedFile[] {
  return files.map((file) => ({ ...file, observedAdditions: null, observedDeletions: null }));
}

describe("parseGutterDiff", () => {
  it("reads add/del/ctx kinds and their gutter line numbers", () => {
    const [hunk] = parseGutterDiff([" 12|keep", "-13|old", "+13|new"].join("\n"));
    expect(hunk!.lines).toEqual([
      { kind: "ctx", oldLine: 12, newLine: null, text: "keep" },
      { kind: "del", oldLine: 13, newLine: null, text: "old" },
      { kind: "add", oldLine: null, newLine: 13, text: "new" },
    ]);
  });

  it("splits hunks at a gap and keeps the gap as the hunk's trailing separator", () => {
    const hunks = parseGutterDiff(TWO_HUNK_DIFF);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines.at(-1)).toMatchObject({ kind: "gap", oldLine: null, newLine: null });
    expect(hunks[1]!.lines[0]).toMatchObject({ kind: "ctx", oldLine: 9 });
  });

  it("treats the host's `…` separator as a gap", () => {
    const hunks = parseGutterDiff([" 1|a", " 2|b", "…", " 8|c", " 9|d"].join("\n"));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines.at(-1)!.kind).toBe("gap");
  });

  it("strips CRLF, so a `\\r` never becomes the line's text", () => {
    const [hunk] = parseGutterDiff(" 4|with-crlf\r\n-5|gone\r\n");
    expect(hunk!.lines.map((line) => [line.kind, line.text])).toEqual([
      ["ctx", "with-crlf"],
      ["del", "gone"],
    ]);
  });

  it("keeps tabs verbatim", () => {
    const [hunk] = parseGutterDiff("\t+1|indented\tcode");
    expect(hunk!.lines[0]).toEqual({ kind: "ctx", oldLine: null, newLine: null, text: "\t+1|indented\tcode" });
  });

  it("returns what parsed and never throws on malformed input", () => {
    const input = ["not a gutter line", "-|missing number", "+12|", " 7|ok", "\u0000"].join("\n");
    expect(() => parseGutterDiff(input)).not.toThrow();
    const [hunk] = parseGutterDiff(input);
    // Every line is represented: unparseable ones become context with no numbers.
    expect(hunk!.lines).toHaveLength(5);
    expect(hunk!.lines[0]).toEqual({ kind: "ctx", oldLine: null, newLine: null, text: "not a gutter line" });
    expect(hunk!.lines[1]).toEqual({ kind: "ctx", oldLine: null, newLine: null, text: "-|missing number" });
    expect(hunk!.lines[2]).toEqual({ kind: "add", oldLine: null, newLine: 12, text: "" });
  });

  it("drops a unified-diff file header instead of counting it as content", () => {
    const [hunk] = parseGutterDiff(["--- a/x.ts", "+++ b/x.ts", " 1|body"].join("\n"));
    expect(hunk!.lines).toEqual([{ kind: "ctx", oldLine: 1, newLine: null, text: "body" }]);
  });

  it("handles an empty string without throwing", () => {
    expect(parseGutterDiff("")).toEqual([]);
  });
});

describe("collectChangedFiles", () => {
  it("aggregates repeated edits to one path and labels the counts as observed sums", () => {
    const second = [" 1|a", "+2|C"].join("\n");
    const rows = [
      editRow("a", "src/auth.ts", [" 1|a", "-2|b", "+2|B"].join("\n")),
      editRow("b", "src/auth.ts", second),
    ];
    const files = collectChangedFiles(rows);
    expect(files).toHaveLength(1);
    // 2 events: one +1/−1, one +1/−0. The sum is an observed total, never a net diff.
    expect(files[0]).toMatchObject({ path: "src/auth.ts", edits: 2, observedAdditions: 2, observedDeletions: 1 });
    expect(files[0]!.lastDiff).toBe(second);
  });

  it("keeps one entry per distinct path in first-seen order", () => {
    const files = collectChangedFiles([
      editRow("a", "src/z.ts", " 1|z"),
      editRow("b", "src/a.ts", " 1|a"),
      editRow("c", "src/z.ts", " 1|z2"),
    ]);
    expect(files.map((file) => file.path)).toEqual(["src/z.ts", "src/a.ts"]);
    expect(files.map((file) => file.edits)).toEqual([2, 1]);
  });

  it("reads a failed edit's error text from the host's real `details.error` key", () => {
    const row: ToolActivityRow = {
      id: "fail",
      role: "tool",
      text: "edit failed",
      toolName: "edit",
      toolCallId: "call-fail",
      isError: true,
      toolArgs: { path: "src/auth.ts" },
      toolResult: { content: [], isError: true, details: { isError: true, error: "Validation failed for tool \"edit\": path must be a string" } },
    };
    const [file] = collectChangedFiles([row]);
    expect(file).toMatchObject({ path: "src/auth.ts", failed: true, status: "unknown", observedAdditions: null });
    expect(file!.errorText).toBe('Validation failed for tool "edit": path must be a string');
  });

  it("drops a failed edit that named no file at all rather than filing it under a guess", () => {
    const row: ToolActivityRow = {
      id: "fail",
      role: "tool",
      text: "edit failed",
      toolName: "edit",
      toolCallId: "call-fail",
      isError: true,
      toolResult: { content: [], isError: true, details: { isError: true, error: "Validation failed" } },
    };
    expect(collectChangedFiles([row])).toEqual([]);
  });

  it("falls back to errorKind when the host sent no message, and to the call's path", () => {
    const row: ToolActivityRow = {
      id: "nf",
      role: "tool",
      text: "no match",
      toolName: "edit",
      toolCallId: "call-nf",
      isError: true,
      toolArgs: { path: "src/missing.ts", old_string: "x", new_string: "y" },
      toolResult: { content: [], isError: true, details: { diff: "", errorKind: "file_not_found" } },
    };
    const [file] = collectChangedFiles([row]);
    expect(file).toMatchObject({ path: "src/missing.ts", failed: true });
    expect(file!.errorText).toBe("file_not_found");
  });

  it("files a failed edit under the file its call named when its details carry no path", () => {
    const rows: ToolActivityRow[] = [
      {
        id: "caller",
        role: "assistant",
        text: "",
        blocks: [{ type: "toolCall", id: "call-x", name: "edit", arguments: { path: "src/gone.ts", old_string: "a", new_string: "b" } }],
      },
      {
        id: "res",
        role: "tool",
        text: "no match",
        toolName: "edit",
        toolCallId: "call-x",
        isError: true,
        toolResult: { content: [], isError: true, details: { diff: "", errorKind: "no_match" } },
      },
    ];
    const paired = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      for (const block of row.blocks ?? []) {
        if (block.type === "toolCall" && block.id !== undefined) paired.set(block.id, block.arguments as Record<string, unknown>);
      }
    }
    const files = collectChangedFiles(rows, paired);
    expect(files.map((file) => file.path)).toEqual(["src/gone.ts"]);
  });

  it("surfaces moveFrom only when a move was present, and then reports renamed", () => {
    const moved = collectChangedFiles([editRow("m", "src/new.ts", " 1|a", { move: "src/old.ts", sourcePath: "src/old.ts" })]);
    expect(moved[0]).toMatchObject({ status: "renamed", moveFrom: "src/old.ts" });
    const plain = collectChangedFiles([editRow("p", "src/new.ts", " 1|a", { op: "update" })]);
    expect(plain[0]!.moveFrom).toBeNull();
    expect(plain[0]!.status).toBe("modified");
  });

  it("marks a truncated diff's counts unavailable rather than as a floor printed as a total", () => {
    const files = collectChangedFiles([editRow("t", "src/big.ts", " 1|a\n+2|b", { meta: { truncation: { truncated: true } } })]);
    expect(files[0]).toMatchObject({ truncated: true, observedAdditions: null, observedDeletions: null });
  });

  it("splits the short name from the directory", () => {
    const [file] = collectChangedFiles([editRow("s", "apps/web/src/a.tsx", " 1|a")]);
    expect(file).toMatchObject({ shortName: "a.tsx", directory: "apps/web/src" });
    const [bare] = collectChangedFiles([editRow("s2", "README.md", " 1|a")]);
    expect(bare).toMatchObject({ shortName: "README.md", directory: "" });
  });

  it("ignores a row with no tool result data", () => {
    const read: ToolActivityRow = { id: "r", role: "tool", text: "read", toolName: "read" };
    expect(collectChangedFiles([read])).toEqual([]);
  });
});

describe("summarizeChangedFiles", () => {
  it("counts each status and totals the applied files' observed edits", () => {
    const files = collectChangedFiles([
      editRow("a", "src/a.ts", [" 1|a", "-2|b", "+2|B"].join("\n")),
      editRow("d", "src/d.ts", "-1|gone", { op: "delete" }),
    ]);
    expect(summarizeChangedFiles(files)).toMatchObject({
      total: 2,
      modified: 1,
      deleted: 1,
      observedAdditions: 1,
      observedDeletions: 2,
      failed: 0,
    });
  });

  it("reports the totals as null when a contributing file lacks counts", () => {
    const files = withoutCounts(collectChangedFiles([editRow("a", "src/a.ts", " 1|a\n+2|b")]));
    expect(summarizeChangedFiles(files)).toMatchObject({ total: 1, observedAdditions: null, observedDeletions: null });
  });

  it("excludes failed files from the totals instead of nulling them", () => {
    const ok = collectChangedFiles([editRow("a", "src/a.ts", [" 1|a", "+2|b"].join("\n"))]);
    const failed: ChangedFile[] = [
      { ...ok[0]!, path: "src/broken.ts", failed: true, status: "unknown", observedAdditions: null, observedDeletions: null },
    ];
    const summary = summarizeChangedFiles([...ok, ...failed]);
    expect(summary).toMatchObject({ total: 2, failed: 1, observedAdditions: 1, observedDeletions: 0 });
  });

  it("reports no totals at all when every file failed", () => {
    const summary = summarizeChangedFiles([
      { path: "a", shortName: "a", directory: "", status: "unknown", edits: 1, appliedEdits: 0, observedAdditions: null, observedDeletions: null, failed: true, truncated: false, errorText: "x", lastDiff: null, moveFrom: null, rawDetails: null },
    ]);
    expect(summary).toMatchObject({ total: 1, appliedFiles: 0, failed: 1, observedAdditions: null, observedDeletions: null });
  });

  /*
   * The two screens must print the same number for the same rows.
   *
   * The Files Center header and the dashboard card were measured disagreeing: one
   * applied edit plus one failed edit read as "2 files" in the Files Center and
   * "Changed 1 file" on the card. The card counts distinct paths among non-failed
   * file changes (`summarizeFileChanges().uniqueFiles`), so the header counts
   * `appliedFiles` — a failed edit changes nothing, and is labelled "not counted".
   */
  it("agrees with the dashboard card on the changed-file count when an edit failed", () => {
    const applied = editRow("ok", "src/ok.ts", [" 1|a", "+2|b"].join("\n"));
    const failed: ToolActivityRow = {
      id: "bad",
      role: "tool",
      text: "no match",
      toolName: "edit",
      toolCallId: "call-bad",
      isError: true,
      toolArgs: { path: "src/bad.ts", old_string: "x", new_string: "y" },
      toolResult: { content: [], isError: true, details: { diff: "", errorKind: "no_match" } },
    };
    const rows = [applied, failed];

    const files = collectChangedFiles(rows);
    const summary = summarizeChangedFiles(files);
    const card = summarizeFileChanges(rows);

    expect(files).toHaveLength(2);
    expect(summary.appliedFiles).toBe(1);
    expect(card!.uniqueFiles).toBe(1);
    expect(summary.appliedFiles, "the Files Center and the dashboard card agree").toBe(card!.uniqueFiles);
  });

  it("agrees with the card when every edit applied, and when several failed", () => {
    const one = editRow("a", "src/a.ts", [" 1|a", "+2|b"].join("\n"));
    const two = editRow("b", "src/b.ts", [" 1|a", "-2|b"].join("\n"));
    const twice = editRow("c", "src/a.ts", [" 1|a", "+2|b2"].join("\n"));
    const failedRow: ToolActivityRow = {
      id: "f",
      role: "tool",
      text: "no match",
      toolName: "edit",
      toolCallId: "call-f",
      isError: true,
      toolArgs: { path: "src/gone.ts", old_string: "x", new_string: "y" },
      toolResult: { content: [], isError: true, details: { diff: "", errorKind: "no_match" } },
    };
    for (const rows of [[one, two, twice], [one, failedRow], [failedRow], [one, two, twice, failedRow]]) {
      const summary = summarizeChangedFiles(collectChangedFiles(rows));
      expect(summary.appliedFiles).toBe(summarizeFileChanges(rows)?.uniqueFiles ?? 0);
    }
  });

  it("reports an aggregate as `not applied` rather than a count when the file failed", () => {
    const failed: ChangedFile = { path: "a", shortName: "a", directory: "", status: "unknown", edits: 1, appliedEdits: 0, observedAdditions: null, observedDeletions: null, failed: true, truncated: false, errorText: null, lastDiff: null, moveFrom: null, rawDetails: null };
    expect(changedFileCountsText(failed)).toBe("not applied");
    expect(changedFileCountsText({ ...failed, failed: false })).toBe("counts unavailable");
    expect(changedFileCountsText({ ...failed, failed: false, observedAdditions: 3, observedDeletions: 1 })).toBe("+3 −1");
  });
});

describe("filterChangedFiles / sortChangedFiles", () => {
  const files = collectChangedFiles([
    editRow("a", "src/Beta.ts", [" 1|a", "+2|b", "+3|c"].join("\n")),
    editRow("b", "src/alpha.ts", [" 1|a", "+2|b"].join("\n")),
    editRow("c", "docs/readme.md", "-1|gone", { op: "delete" }),
  ]);

  it("matches a case-insensitive substring over the full path", () => {
    expect(filterChangedFiles(files, { query: "ALPHA" }).map((file) => file.path)).toEqual(["src/alpha.ts"]);
    expect(filterChangedFiles(files, { query: "src/" }).map((file) => file.path)).toEqual(["src/Beta.ts", "src/alpha.ts"]);
  });

  it("applies an exact status filter, and allows `all`", () => {
    expect(filterChangedFiles(files, { status: "deleted" }).map((file) => file.path)).toEqual(["docs/readme.md"]);
    expect(filterChangedFiles(files, { status: "all" })).toHaveLength(3);
  });

  it("orders by observed changes desc then path, deterministically", () => {
    const sorted = sortChangedFiles(files, "changes");
    expect(sorted.map((file) => file.path)).toEqual(["src/Beta.ts", "src/alpha.ts", "docs/readme.md"]);
    expect(sortChangedFiles([...files].reverse(), "changes").map((file) => file.path)).toEqual(sorted.map((file) => file.path));
  });

  it("sorts a file without proved counts last, below a real zero", () => {
    const sorted = sortChangedFiles(withoutCounts(files), "changes");
    expect(sorted.map((file) => file.path)).toEqual(["docs/readme.md", "src/Beta.ts", "src/alpha.ts"]);
  });

  it("orders by path ascending", () => {
    expect(sortChangedFiles(files, "path").map((file) => file.path)).toEqual(["docs/readme.md", "src/Beta.ts", "src/alpha.ts"]);
  });

  it("orders by status in the documented fixed order, then path", () => {
    expect(sortChangedFiles(files, "status").map((file) => file.status)).toEqual(["modified", "modified", "deleted"]);
  });
});

describe("hunkHeadersOf / patchTextOf", () => {
  it("gives hunk1 the new-side start the preceding hunk's delta implies, not its own old start", () => {
    const hunks = parseGutterDiff(CENSUS_DIFF);
    expect(hunks).toHaveLength(2);
    const headers = hunkHeadersOf(hunks);
    expect(headers[0]).toBe("@@ -50,14 +50,11 @@");
    // The naive `+${oldStart}` here would print +116.
    expect(headers[1]).toBe("@@ -116,2 +113,2 @@");
  });

  it("carries every hunk's delta forward across three hunks", () => {
    const diff = [
      // +1 net on the first hunk.
      " 1|a",
      "-2|b",
      "+2|b",
      "+3|c",
      "",
      // −1 here: the running delta drops back to 0.
      " 20|x",
      "-21|y",
      "",
      // No change: stays 0.
      " 40|p",
      " 41|q",
    ].join("\n");
    expect(hunkHeadersOf(parseGutterDiff(diff))).toEqual([
      "@@ -1,2 +1,3 @@",
      "@@ -20,2 +21,1 @@",
      "@@ -40,2 +40,2 @@",
    ]);
  });

  it("copies the same verified headers into the patch text", () => {
    const [file] = collectChangedFiles([editRow("c", "src/nine.ts", CENSUS_DIFF)]);
    const text = patchTextOf(file!);
    expect(text).toContain("@@ -50,14 +50,11 @@");
    expect(text).toContain("@@ -116,2 +113,2 @@");
    expect(text).not.toContain("@@ -116,2 +116,2 @@");
  });

  it("emits no header for a hunk whose numbers do not verify, and still advances the delta", () => {
    const diff = [
      // Hunk 1's own old numbers jump (65 where the walk predicts 3), so it gets no
      // header...
      " 1|a",
      "-2|b",
      "+2|b2",
      "",
      " 65|c",
      "-70|d",
      "-71|e",
      "",
      // ...but its structural delta still shifted the third hunk's new side.
      " 90|z",
    ].join("\n");
    const headers = hunkHeadersOf(parseGutterDiff(diff));
    expect(headers[0]).toBe("@@ -1,2 +1,2 @@");
    expect(headers[1]).toBe("");
    expect(headers[2]).toBe("@@ -90,1 +88,1 @@");
  });

  it("keeps the host's own header verbatim when it sent one", () => {
    expect(hunkHeadersOf(parseGutterDiff(["@@ -7,3 +7,4 @@", " 7|a", "+8|b"].join("\n")))).toEqual(["@@ -7,3 +7,4 @@"]);
  });

  it("rebuilds unified hunks and re-anchors them with recoverable numbers", () => {
    const [file] = collectChangedFiles([editRow("a", "src/a.ts", [" 1|keep", "-2|old", "+2|new"].join("\n"))]);
    expect(patchTextOf(file!)).toBe(["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new"].join("\n"));
  });

  it("says so instead of inventing numbers when a hunk is unrecoverable", () => {
    const [file] = collectChangedFiles([editRow("b", "src/b.ts", ["not a gutter line", "+2|x"].join("\n"))]);
    const text = patchTextOf(file!);
    expect(text).toContain("no recoverable line numbers");
    expect(text).not.toMatch(/@@ -null/);
  });

  it("says there is nothing to copy when the host sent no diff", () => {
    const file: ChangedFile = { path: "a", shortName: "a", directory: "", status: "unknown", edits: 1, appliedEdits: 0, observedAdditions: null, observedDeletions: null, failed: false, truncated: false, errorText: null, lastDiff: null, moveFrom: null, rawDetails: null };
    expect(patchTextOf(file)).toContain("--- a/a");
    expect(patchTextOf(file)).toContain("no diff");
  });
});

describe("FilesCenter", () => {
  const files = collectChangedFiles([
    editRow("a", "src/auth.ts", [" 1|a", "-2|b", "+2|B"].join("\n")),
    editRow("b", "docs/readme.md", " 1|a"),
  ]);
  const summary = summarizeChangedFiles(files);
  const baseProps = {
    files,
    summary,
    windowNote: "Edits observed in this conversation's transcript — not the working tree; only the loaded history window.",
    onOpenFile: () => {},
    onBack: () => {},
  };

  it("states the provenance verbatim in one muted line", () => {
    render(<FilesCenter {...baseProps} />);
    expect(screen.getByText(baseProps.windowNote)).toBeTruthy();
  });

  /*
   * The rendered header must print the same number the dashboard card prints, for
   * the same rows: this is the reconciliation the audit measured failing ("2 files"
   * vs "Changed 1 file"). Asserted on the DOM, not on the summary object, so the
   * screen itself is pinned.
   */
  it("prints the applied file count the dashboard card prints, and labels failed rows as not counted", () => {
    const applied = editRow("ok", "src/ok.ts", [" 1|a", "+2|b"].join("\n"));
    const failed: ToolActivityRow = {
      id: "bad",
      role: "tool",
      text: "no match",
      toolName: "edit",
      toolCallId: "call-bad",
      isError: true,
      toolArgs: { path: "src/bad.ts", old_string: "x", new_string: "y" },
      toolResult: { content: [], isError: true, details: { diff: "", errorKind: "no_match" } },
    };
    const rows = [applied, failed];
    const files = collectChangedFiles(rows);
    render(<FilesCenter {...baseProps} files={files} summary={summarizeChangedFiles(files)} />);

    const card = summarizeFileChanges(rows);
    expect(card!.uniqueFiles).toBe(1);
    expect(screen.getByText("1 file changed", { exact: false })).toBeTruthy();
    expect(screen.getByText("1 failed row not counted", { exact: false })).toBeTruthy();
    // The failed row is still listed, and says it is not part of the count.
    expect(screen.getByText("bad.ts")).toBeTruthy();
    expect(screen.getByText("failed — not counted")).toBeTruthy();
  });

  it("renders the corrected header for the audit's real two-hunk diff", () => {
    const [file] = collectChangedFiles([editRow("c", "src/nine.ts", CENSUS_DIFF)]);
    render(<FilesCenter {...baseProps} files={[file!]} summary={summarizeChangedFiles([file!])} openPath="src/nine.ts" />);
    const headers = screen.getAllByText(/^@@ /).map((node) => node.textContent);
    expect(headers[0]).toBe("@@ -50,14 +50,11 @@");
    expect(headers[1]).toBe("@@ -116,2 +113,2 @@");
  });

  it("lists one row per file with short name and directory", () => {
    render(<FilesCenter {...baseProps} />);
    expect(screen.getByText("auth.ts")).toBeTruthy();
    expect(screen.getByText("readme.md")).toBeTruthy();
    expect(screen.getByText("src/")).toBeTruthy();
  });

  it("shows a real empty state when the filters match nothing", () => {
    render(<FilesCenter {...baseProps} />);
    fireEvent.change(screen.getByLabelText("Search files"), { target: { value: "nothing-matches-this" } });
    expect(screen.getByRole("status").textContent).toContain("No file path matches");
  });

  it("reports an empty transcript rather than a filtered-to-nothing list", () => {
    const empty = summarizeChangedFiles([]);
    render(<FilesCenter {...baseProps} files={[]} summary={empty} />);
    expect(screen.getByRole("status").textContent).toContain("No edits have been observed");
  });

  it("filtering by a chip narrows to that status, with aria-pressed", () => {
    const withDelete = collectChangedFiles([
      editRow("a", "src/auth.ts", " 1|a"),
      editRow("b", "docs/gone.md", "-1|x", { op: "delete" }),
    ]);
    render(<FilesCenter {...baseProps} files={withDelete} summary={summarizeChangedFiles(withDelete)} />);
    const deleted = screen.getByRole("button", { name: "Deleted" });
    fireEvent.click(deleted);
    expect(deleted.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("auth.ts")).toBeNull();
    expect(screen.getByText("gone.md")).toBeTruthy();
  });

  it("cycles the sort control through the documented orderings", () => {
    render(<FilesCenter {...baseProps} />);
    const sort = screen.getByRole("button", { name: /Sort by/ });
    expect(sort.textContent).toBe("Sort: Changes");
    fireEvent.click(sort);
    expect(sort.textContent).toBe("Sort: Path");
    fireEvent.click(sort);
    expect(sort.textContent).toBe("Sort: Status");
    fireEvent.click(sort);
    expect(sort.textContent).toBe("Sort: Changes");
  });

  it("calls onOpenFile with the full path when a row is tapped", () => {
    const onOpenFile = vi.fn();
    render(<FilesCenter {...baseProps} onOpenFile={onOpenFile} />);
    fireEvent.click(screen.getByText("auth.ts"));
    expect(onOpenFile).toHaveBeenCalledWith("src/auth.ts");
  });

  it("renders the diff view for openPath instead of the list", () => {
    render(<FilesCenter {...baseProps} openPath="src/auth.ts" />);
    expect(screen.getByRole("region", { name: "auth.ts" })).toBeTruthy();
    expect(screen.queryByLabelText("Search files")).toBeNull();
  });

  it("says so when openPath names a file the list no longer holds", () => {
    render(<FilesCenter {...baseProps} openPath="src/vanished.ts" />);
    expect(screen.getByRole("status").textContent).toContain("no longer in this conversation's change list");
    expect(screen.getByLabelText("Search files")).toBeTruthy();
  });
});
