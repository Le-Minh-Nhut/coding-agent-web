// @vitest-environment jsdom
/**
 * Round 11's subagent-transcript behaviours, re-pointed at Agent Detail (round 53).
 *
 * The old `SubagentPanel` was a modal that kept a manual `Refresh` button. Agent
 * Detail is a full-screen view that polls and *self-heals*, so it has no Refresh
 * button by design (see its own comment). These tests therefore keep the original
 * claims — a running agent's transcript keeps being fetched, and a transient error
 * does not permanently stop polling — and drop only the premise about a button
 * that no longer exists.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { AgentDetail } from "../../apps/web/src/components/AgentDetail.js";
import type { AgentView } from "../../apps/web/src/agent-model.js";
import type { TranscriptReply } from "../../apps/web/src/transcript.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** A running worker with a transcript file, as Agent Detail receives it. */
function view(over: Partial<AgentView> = {}): AgentView {
  return {
    id: "a", displayName: "Worker", kind: "sub", status: "running", class: "worker",
    parentId: "main", hasSessionFile: true, createdAt: 0, lastActivity: 0,
    canKillWorker: true, readOnlyReason: null, ...over,
  };
}

function props(over: Partial<React.ComponentProps<typeof AgentDetail>> = {}) {
  return {
    view: view(),
    activity: undefined,
    transcript: undefined as TranscriptReply | undefined,
    transcriptError: null as string | null,
    loading: false,
    onFetchTranscript: vi.fn(),
    onBack: vi.fn(),
    ...over,
  };
}

it("audit11 control: a running agent's transcript keeps being polled", async () => {
  vi.useFakeTimers();
  const p = props();
  render(<AgentDetail {...p} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  // Three polls at 1200ms, plus the immediate fetch on mount.
  expect(p.onFetchTranscript.mock.calls.length).toBeGreaterThanOrEqual(3);
});

it("audit11: a transient transcript error does not stop polling", async () => {
  vi.useFakeTimers();
  const p = props({ transcriptError: "Network timeout" });
  const rendered = render(<AgentDetail {...p} />);
  // The error is visible, not swallowed.
  expect(rendered.queryByRole("alert")).not.toBeNull();

  const before = p.onFetchTranscript.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  // Self-healing: the poll continues, so a recovered host is picked up without a
  // manual Refresh — the behaviour the old test protected through the button.
  expect(p.onFetchTranscript.mock.calls.length).toBeGreaterThan(before);
});

it("does not poll an agent that has no transcript file", async () => {
  vi.useFakeTimers();
  const p = props({ view: view({ hasSessionFile: false }) });
  render(<AgentDetail {...p} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  // Nothing to fetch: an explicit unavailable state instead of empty polling.
  expect(p.onFetchTranscript).not.toHaveBeenCalled();
});

/**
 * Polling an unchanged journal must not re-parse it.
 *
 * `applyTranscript` returns a NEW transcript object on every poll — even one that
 * carried no bytes — so a memo keyed on that object re-ran the whole JSONL parse on
 * every 1200 ms tick. On a real phone-sized journal that was ~130 ms of blocked main
 * thread, forever. The memo is now keyed on `text`/`carry`, the two strings the
 * parser actually reads.
 *
 * Counted through `JSON.parse`, which is also what the audit measured, on the real
 * captured journal rather than a toy: a synthesized 3-line file would pass even if
 * the memo key were still wrong.
 */
it("does not re-parse the journal on a poll that carried no new bytes", async () => {
  const text = readFileSync(resolve(__dirname, "../fixtures/omp-session/real-subagent-LaneLockCheck.jsonl"), "utf8");
  const reply: TranscriptReply = { text, newSize: Buffer.byteLength(text), carry: "" };

  let calls = 0;
  const realParse = JSON.parse;
  (JSON as unknown as { parse: typeof JSON.parse }).parse = (input: string, reviver?: (key: string, value: unknown) => unknown) => {
    calls += 1;
    return reviver === undefined ? realParse(input) : realParse(input, reviver);
  };
  try {
    const rendered = render(<AgentDetail {...props({ transcript: reply })} />);
    const afterFirst = calls;
    expect(afterFirst, "the first render must parse the bytes it was given").toBeGreaterThan(0);

    for (let poll = 0; poll < 4; poll += 1) {
      // The same bytes as a fresh object: exactly what an unchanged poll delivers.
      rendered.rerender(<AgentDetail {...props({ transcript: { text, newSize: reply.newSize, carry: "" } })} />);
      // Identical rows out, and crucially no second parse of 3.2 MB.
      expect(calls, `poll ${poll + 1} re-parsed an unchanged journal`).toBe(afterFirst);
    }

    // New bytes MUST re-parse: the guard is on the bytes, not on "never again".
    // The appended line is the fixture's OWN first message record, with only its
    // identity fields rewritten (so React keys stay unique); the record shape and
    // every other field are the real file's, not something this test invented.
    const realMessageLine = text.split("\n").find((line) => {
      try { return (JSON.parse(line) as { type?: string }).type === "message"; } catch { return false; }
    });
    if (realMessageLine === undefined) throw new Error("fixture has no message record to append");
    const record = JSON.parse(realMessageLine) as Record<string, unknown>;
    const appended = JSON.stringify({ ...record, id: "probe-appended-1", parentId: "main" });
    const grown = `${text}${appended}\n`;
    rendered.rerender(<AgentDetail {...props({ transcript: { text: grown, newSize: Buffer.byteLength(grown), carry: "" } })} />);
    expect(calls, "appended bytes must be parsed").toBeGreaterThan(afterFirst);

    // A rotation (different, smaller text) must also re-parse: the old rows are not
    // the new file's rows, so a byte-identity guard must not swallow it. Cut on a
    // record boundary so the fixture stays a real journal, just a rewound one.
    const rotated = text.slice(0, text.lastIndexOf("\n", 12_000) + 1);
    const beforeRotation = calls;
    rendered.rerender(<AgentDetail {...props({ transcript: { text: rotated, newSize: Buffer.byteLength(rotated), carry: "" } })} />);
    expect(calls, "a rewound file must be re-parsed").toBeGreaterThan(beforeRotation);
  } finally {
    (JSON as unknown as { parse: typeof JSON.parse }).parse = realParse;
  }
});
