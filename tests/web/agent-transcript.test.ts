/**
 * The agent-detail parse layer: native OMP journal JSONL → conversation rows.
 *
 * `AgentDetail` used to print the fetched bytes beside their JSON, so a subagent's
 * transcript read as `{"type":"message",…`. These tests defend the claims that make
 * the replacement honest, and the first one is the point of the whole change:
 *
 *  - **no wire JSON reaches a row.** The `session` header, the 255-byte `title`
 *    slot, `session_init`, `model_usage` and the `custom` bookkeeping records are
 *    decoded and either become a row with real meaning or become nothing.
 *  - **nothing is invented.** A missing `session_init` yields `task: null`; a
 *    missing model is `null`, never a guess. An unreadable line is *counted*, so
 *    the view can say "N records could not be read" instead of "the agent said
 *    nothing".
 *  - **polling is idempotent.** `carry` is a partial record and is never parsed, so
 *    the same bytes re-fetched at the same cursor produce the same rows.
 *
 * Fixtures are real where they can be (`real-subagent-LaneLockCheck.jsonl`, OMP
 * 18.13.0) and synthesized only for the edges the real sample lacks — see
 * `tests/fixtures/omp-session/README.md`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentTranscriptFromReply,
  nativeRows,
  parseNativeEntries,
  type AgentTranscript,
} from "../../apps/web/src/agent-transcript.js";
import { argumentsFor, pairToolArguments } from "../../apps/web/src/tool-activity.js";
import type { TranscriptReply } from "../../apps/web/src/transcript.js";

const fixtureDir = resolve(__dirname, "../fixtures/omp-session");

function readFixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), "utf8");
}

/** A whole file arrives as one reply whose `text` ends on a newline and whose `carry` is empty. */
function wholeFile(name: string): AgentTranscript {
  const text = readFixture(name);
  return agentTranscriptFromReply({ text, newSize: Buffer.byteLength(text), carry: "" });
}

/**
 * The split `applyTranscript` actually makes (`apps/web/src/transcript.ts:609-613`):
 * `text` keeps every complete line, `carry` keeps what follows the last newline.
 */
function splitAtLastNewline(raw: string): TranscriptReply {
  const cut = raw.lastIndexOf("\n") + 1;
  return { text: raw.slice(0, cut), newSize: Buffer.byteLength(raw.slice(0, cut)), carry: raw.slice(cut) };
}

