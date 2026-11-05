// @vitest-environment jsdom
/**
 * The agent-detail chat surface.
 *
 * Asserted against behaviour the owner named, not markup: the row window is
 * bounded and says how much is hidden, prepending earlier rows holds the reading
 * position, `carry` is displayed but never becomes a row, an unreadable count is
 * stated separately from emptiness, the tabs are keyboard-navigable without losing
 * the chat, the Results tab states absence instead of inventing a payload, and the
 * raw session bytes are not in the default view.
 *
 * The last claim is checked against the real captured subagent journal, because it
 * is a claim about the real record vocabulary — a synthesized file would only prove
 * the synthesizer agrees with itself.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AgentChat } from "../../apps/web/src/components/AgentChat.js";
import { agentTranscriptFromReply } from "../../apps/web/src/agent-transcript.js";
import type { TranscriptMessage } from "../../apps/web/src/transcript.js";

afterEach(cleanup);

const REAL_JOURNAL = readFileSync(
  resolve(__dirname, "../fixtures/omp-session/real-subagent-LaneLockCheck.jsonl"),
  "utf8",
);

/** Structurally valid rows; identity is not under test here, ordering and count are. */
function assistantRows(count: number): TranscriptMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `row-${index}`,
    identity: `row-${index}`,
    role: "assistant" as const,
    text: `reply number ${index}`,
    source: "entry" as const,
  }));
}

function renderChat(props: Partial<React.ComponentProps<typeof AgentChat>> = {}) {
  return render(
    <AgentChat
      rows={[]}
      carry=""
      unreadableRecords={0}
      hasRawText
      rawText=""
      emptyReason={null}
      {...props}
    />,
  );
}

const scroller = (container: HTMLElement): HTMLElement => {
  const element = container.querySelector(".agent-chat-scroll");
  if (element === null) throw new Error("no .agent-chat-scroll in the component");
  return element as HTMLElement;
};

/** Give the scroller the geometry jsdom does not compute, derived from its rows. */
function modelGeometry(element: HTMLElement, rowHeight = 40, clientHeight = 200): void {
  Object.defineProperty(element, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => element.querySelectorAll(".message-card").length * rowHeight,
  });
}

