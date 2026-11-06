// @vitest-environment jsdom
/**
 * One tool execution must produce one visual representation.
 *
 * The defect: an assistant message that *requests* a tool carries a `toolCall`
 * block (`transcript.ts:250`), and `MessageRow` rendered that block as its own
 * raw card — `[Tool call: bash — …]` plus the full JSON arguments — while the
 * *result* row for the same call id was separately folded into a grouped activity
 * card. So one `bash` execution appeared twice on screen, once as unreadable JSON
 * and once as the summary the user actually wants.
 *
 * The fix keeps the authoritative transcript untouched: the result row remains the
 * single place the execution is shown, and the request block contributes nothing
 * to the conversation view (its data is still reachable through the tool row's own
 * details, which carry the paired arguments).
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { MessageRow, TranscriptList } from "../../apps/web/src/components/MessageRow.js";
import type { ToolActivityRow } from "../../apps/web/src/tool-activity.js";
import { createTranscriptState, reduceHostFrame } from "../../apps/web/src/transcript.js";
import type { TranscriptBlock } from "../../apps/web/src/transcript.js";

afterEach(cleanup);

/** An assistant turn that asks for one command, followed by its result row. */
function transcript(): ToolActivityRow[] {
  return [
    {
      id: "a1",
      role: "assistant",
      text: "Running the checks.",
      blocks: [
        { type: "text", text: "Running the checks." },
        { type: "toolCall", name: "bash", arguments: { command: "pnpm typecheck" }, intent: "Typecheck", id: "tc1" },
      ],
      source: "entry",
    } as ToolActivityRow,
    {
      id: "t1",
      role: "tool",
      text: "exit 0",
      toolName: "bash",
      toolCallId: "tc1",
      source: "entry",
      toolResult: { content: [{ type: "text", text: "exit 0" }], details: {} },
      toolArgs: { command: "pnpm typecheck" },
    } as ToolActivityRow,
  ];
}

describe("one tool execution, one representation", () => {
  it("does not render a raw tool-call card beside the grouped tool row", () => {
    const { container } = render(<TranscriptList rows={transcript()} />);
    const text = container.textContent ?? "";

    // The duplicate: a JSON dump of the request next to the summary of the same call.
    expect(text).not.toContain("[Tool call:");
    expect(text).not.toContain('"command"');

    // The execution is still shown — exactly once, as the group the user reads.
    expect(container.querySelectorAll(".activity-group").length).toBe(1);
    // The collapsed group states the category and the count, which is the whole
    // point of the summary: "Run 1 command", not a JSON dump of the request.
    expect(text).toContain("Run 1 command");
  });

  it("keeps the assistant's own prose, which is not part of the duplicate", () => {
    const { container } = render(<MessageRow message={transcript()[0]! as never} />);
    // Only the *tool-call* block is suppressed; the text around it must survive.
    expect(container.textContent).toContain("Running the checks.");
  });

  it("keeps the tool request when nothing else on screen records it", () => {
    // Read-only views (saved history, a host-shared journal) can carry a request
    // with no result row. Suppressing it there would delete the only trace of the
    // call, so the request must render as itself.
    const orphan = [{
      id: "a2", role: "assistant", text: "", source: "entry",
      blocks: [
        { type: "text", text: "" },
        { type: "toolCall", name: "read", arguments: { path: "/tmp/notes.md" }, id: "tc-orphan" },
      ],
    }] as unknown as ToolActivityRow[];
    const { container } = render(<TranscriptList rows={orphan} />);
    const text = container.textContent ?? "";
    expect(text).toContain("[Tool call: read");
    expect(text).toContain("/tmp/notes.md");
  });

  it("never drops a request that has no id to pair on", () => {
    const unpaired = [{
      id: "a3", role: "assistant", text: "", source: "entry",
      blocks: [{ type: "toolCall", name: "grep", arguments: { pattern: "needle" } }],
    }] as unknown as ToolActivityRow[];
    const { container } = render(<TranscriptList rows={unpaired} />);
    // Without an id the wire cannot pair it, so it is always shown.
    expect(container.textContent).toContain("[Tool call: grep");
  });

  it("still exposes the command through the tool row's own details", () => {
    const { container, getByRole } = render(<TranscriptList rows={transcript()} />);
    const group = container.querySelector(".activity-group")!;
    fireEvent.click(group.querySelector(".activity-group-head") as HTMLElement);
    const row = container.querySelector(".tool-row")!;
    fireEvent.click(row.querySelector(".tool-row-head") as HTMLElement);
    // The arguments are reachable on demand, not printed by default.
    fireEvent.click(getByRole("button", { name: /View tool details|Hide tool details/ }));
    expect(container.textContent).toContain("pnpm typecheck");
  });
});

