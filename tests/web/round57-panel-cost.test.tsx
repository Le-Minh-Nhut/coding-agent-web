// @vitest-environment jsdom
/**
 * The secondary panels' cost fixes, pinned by behaviour.
 *
 * Each case pins the DECISION that makes the path cheap, not a duration — a timing
 * assertion in jsdom measures jsdom. Every decision below is invisible to a reader
 * and trivially reversible, which is what this file exists to prevent:
 *
 *  1. `FileDiffView` bounds rendered LINES inside a hunk, not only whole hunks.
 *     OMP's gutter diffs routinely arrive as one hunk covering the file, and the
 *     bound used to be checked before a hunk was added, so such a patch mounted
 *     every line. The bound must still be stated, and "Show all" must restore the
 *     exact source text — no content may become unreachable.
 *  2. `AdvisorPanel` matches a note to its issue by the SAME identity the lifecycle
 *     uses. The lookup became an index; the badge it produces must not move.
 *  3. `advisorEvidence` reduces a row's words once per row rather than once per
 *     note × row. The evidence for every issue must be identical to the
 *     per-issue entry point, which is the unamortized implementation.
 *  4. `advanceAgentTranscript` decodes only the appended suffix, and must yield
 *     exactly the rows an unamortized full parse yields — including after a reset,
 *     where the reducer replaces `text` from `""`.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FileDiffView } from "../../apps/web/src/components/FileDiffView.js";
import { AdvisorPanel } from "../../apps/web/src/components/AdvisorPanel.js";
import { AgentDetail } from "../../apps/web/src/components/AgentDetail.js";
import type { AgentView } from "../../apps/web/src/agent-model.js";
import {
  advisorEvidence,
  advisorIssues,
  advisorIssueViews,
  evidenceForIssue,
  type AdvisorIssue,
  type EvidenceRow,
} from "../../apps/web/src/advisor.js";
import {
  advanceAgentTranscript,
  agentTranscriptFromReply,
  type AgentTranscriptCursor,
} from "../../apps/web/src/agent-transcript.js";
import type { ChangedFile } from "../../apps/web/src/files.js";

afterEach(cleanup);

/** One hunk — no `…` separator — with more lines than the view renders at once. */
function singleHunkDiff(lines: number): string {
  const parts: string[] = [];
  for (let index = 0; index < lines; index += 3) {
    parts.push(` ${index + 1}|context line ${index}`);
    parts.push(`-${index + 2}|old line ${index}`);
    parts.push(`+${index + 2}|new line ${index}`);
  }
  return parts.join("\n");
}

function diffFile(diff: string): ChangedFile {
  return {
    path: "src/big.ts",
    shortName: "big.ts",
    directory: "src",
    status: "modified",
    edits: 1,
    appliedEdits: 1,
    observedAdditions: 1,
    observedDeletions: 1,
    failed: false,
    truncated: false,
    errorText: null,
    lastDiff: diff,
    moveFrom: null,
    rawDetails: null,
  };
}

describe("FileDiffView bounds the lines it mounts", () => {
  it("mounts a bounded prefix of a single-hunk patch and states what is hidden", () => {
    render(<FileDiffView file={diffFile(singleHunkDiff(3_000))} onBack={() => {}} />);

    // 3,000 lines arrive as ONE hunk, so a hunk-count bound would mount all of it.
    expect(screen.getByText("1 hunk")).toBeTruthy();
    const mounted = document.querySelectorAll(".files-diff-row").length;
    expect(mounted).toBeLessThanOrEqual(401);

    // Bounded, never silently: the control says how much is left.
    const showAll = document.querySelector(".files-show-all") as HTMLButtonElement | null;
    expect(showAll).not.toBeNull();
    expect(showAll!.textContent).toContain("more line");
  });

  it("keeps add and delete tones on the rows it does mount", () => {
    render(<FileDiffView file={diffFile(singleHunkDiff(3_000))} onBack={() => {}} />);
    // The first three lines are context, delete, add — the parser's own order.
    expect(document.querySelector(".files-diff-row.tv-diff-row--del")).not.toBeNull();
    expect(document.querySelector(".files-diff-row.tv-diff-row--add")).not.toBeNull();
  });

  it("restores every line, in order, when Show all is used", () => {
    const diff = singleHunkDiff(3_000);
    render(<FileDiffView file={diffFile(diff)} onBack={() => {}} />);
    const before = document.querySelectorAll(".files-diff-row").length;
    expect(before).toBeLessThanOrEqual(401);

    fireEvent.click(document.querySelector(".files-show-all") as HTMLButtonElement);

    // 1,000 line-triples: three rows each, and the control is gone because nothing
    // is hidden any more.
    expect(document.querySelectorAll(".files-diff-row").length).toBe(3_000);
    expect(document.querySelector(".files-show-all")).toBeNull();
    // The last line of the patch is on screen — the tail was not lost.
    expect(document.body.textContent).toContain("new line 2997");
    // The exact source text of a line that was previously cut is reachable.
    expect(document.body.textContent).toContain("context line 1500");
  });
});