describe("real subagent journal (OMP 18.13.0)", () => {
  const transcript = wholeFile("real-subagent-LaneLockCheck.jsonl");

  it("produces rows, and the user's own turn is one of them", () => {
    expect(transcript.rows.length).toBeGreaterThan(0);
    expect(transcript.rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(transcript.rows.filter((row) => row.role === "assistant").length).toBeGreaterThanOrEqual(3);
    expect(transcript.unreadableRecords).toBe(0);
    expect(transcript.complete).toBe(true);
  });

  it("pairs every tool result with the arguments of the call that produced it", () => {
    const tools = transcript.rows.filter((row) => row.role === "tool");
    expect(tools.length).toBeGreaterThanOrEqual(2);
    const paired = pairToolArguments(transcript.rows);
    // Every tool row on this journal is a `bash` call whose arguments came from its
    // assistant `toolCall` block, not from prose.
    for (const row of tools) {
      expect(row.toolName).toBe("bash");
      expect(argumentsFor(row, paired)).toMatchObject({ command: expect.any(String) });
    }
  });

  it("carries the failing tool result's error state", () => {
    const failed = transcript.rows.filter((row) => row.role === "tool" && row.isError === true);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.toolName).toBe("bash");
  });

  it("derives the model from the journal rather than reporting it unavailable", () => {
    // `session_init.resolvedModel` is "9router/cx/gpt-6-luna:high"; the `model_change`
    // record is the authority and wins, with no thinking-level suffix.
    expect(transcript.model).toBe("9router/cx/gpt-6-luna");
  });

  it("reads the durable task and agent name from session_init", () => {
    expect(transcript.task).toContain("Complete assignment thoroughly");
    expect(transcript.agentName).toBe("caw-deepseek");
  });

  it("never renders the journal's own container records as rows (the load-bearing claim)", () => {
    // The file really does contain the header literal, exactly once.
    expect(readFixture("real-subagent-LaneLockCheck.jsonl")).toContain('{"type":"session"');
    // The records that are pure container/bookkeeping — the `session` header,
    // `session_init`, the `custom` markers and the 255-byte `title` slot — carry no
    // row at all, so neither their ids nor their JSON can surface. (`model_change`
    // and `thinking_level_change` DO get a notice row by long-standing reducer
    // behaviour, `apps/web/src/transcript.ts:311-321` — that is content, not JSON.)
    const containerIds: Record<string, true> = {
      "01a19003-9062-72ea-8027-94f1c87616e7": true, // session header
      "81179d17": true, // session_init
      "53e9626a": true, // custom: system-prompt-digest
      "924db39c": true, // custom: tool_execution_start
      "4887aa0c": true, // custom: tool_execution_start
      "72993b1d": true, // custom: session_exit
    };
    for (const row of transcript.rows) {
      expect(row.text).not.toContain('{"type":"session"');
      expect(containerIds[row.id]).toBeUndefined();
      expect(row.text).not.toContain("system-prompt-digest");
      expect(row.text).not.toContain("tool_execution_start");
    }
    // Scope of the claim: this is about *rendering the journal*, not about content.
    // A subagent that greps its own session file legitimately prints journal JSON
    // inside a tool result — that text is the tool's output and is kept verbatim.
    // Exactly two rows carry it here, both for that reason: one tool result and the
    // assistant reply that quotes it.
    expect(transcript.rows.filter((row) => row.text.includes('{"type":"model_change"')).map((row) => row.role)).toEqual(["tool", "assistant"]);
  });
});

describe("line decoding", () => {
  it("skips blank lines without counting them, and counts unreadable ones", () => {
    const { entries, unreadableRecords } = parseNativeEntries('{"a":1}\n\n   \nnot json\n[1,2]\nnull\n7\n{"b":2}');
    expect(entries).toEqual([{ a: 1 }, { b: 2 }]);
    // Four non-object lines: bad JSON, an array, `null`, and a bare number.
    expect(unreadableRecords).toBe(4);
  });

  it("never throws on input that is not JSONL at all", () => {
    expect(parseNativeEntries("<html>not a journal</html>")).toEqual({ entries: [], unreadableRecords: 1 });
    expect(parseNativeEntries("")).toEqual({ entries: [], unreadableRecords: 0 });
  });

  it("builds rows through the conversation reducer's own entry projection", () => {
    const { entries } = parseNativeEntries(readFixture("native-edge-cases.jsonl"));
    const rows = nativeRows(entries);
    // Same function the conversation uses, so the two views cannot drift.
    expect(rows.map((row) => row.id)).toContain("u1");
    expect(rows.map((row) => row.role)).toContain("user");
  });
});