describe("the chat window is bounded and says so", () => {
  it("mounts the last 100 rows, states how many are hidden, and prepends in 100s", () => {
    const { container } = renderChat({ rows: assistantRows(250) });

    expect(container.querySelectorAll(".message-card")).toHaveLength(100);
    expect(screen.getByText("reply number 249")).toBeTruthy();
    expect(screen.queryByText("reply number 149")).toBeNull();
    expect(screen.getByText("150 earlier records are not shown.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show 100 earlier" }));
    expect(container.querySelectorAll(".message-card")).toHaveLength(200);
    // The rows that were on screen are still there — prepending must not renumber.
    expect(screen.getByText("reply number 249")).toBeTruthy();
    expect(screen.getByText("reply number 149")).toBeTruthy();
    expect(screen.queryByText("reply number 149".replace("149", "48"))).toBeNull();
    // The control reports the remaining amount, and vanishes once nothing is hidden.
    expect(screen.getByText("50 earlier records are not shown.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show 50 earlier" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show 50 earlier" }));
    expect(container.querySelectorAll(".message-card")).toHaveLength(250);
    expect(screen.queryByRole("button", { name: /Show .* earlier/ })).toBeNull();
    expect(screen.getByText("reply number 0")).toBeTruthy();
  });

  it("holds the reading position when earlier rows are prepended", () => {
    const { container } = renderChat({ rows: assistantRows(250) });
    const element = scroller(container);
    modelGeometry(element);

    // The user scrolls up and away from the tail, then asks for the older rows.
    element.scrollTop = 50;
    fireEvent.scroll(element);
    const heightBefore = element.scrollHeight;

    fireEvent.click(screen.getByRole("button", { name: "Show 100 earlier" }));

    // 100 earlier rows went in ABOVE: the offset must grow by exactly the height
    // they added, otherwise the row being read jumps off screen by that amount.
    expect(element.scrollTop).toBe(50 + (element.scrollHeight - heightBefore));
    expect(element.scrollTop).toBe(4050);
  });
});

describe("carry is displayed and never parsed", () => {
  it("adds no row for a partial record", () => {
    const { container } = renderChat({ rows: assistantRows(3), carry: '{"type":"message","id":"ha' });

    // Three rows in, three rows out: the carry is not a fourth.
    expect(container.querySelectorAll(".message-card")).toHaveLength(3);
    expect(screen.getByText("reply number 2")).toBeTruthy();
    expect(screen.getByText("streaming…")).toBeTruthy();
    const note = container.querySelector(".agent-chat-carry");
    expect(note?.textContent).toContain('{"type":"message","id":"ha');
  });

  it("shows only the first line of the partial record", () => {
    const { container } = renderChat({ carry: "first line\nsecond line that must not appear" });
    const note = container.querySelector(".agent-chat-carry");
    expect(note?.textContent).toContain("first line");
    expect(note?.textContent).not.toContain("second line");
  });
});

describe("an unreadable record and an empty session are different facts", () => {
  it("states the unreadable count and still shows what could be read", () => {
    renderChat({ rows: assistantRows(2), unreadableRecords: 3 });
    expect(screen.getByText("3 records in this session file could not be read. Everything below that could be read is shown.")).toBeTruthy();
    expect(screen.getByText("reply number 1")).toBeTruthy();
    expect(screen.queryByText(/no conversational records/)).toBeNull();
  });

  it("singularizes a count of one", () => {
    renderChat({ unreadableRecords: 1 });
    expect(screen.getByText("1 record in this session file could not be read. Everything below that could be read is shown.")).toBeTruthy();
  });

  it("says the session has no conversational records when bytes arrived but decoded to none", () => {
    renderChat({ rows: [], hasRawText: true, unreadableRecords: 0 });
    expect(screen.getByText("This session contains no conversational records yet.")).toBeTruthy();
  });

  it("does not claim the session is empty when records were merely unreadable", () => {
    renderChat({ rows: [], hasRawText: true, unreadableRecords: 2 });
    expect(screen.queryByText("This session contains no conversational records yet.")).toBeNull();
    expect(screen.getByText(/could not be read/)).toBeTruthy();
  });

  it("says no bytes arrived when none did", () => {
    renderChat({ rows: [], hasRawText: false });
    expect(screen.getByText("No transcript bytes have been received for this agent yet.")).toBeTruthy();
  });

  it("lets the caller's own reason win", () => {
    renderChat({ rows: [], hasRawText: false, emptyReason: "No session file was reported for this agent." });
    expect(screen.getByText("No session file was reported for this agent.")).toBeTruthy();
    expect(screen.queryByText("No transcript bytes have been received for this agent yet.")).toBeNull();
  });

  it("never describes an unreadable session as the agent having said nothing", () => {
    const { container } = renderChat({ rows: [], hasRawText: true, unreadableRecords: 4 });
    expect(container.textContent ?? "").not.toMatch(/said nothing|remained silent|no output/i);
  });
});

describe("tabs", () => {
  const chatText = "a committed reply";

  it("is a real tablist and starts on Chat", () => {
    renderChat({ rows: [{ id: "a", identity: "a", role: "assistant", text: chatText, source: "entry" }] });
    const list = screen.getByRole("tablist", { name: "Agent transcript views" });
    expect(list).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("false");
  });

  it("moves with the arrow keys and follows the selection with focus", () => {
    renderChat({ rows: [{ id: "a", identity: "a", role: "assistant", text: chatText, source: "entry" }] });
    const list = screen.getByRole("tablist");

    screen.getByRole("tab", { name: "Chat" }).focus();
    fireEvent.keyDown(list, { key: "ArrowRight" });
    const activity = screen.getByRole("tab", { name: "Activity" });
    expect(activity.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(activity);

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");

    // Wraps, rather than sticking at the last tab.
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "End" });
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");
  });

  it("every tab's aria-controls names a panel that is actually in the DOM", () => {
    // The bug this locks out: Activity and Results used to be conditionally
    // rendered, so while Chat was selected `aria-controls` on those two tabs
    // pointed at ids that did not exist - the association was advertised and
    // broken. Each panel is now mounted with `hidden`, so the target always
    // resolves; and `hidden` (not absence) is what the DOM must show.
    const { container } = renderChat({
      rows: [
        { id: "a", identity: "a", role: "assistant", text: chatText, source: "entry" },
        { id: "y", identity: "y", role: "tool", text: "done", toolName: "yield", isError: false, source: "entry" },
      ],
    });

    for (const tab of screen.getAllByRole("tab")) {
      const controls = tab.getAttribute("aria-controls");
      expect(controls, `${tab.textContent} has no aria-controls`).toBeTruthy();
      const panel = document.getElementById(controls!);
      expect(panel, `${tab.textContent} -> #${controls} is not in the DOM`).not.toBeNull();
      expect(panel!.getAttribute("role")).toBe("tabpanel");
    }

    // Exactly one panel is showing, and it is the selected tab's.
    const shown = [...container.querySelectorAll(".agent-chat-panel")].filter((panel) => !(panel as HTMLElement).hidden);
    expect(shown).toHaveLength(1);
    const selected = screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")!;
    expect(shown[0]!.id).toBe(selected.getAttribute("aria-controls"));

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    const shownAfter = [...container.querySelectorAll(".agent-chat-panel")].filter((panel) => !(panel as HTMLElement).hidden);
    expect(shownAfter).toHaveLength(1);
    expect(shownAfter[0]!.id).toBe(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-controls"));
    expect(screen.getByRole("tabpanel", { name: "Activity" })).toBeTruthy();
  });

  it("keeps the chat mounted and its rows intact across a tab switch", () => {
    const { container } = renderChat({
      rows: [
        { id: "a", identity: "a", role: "assistant", text: chatText, source: "entry" },
        { id: "b", identity: "b", role: "tool", text: "bash output", toolName: "bash", isError: false, source: "entry" },
      ],
    });
    const before = container.querySelectorAll(".message-card").length;

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    // Still in the tree, not rebuilt: the same nodes are there when Chat returns.
    expect(container.querySelectorAll(".message-card")).toHaveLength(before);
    expect(screen.getByText(chatText)).toBeTruthy();
    expect(screen.getByRole("tabpanel", { name: "Activity" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(container.querySelectorAll(".message-card")).toHaveLength(before);
    expect(screen.getByText(chatText)).toBeTruthy();
  });

  it("restores the chat's scroll offset when Chat is shown again", () => {
    const { container } = renderChat({ rows: assistantRows(25) });
    const element = scroller(container);
    // Content much taller than the box, so the reader can genuinely detach from
    // the tail — at the box's own height the component is right to stay in
    // tail-follow mode and there would be nothing to restore.
    modelGeometry(element, 40, 100);

    element.scrollTop = 300;
    fireEvent.scroll(element);
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    element.scrollTop = 0;
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(element.scrollTop).toBe(300);
  });
});

describe("the Activity tab reads the session's own records", () => {
  it("lists one line per tool result, in order, with the row's own error flag", () => {
    renderChat({
      rows: [
        { id: "u", identity: "u", role: "user", text: "do the thing", source: "entry" },
        { id: "t1", identity: "t1", role: "tool", text: "read ok", toolName: "read", isError: false, source: "entry" },
        { id: "t2", identity: "t2", role: "tool", text: "command failed", toolName: "bash", isError: true, source: "entry" },
      ],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));

    const lines = screen.getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain("read");
    expect(lines[0]?.textContent).toContain("not reported as failed");
    expect(lines[1]?.textContent).toContain("bash");
    expect(lines[1]?.textContent).toContain("failed");
    expect(lines[1]?.className).toContain("failed");
  });

  it("states plainly when the session recorded no tool results", () => {
    renderChat({ rows: [{ id: "u", identity: "u", role: "user", text: "hello", source: "entry" }] });
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByText("This session's records contain no tool results.")).toBeTruthy();
  });

  it("invents no duration", () => {
    const { container } = renderChat({
      rows: [{ id: "t", identity: "t", role: "tool", text: "ok", toolName: "bash", isError: false, source: "entry" }],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(container.textContent ?? "").not.toMatch(/\d+\s?(ms|s|seconds|minutes) ago/);
  });
});

describe("the Results tab states absence rather than inventing a payload", () => {
  it("says the session recorded no completion payload", () => {
    renderChat({ rows: [{ id: "t", identity: "t", role: "tool", text: "ok", toolName: "bash", isError: false, source: "entry" }] });
    fireEvent.click(screen.getByRole("tab", { name: "Results" }));
    expect(screen.getByText("This session recorded no completion payload.")).toBeTruthy();
  });

  it("shows the payload a yield result actually carried, verbatim", () => {
    const { container } = renderChat({
      rows: [{
        id: "y",
        identity: "y",
        role: "tool",
        text: 'Result submitted.\n{"status": "success"}',
        toolName: "yield",
        isError: false,
        source: "entry",
        toolResult: {
          content: [{ type: "text", text: "Result submitted." }],
          details: { status: "success", data: { summary: "it works", root_cause: "a cause", fix: "a fix" } },
        },
      }],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Results" }));

    const payload = container.querySelector(".agent-chat-result")?.textContent ?? "";
    expect(payload).toContain('"root_cause": "a cause"');
    expect(payload).toContain('"fix": "a fix"');
    expect(container.textContent).toContain("status: success");
  });
});

describe("against the real captured subagent journal", () => {
  const parsed = agentTranscriptFromReply({
    text: REAL_JOURNAL,
    newSize: Buffer.byteLength(REAL_JOURNAL),
    carry: "",
  });

  it("parses the real file into conversation rows", () => {
    expect(parsed.unreadableRecords).toBe(0);
    expect(parsed.complete).toBe(true);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.some((row) => row.role === "user")).toBe(true);
    expect(parsed.rows.some((row) => row.role === "assistant")).toBe(true);
    expect(parsed.rows.some((row) => row.role === "tool")).toBe(true);
  });

  it("puts no session header or title slot in the default view", () => {
    const { container } = renderChat({ rows: parsed.rows, rawText: REAL_JOURNAL });
    const chatPanel = container.querySelectorAll(".agent-chat-panel")[0];
    const text = chatPanel?.textContent ?? "";

    expect(text).not.toContain('{"type":"session"');
    expect(text).not.toContain('{"type":"title"');
    // Nor any other raw container record: those are what the Diagnostics view is for.
    expect(text).not.toMatch(/\{"type":"(session_init|title|model_usage|ttsr_injection)"/);
    // The real conversation is there, though.
    expect(text).toContain("Model changed:");
    expect(text.length).toBeGreaterThan(0);
  });

  it("keeps the raw bytes out of the DOM until Diagnostics is opened", () => {
    const { container } = renderChat({ rows: parsed.rows, rawText: REAL_JOURNAL });
    expect(container.querySelector(".agent-chat-raw pre")).toBeNull();
    expect(container.textContent).not.toContain('{"type":"session"');

    const details = container.querySelector(".agent-chat-raw") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle", { bubbles: false }));

    const pre = container.querySelector(".agent-chat-raw pre");
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toContain('{"type":"session"');
    // The disclosure says what the raw view is, so it cannot be read as a transcript.
    expect(container.querySelector(".agent-chat-raw summary")?.textContent).toContain("not a transcript");
  });
});