describe("AdvisorPanel's note → issue match is index-driven but unchanged", () => {
  const entries = [
    { customType: "advisor", details: { notes: [{ note: "The retry loop can spin forever.", severity: "blocker", advisor: "warden" }] } },
    { role: "assistant", text: "I fixed the retry loop can spin forever problem by adding a bound." },
    { customType: "advisor", details: { notes: [{ note: "Ship it", severity: "nit" }] } },
  ];
  const issues = advisorIssueViews(advisorIssues(entries), advisorEvidence(entries as readonly EvidenceRow[]));
  const summary = {
    notes: issues.map((issue) => ({ note: issue.note, severity: issue.severity, advisor: issue.advisor, turnsAgo: null })),
    advisors: ["warden"],
    hasBlocker: true,
  };

  it("shows the lifecycle state the same note carries, for each note", () => {
    render(<AdvisorPanel summary={summary} issues={issues} onClose={() => {}} />);
    // The blocker reached `verifying` (a spoken claim, never proof), and that is
    // the word beside the note matched to it.
    expect(screen.getByText("Claimed fixed, unverified")).toBeTruthy();
    expect(screen.getByText("Unresolved")).toBeTruthy();
    // The two badges are on the notes they belong to, not swapped.
    const heads = [...document.querySelectorAll(".advisor-note-head")].map((node) => node.textContent ?? "");
    expect(heads[0]).toContain("blocker");
    expect(heads[0]).toContain("Claimed fixed, unverified");
    expect(heads[1]).toContain("nit");
    expect(heads[1]).toContain("Unresolved");
  });

  it("matches a note whose issue text differs only in whitespace, as the scan did", () => {
    const spaced = advisorIssueViews(
      advisorIssues(entries),
      () => [],
    ).map((issue, index) => (index === 0 ? { ...issue, note: `  The retry loop\n  can spin forever.  ` } : issue));
    render(<AdvisorPanel summary={summary} issues={spaced} onClose={() => {}} />);
    // Note text is "The retry loop can spin forever." and the issue's is the same
    // sentence split across lines: the match must still be found.
    expect(screen.getAllByText("Unresolved").length).toBeGreaterThan(0);
  });
});