describe("synthesized edge cases", () => {
  const transcript = wholeFile("native-edge-cases.jsonl");

  it("counts the malformed line and keeps every other row intact", () => {
    expect(transcript.unreadableRecords).toBe(1);
    // Blank lines are not records that went missing.
    expect(readFixture("native-edge-cases.jsonl").split("\n").filter((line) => line.trim() === "").length).toBeGreaterThan(0);
    expect(transcript.rows.map((row) => row.id)).toEqual(["mc1", "tl1", "mc2", "u1", "a1", "tr1", "a2", "tr2", "a3"]);
  });

  it("takes the LAST model_change, not the first", () => {
    expect(readFixture("native-edge-cases.jsonl")).toContain('"model":"provider/first-model"');
    expect(transcript.model).toBe("provider/second-model");
  });

  it("pairs a tool result with its call and keeps the failure flag", () => {
    const paired = pairToolArguments(transcript.rows);
    const read = transcript.rows.find((row) => row.toolName === "read")!;
    const failing = transcript.rows.find((row) => row.toolName === "bash")!;
    expect(argumentsFor(read, paired)).toMatchObject({ path: "/workspace/project/journal.jsonl" });
    expect(argumentsFor(failing, paired)).toMatchObject({ command: "exit 3" });
    expect(failing.isError).toBe(true);
    // The reducer propagates the record's own boolean (`apps/web/src/transcript.ts:354`),
    // and the journal says `false` for this one: a success is never marked failed.
    expect(read.isError).toBe(false);
    // The `custom: tool_execution_start` records must not double the tool rows.
    expect(transcript.rows.filter((row) => row.role === "tool")).toHaveLength(2);
  });

  it("reads task, agent name and model from session_init when no model_change follows", () => {
    expect(transcript.task).toBe("Inspect the fixture and report the record vocabulary.");
    expect(transcript.agentName).toBe("scout");
  });
});

describe("a journal with no session_init", () => {
  it("reports the absent task and agent as null, and still derives the model", () => {
    const transcript = wholeFile("native-no-session-init.jsonl");
    expect(transcript.task).toBeNull();
    expect(transcript.agentName).toBeNull();
    expect(transcript.model).toBe("provider/only-model");
    expect(transcript.rows.length).toBeGreaterThan(0);
  });
});

describe("carry: a trailing partial record", () => {
  const raw = readFixture("native-partial-tail.jsonl");

  it("marks the reply incomplete without emitting a row for the partial", () => {
    const reply = splitAtLastNewline(raw);
    expect(reply.carry).not.toBe("");
    const transcript = agentTranscriptFromReply(reply);
    expect(transcript.complete).toBe(false);
    // The partial's text exists nowhere as a row.
    expect(transcript.rows.some((row) => row.text.includes("was cut mid-write"))).toBe(false);
    // The complete rows before it are unaffected.
    const complete = wholeFile("native-edge-cases.jsonl");
    expect(transcript.rows.map((row) => row.id)).toEqual(complete.rows.map((row) => row.id));
  });

  it("does not double a record when the carry is appended to the text", () => {
    const reply = splitAtLastNewline(raw);
    const textOnly = agentTranscriptFromReply({ text: reply.text, newSize: reply.newSize, carry: "" });
    // The wrong call — carrying the partial into the parse — must still not grow the
    // row list. `carry` is never a whole record, so it can only add an unreadable
    // count, never a duplicate row.
    const concatenated = agentTranscriptFromReply({ text: reply.text + reply.carry, newSize: reply.newSize, carry: "" });
    expect(concatenated.rows).toEqual(textOnly.rows);
  });
});

describe("repeated polling", () => {
  it("re-parsing identical bytes is deep-equal, so an unchanged cursor cannot duplicate rows", () => {
    const first = wholeFile("native-edge-cases.jsonl");
    const second = wholeFile("native-edge-cases.jsonl");
    expect(second).toEqual(first);
  });

  it("a grown text appends rows without renumbering or repeating the earlier ones", () => {
    // The two fixtures are the same journal at two moments: `...-complete` is what
    // the file looked like once the record that was cut mid-write had been written
    // whole. `complete` must therefore be the truncated one's rows plus exactly one.
    const partial = agentTranscriptFromReply(splitAtLastNewline(readFixture("native-partial-tail.jsonl")));
    const completed = wholeFile("native-partial-tail-complete.jsonl");
    expect(partial.complete).toBe(false);
    expect(completed.complete).toBe(true);
    expect(completed.rows.length).toBe(partial.rows.length + 1);
    expect(completed.rows.slice(0, partial.rows.length).map((row) => row.id)).toEqual(partial.rows.map((row) => row.id));
    // The record that arrived late is the one that was pending, and it is a real row now.
    expect(completed.rows.at(-1)!.text).toContain("cut mid-write");
  });
});
