import { describe, expect, it } from "vitest";
import { groupActivity, pairToolArguments, summarizeFileChanges } from "../../apps/web/src/tool-activity.js";
import { advisorEvidence, advisorIssues, advisorIssueViews, summarizeAdvisorNotes } from "../../apps/web/src/advisor.js";
import { collectChangedFiles, summarizeChangedFiles } from "../../apps/web/src/files.js";
import type { DisplayMessage } from "../../apps/web/src/components/MessageRow.js";

/**
 * How much a whole-history derivation costs at the reported transcript size.
 *
 * This exists because the round measured 7.7ms of script per appended row on a
 * 4075-entry history at 4x CPU throttle and nearly "fixed" the wrong thing twice:
 * first row-object identity (no effect), then the running header. The cost is in
 * one of the derivations the view recomputes per update, and a number is the only
 * way to know which.
 *
 * The ceilings are deliberately loose — this is a regression tripwire on an order
 * of magnitude, not a benchmark. A machine three times slower must still pass;
 * a derivation that acquires accidental quadratic behaviour must not.
 */

/** The reported conversation: 4075 entries, one in four a tool result with a diff. */
function buildRows(count: number): DisplayMessage[] {
  const rows: DisplayMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    switch (index % 4) {
      case 0:
        rows.push({ id: `u-${index}`, role: "user", text: `prompt ${index}`, blocks: [{ type: "text", text: `prompt ${index}` }] });
        break;
      case 1:
        rows.push({ id: `a-${index}`, role: "assistant", text: `answer ${index}`, blocks: [{ type: "text", text: `answer ${index}` }] });
        break;
      case 2:
        rows.push({
          id: `t-${index}`,
          role: "tool",
          text: `output ${index}`,
          toolName: "bash",
          toolCallId: `call-${index}`,
          toolResult: { details: { diff: "", path: `/work/file${index}.ts` } },
        });
        break;
      default:
        rows.push({ id: `a2-${index}`, role: "assistant", text: `short answer ${index}` });
    }
  }
  return rows;
}

const ROWS = buildRows(4075);

/** Median of a few runs, after a warm-up, so a cold JIT is not the verdict. */
function cost(run: () => unknown): number {
  run();
  const samples: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

describe("whole-history derivations at 4075 entries", () => {
  it("groupActivity stays linear", () => {
    const ms = cost(() => groupActivity(ROWS));
    console.log(`groupActivity ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(200);
  });

  it("pairToolArguments stays linear", () => {
    const ms = cost(() => pairToolArguments(ROWS));
    console.log(`pairToolArguments ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(200);
  });

  it("summarizeFileChanges stays linear", () => {
    const ms = cost(() => summarizeFileChanges(ROWS));
    console.log(`summarizeFileChanges ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(200);
  });

  it("collectChangedFiles stays linear ON TOP of a pairing that was already computed", () => {
    // `collectChangedFiles` takes the pairing as a parameter precisely so a caller
    // that already computed it does not pay for it twice; this measures the call
    // the view actually makes.
    const paired = pairToolArguments(ROWS);
    const ms = cost(() => collectChangedFiles(ROWS, paired));
    console.log(`collectChangedFiles ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(200);
  });

  it("the advisor pipeline stays linear", () => {
    const advisorRows = ROWS.map((row) => ({ customType: undefined, details: undefined, role: row.role, text: row.text, isError: false }));
    const ms = cost(() => {
      const issues = advisorIssues(advisorRows);
      const evidence = advisorEvidence(advisorRows);
      return advisorIssueViews(issues, evidence);
    });
    console.log(`advisor pipeline ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(400);
  });

  it("the two calls the view makes per update, together, stay under one frame", () => {
    // The realistic per-update pair on the live path: the dashboard's file summary
    // plus the Files Center's changed-file index. Both walk every row.
    const ms = cost(() => {
      summarizeFileChanges(ROWS);
      summarizeChangedFiles(collectChangedFiles(ROWS, pairToolArguments(ROWS)));
    });
    console.log(`per-update file derivations ${ms.toFixed(2)}ms`);
    expect(ms).toBeLessThan(400);
  });
});

describe("the cost of re-rendering the transcript", () => {
  it("parsing every row's markdown is the cost that a full-list re-render pays", async () => {
    const { renderMarkdown } = await import("../../apps/web/src/sanitize.js");
    // One row's worth of text, of the shape the live transcript carries: a heading,
    // a list, a table and a fenced block.
    const text = `## Section\n\n- item one\n- item two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n\`\`\`ts\nconst value = 1;\n\`\`\`\n\n${"paragraph text ".repeat(12)}`;
    const RUNS = 2000;
    const cold = performance.now();
    for (let index = 0; index < RUNS; index += 1) renderMarkdown(`${text}${index}`);
    const perCall = (performance.now() - cold) / RUNS;
    console.log(`renderMarkdown ${perCall.toFixed(4)}ms/call; 4075 rows = ${(perCall * 4075).toFixed(1)}ms per full re-render`);
    expect(perCall).toBeLessThan(5);
  });
});