describe("advisorEvidence amortizes the row → words reduction", () => {
  function build(): { rows: EvidenceRow[]; issues: AdvisorIssue[] } {
    const rows: EvidenceRow[] = [];
    for (let index = 0; index < 40; index += 1) {
      rows.push({ customType: "advisor", details: { notes: [{ note: `the retry loop in module ${index} can spin forever`, severity: "concern", advisor: "warden" }] } });
      rows.push({ role: "assistant", text: `Investigated report ${index}. The retry loop in module ${index} can spin forever. I fixed the retry loop in module ${index} by adding a bound.` });
      rows.push({ role: "tool", text: `still failing: the retry loop in module ${index} can spin forever`, isError: true });
      // A negated sentence: the window rule must keep it out of the evidence.
      rows.push({ role: "assistant", text: `The retry loop in module ${index} can spin forever is not fixed yet.` });
      rows.push({ role: "tool", text: "unrelated output that mentions nothing of the sort", isError: false });
    }
    const issues = advisorIssues(rows.map((row) => ({ customType: row.customType, details: row.details })));
    return { rows, issues };
  }

  it("returns, per issue, exactly what the unamortized per-issue scan returns", () => {
    const { rows, issues } = build();
    const shared = advisorEvidence(rows);
    expect(issues.length).toBeGreaterThan(1);
    for (const issue of issues) {
      // `evidenceForIssue` is the unamortized path: it reduces each row itself.
      expect(shared(issue)).toEqual(evidenceForIssue(rows, issue));
    }
  });

  it("derives the same lifecycle as the unamortized path, including the negated case", () => {
    const { rows, issues } = build();
    const amortized = advisorIssueViews(issues, advisorEvidence(rows));
    const perIssue = advisorIssueViews(issues, (issue) => evidenceForIssue(rows, issue));
    expect(amortized.map((view) => view.state)).toEqual(perIssue.map((view) => view.state));
    // A claim is the strongest thing prose can produce: neither path may reach
    // `resolved`, which only a real verification whose subject is the issue can.
    expect(amortized.some((view) => view.state === "resolved")).toBe(false);
    // Exactly one claim and one failing run per issue. The count is what pins the
    // negation window: "is not fixed yet" must contribute no claim, and an
    // `isError === false` tool row must contribute no failure. Either one leaking
    // through would double the respective count.
    for (const view of amortized) {
      expect(view.evidence.filter((item) => item.kind === "fix-claim")).toHaveLength(40);
      expect(view.evidence.filter((item) => item.kind === "still-failing")).toHaveLength(40);
      expect(view.evidence.some((item) => item.kind === "verification-pass")).toBe(false);
    }
  });

  it("caches per issue id, so a repeated request returns the same array", () => {
    const { rows, issues } = build();
    const shared = advisorEvidence(rows);
    const first = shared(issues[0]!);
    expect(shared(issues[0]!)).toBe(first);
  });
});

describe("advanceAgentTranscript decodes only the appended suffix", () => {
  const line = (index: number): string =>
    `${JSON.stringify({ type: "message", id: `m${index}`, message: { role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `row ${index}` }] } })}\n`;

  function journal(lines: number): string {
    let text = "";
    for (let index = 0; index < lines; index += 1) text += line(index);
    return text;
  }

  it("agrees with a full parse at every growth step", () => {
    const lines = Array.from({ length: 20 }, (_, index) => line(index));
    let cursor: AgentTranscriptCursor | null = null;
    let text = "";
    for (const next of lines) {
      text += next;
      const step = advanceAgentTranscript(cursor, { text, newSize: text.length, carry: "" });
      cursor = step.cursor;
      // The incrementally built transcript must equal the one a cold parse yields,
      // at every intermediate length — not only once the journal is complete.
      expect(step.transcript).toEqual(agentTranscriptFromReply({ text, newSize: text.length, carry: "" }));
    }
    expect(cursor!.rows.map((row) => row.id)).toEqual(lines.map((_, index) => `m${index}`));
  });

  it("re-decodes from scratch when the text no longer extends the cursor (a reset)", () => {
    const first = journal(10);
    const started = advanceAgentTranscript(null, { text: first, newSize: first.length, carry: "" });
    // The reducer signals truncation by replacing `text` from "": the journal is
    // now shorter and does not start with what the cursor holds.
    const rewound = journal(4);
    const step = advanceAgentTranscript(started.cursor, { text: rewound, newSize: rewound.length, carry: "" });
    expect(step.transcript.rows.map((row) => row.id)).toEqual(["m0", "m1", "m2", "m3"]);
    // The superseded rows are gone, not concatenated onto the new prefix.
    expect(step.transcript.rows.some((row) => row.id === "m9")).toBe(false);
    expect(step.transcript).toEqual(agentTranscriptFromReply({ text: rewound, newSize: rewound.length, carry: "" }));
  });

  it("returns the cursor untouched for a reply that is byte-identical", () => {
    const text = journal(6);
    const started = advanceAgentTranscript(null, { text, newSize: text.length, carry: "" });
    const again = advanceAgentTranscript(started.cursor, { text, newSize: text.length, carry: "" });
    // Identity, not just equality: a poll with no new bytes must do no work, and
    // must be safe to call from a render React may run twice.
    expect(again.cursor).toBe(started.cursor);
    expect(again.transcript.rows).toBe(started.transcript.rows);
  });

  it("carries the last model_change and session_init fields across an incremental step", () => {
    const head = `${line(0)}${JSON.stringify({ type: "session_init", id: "init-1", task: "count the rows", agent: "scout", resolvedModel: "provider/first" })}\n${JSON.stringify({ type: "model_change", id: "mc-1", model: "provider/second" })}\n`;
    const tail = line(1);
    const first = advanceAgentTranscript(null, { text: head, newSize: head.length, carry: "" });
    expect(first.transcript.task).toBe("count the rows");
    expect(first.transcript.agentName).toBe("scout");
    expect(first.transcript.model).toBe("provider/second");

    const grown = head + tail;
    const second = advanceAgentTranscript(first.cursor, { text: grown, newSize: grown.length, carry: "" });
    // A suffix with no init/model_change must not erase what the prefix recorded.
    expect(second.transcript.task).toBe("count the rows");
    expect(second.transcript.agentName).toBe("scout");
    expect(second.transcript.model).toBe("provider/second");
    expect(second.transcript.rows.map((row) => row.id)).toEqual(["m0", "mc-1", "m1"]);
    expect(second.transcript).toEqual(agentTranscriptFromReply({ text: grown, newSize: grown.length, carry: "" }));
  });

  it("counts an unreadable line once, whichever path decodes it", () => {
    const head = `${line(0)}not json at all\n`;
    const first = advanceAgentTranscript(null, { text: head, newSize: head.length, carry: "" });
    expect(first.transcript.unreadableRecords).toBe(1);
    const grown = `${head}still not json\n${line(1)}`;
    const second = advanceAgentTranscript(first.cursor, { text: grown, newSize: grown.length, carry: "" });
    expect(second.transcript.unreadableRecords).toBe(2);
  });

  it("reports incomplete bytes without emitting a row for the partial", () => {
    const text = journal(3);
    const step = advanceAgentTranscript(null, { text, newSize: text.length, carry: JSON.stringify({ type: "message", id: "half" }) });
    expect(step.transcript.complete).toBe(false);
    expect(step.transcript.rows.some((row) => row.id === "half")).toBe(false);
  });
});