// ── The live (streamed) path ────────────────────────────────────────────────
//
// The first cut of this fix only covered rows that carry `blocks`. A live turn
// arrives as a wire message whose assistant content is flattened into `text`
// (`transcript.ts:244`), so the raw `[Tool call: …] {json}` sat inside the row
// text while the result row was grouped as activity — the same execution twice,
// on the view the user watches. This is the audit's D1.
describe("a streamed turn shows its tool call once", () => {
  it("does not print the flattened call beside the activity group", () => {
    // A real wire sequence: the assistant asks for a command, then the result.
    let state = createTranscriptState();
    state = reduceHostFrame(state, {
      t: "event", event: {
        type: "message_end", message: {
          role: "assistant", content: [
            { type: "text", text: "Running the checks." },
            { type: "toolCall", id: "tc-live", name: "bash", arguments: { command: "pnpm typecheck" }, intent: "Typecheck" },
          ],
        },
      },
    } as never);
    state = reduceHostFrame(state, {
      t: "event", event: {
        type: "tool_execution_start", toolCallId: "tc-live", toolName: "bash", args: { command: "pnpm typecheck" },
      },
    } as never);
    state = reduceHostFrame(state, {
      t: "event", event: {
        type: "tool_execution_end", toolCallId: "tc-live", toolName: "bash", result: { content: [{ type: "text", text: "exit 0" }] }, isError: false,
      },
    } as never);

    const { container } = render(<TranscriptList rows={state.messages as never} />);
    const text = container.textContent ?? "";
    // Once the result is on screen, the request must not also be dumped as JSON.
    expect(text).not.toContain("[Tool call:");
    expect(text).not.toContain('"command"');
    // The execution is still visible exactly once.
    expect(container.querySelectorAll(".activity-group").length).toBe(1);
    expect(text).toContain("Run 1 command");
  });

  it("keeps the assistant's prose intact on the live path", () => {
    let state = createTranscriptState();
    state = reduceHostFrame(state, {
      t: "event", event: {
        type: "message_end", message: {
          role: "assistant", content: [
            { type: "text", text: "Running the checks." },
            { type: "toolCall", id: "tc-live", name: "bash", arguments: { command: "pnpm typecheck" } },
          ],
        },
      },
    } as never);
    const { container } = render(<TranscriptList rows={state.messages as never} />);
    expect(container.textContent).toContain("Running the checks.");
  });
});

// ── An error turn keeps its reason on both paths ────────────────────────────
//
// Adding `blocks` to live assistant rows made the renderer draw blocks instead of
// text. A failed turn with no content had blocks but nothing in them, so the row
// emptied and the failure reason was lost — the regression this pins.
describe("a live failure still shows its reason", () => {
  it("renders the error even when the turn produced no content blocks", () => {
    let state = createTranscriptState();
    state = reduceHostFrame(state, {
      t: "event", event: {
        type: "message_end", message: {
          role: "assistant", content: [], stopReason: "error", errorMessage: "Provider quota exhausted",
        },
      },
    } as never);
    const { container } = render(<TranscriptList rows={state.messages as never} />);
    expect(container.textContent).toContain("Provider quota exhausted");
    expect(container.querySelectorAll(".message-card.assistant").length).toBe(1);
  });

  it("keeps the refusal reason when that message also contains a tool call", () => {
    let state = createTranscriptState();
    state = reduceHostFrame(state, {
      t: "event", event: {
        type: "message_end", message: {
          role: "assistant", stopReason: "error", errorMessage: "Context window exceeded",
          content: [{ type: "toolCall", id: "tc-x", name: "bash", arguments: { command: "ls" } }],
        },
      },
    } as never);
    const { container } = render(<TranscriptList rows={state.messages as never} />);
    // The orphan call still prints, and the reason did not get displaced by it.
    expect(container.textContent).toContain("Context window exceeded");
  });
});