describe("AgentDetail does not extend one agent's decode into another's", () => {
  const view = (id: string): AgentView => ({
    id,
    displayName: id,
    kind: "sub",
    status: "running",
    class: "subagent",
    parentId: "main",
    hasSessionFile: true,
    createdAt: 1,
    lastActivity: 1,
    canKillWorker: false,
    readOnlyReason: "No Vibe lifecycle record for this agent, so it is not treated as a worker.",
  });

  const props = (id: string, text: string) => ({
    view: view(id),
    activity: undefined,
    transcript: { text, newSize: text.length, carry: "" },
    transcriptError: null,
    loading: false,
    onFetchTranscript: () => {},
    onBack: () => {},
  });

  it("shows the second agent's rows, not the first agent's rows extended", () => {
    // The real switch is an IN-PLACE change of `view.id`: `ConversationView` renders
    // `<AgentDetail view={selected} />` with no `key`, so React reuses the instance
    // and the cursor held for the first agent would otherwise be offered as the
    // second agent's history. Journals of two agents share no prefix, so the guard
    // must reset rather than treat A's bytes as B's.
    const a = `${JSON.stringify({ type: "message", id: "a-1", message: { role: "user", content: [{ type: "text", text: "agent A said this" }] } })}\n`;
    const b = `${JSON.stringify({ type: "message", id: "b-1", message: { role: "assistant", content: [{ type: "text", text: "agent B said that" }] } })}\n`;
    const first = render(<AgentDetail {...props("a", a)} />);
    expect(first.container.textContent).toContain("agent A said this");

    first.rerender(<AgentDetail {...props("b", b)} />);
    expect(first.container.textContent).toContain("agent B said that");
    expect(first.container.textContent).not.toContain("agent A said this");
  });

  it("extends the same agent's decode when only its own journal grows", () => {
    const one = `${JSON.stringify({ type: "message", id: "a-1", message: { role: "user", content: [{ type: "text", text: "first line" }] } })}\n`;
    const two = `${JSON.stringify({ type: "message", id: "a-2", message: { role: "assistant", content: [{ type: "text", text: "second line" }] } })}\n`;
    const view = render(<AgentDetail {...props("a", one)} />);
    expect(view.container.textContent).toContain("first line");
    view.rerender(<AgentDetail {...props("a", one + two)} />);
    // Both rows are present: the appended suffix was decoded onto the prefix.
    expect(view.container.textContent).toContain("first line");
    expect(view.container.textContent).toContain("second line");
  });
});
