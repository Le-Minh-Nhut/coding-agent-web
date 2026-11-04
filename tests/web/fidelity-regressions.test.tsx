// @vitest-environment jsdom
/**
 * Two information-fidelity regressions found by adversarial review, tested at
 * the boundary where they were wrong: the transcript model's `displayMessage`
 * for hidden system entries, and `MessageRow`'s block/error-text choice.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { SessionEntry } from "@caw/collab-protocol";
import { transcriptMessagesFromEntries } from "../../apps/web/src/transcript.js";
import { MessageRow } from "../../apps/web/src/components/ConversationView.js";

const customEntry = (overrides: Partial<Extract<SessionEntry, { type: "custom_message" }>>): SessionEntry => ({
  type: "custom_message",
  id: "custom-1",
  parentId: null,
  timestamp: "2026-01-01T00:00:00Z",
  customType: "collab-nudge",
  content: "NUDGE_SENTINEL internal system chatter",
  display: false,
  ...overrides,
} as SessionEntry);

const assistantEntry = (
  stopReason: "error" | "aborted",
  overrides: Record<string, unknown> = {},
): SessionEntry => ({
  type: "message",
  id: `assistant-${stopReason}`,
  parentId: null,
  timestamp: "2026-01-01T00:00:01Z",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "CONTENT_BLOCK_SENTINEL" },
      { type: "toolCall", id: "tc1", name: "bash", arguments: { cmd: "pwd" }, intent: "inspect cwd" },
    ],
    model: "provider/model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
    stopReason,
    timestamp: 1,
    ...overrides,
  },
} as SessionEntry);

describe("hidden custom entries stay hidden", () => {
  afterEach(cleanup);

  it("drops a custom_message with display:false and one with display absent", () => {
    const rows = transcriptMessagesFromEntries([
      customEntry({ id: "hidden-false", display: false }),
      customEntry({ id: "hidden-absent", display: undefined as never }),
    ]);

    expect(rows).toEqual([]);
    const view = render(<>{rows.map((message) => <MessageRow key={message.id} message={message} />)}</>);
    expect(view.container.textContent).not.toContain("NUDGE_SENTINEL");
    expect(view.container.querySelector(".message-card")).toBeNull();
  });

  it("still renders a displayed custom_message as a notice carrying its text and details", () => {
    const rows = transcriptMessagesFromEntries([
      customEntry({ id: "shown", display: true, customType: "saved_execution", content: "SHOWN_SENTINEL", details: { exitCode: 17 } }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("notice");
    const view = render(<MessageRow message={rows[0]!} />);
    expect(view.container.textContent).toContain("SHOWN_SENTINEL");
    expect(view.container.textContent).toContain("exitCode");
    expect(view.container.textContent).toContain("17");
  });

  it("renders a collab-prompt as a user row whatever display says", () => {
    const rows = transcriptMessagesFromEntries([
      customEntry({ id: "prompt-hidden", customType: "collab-prompt", content: "PROMPT_SENTINEL", display: false }),
      customEntry({ id: "prompt-absent", customType: "collab-prompt", content: "PROMPT_ABSENT_SENTINEL", display: undefined as never }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.role)).toEqual(["user", "user"]);
    const view = render(<>{rows.map((message) => <MessageRow key={message.id} message={message} />)}</>);
    expect(view.container.textContent).toContain("PROMPT_SENTINEL");
    expect(view.container.textContent).toContain("PROMPT_ABSENT_SENTINEL");
  });
});

describe("an assistant failure reason survives the durable entry", () => {
  afterEach(cleanup);

  it("renders both the content blocks and the exact errorMessage when stopReason is error", () => {
    const rows = transcriptMessagesFromEntries([
      assistantEntry("error", { errorMessage: "ASSISTANT_FAILURE_SENTINEL upstream 503" }),
    ]);
    expect(rows).toHaveLength(1);
    const view = render(<MessageRow message={rows[0]!} />);

    expect(view.container.textContent).toContain("CONTENT_BLOCK_SENTINEL");
    expect(view.container.textContent).toContain("[Tool call: bash");
    expect(view.container.textContent).toContain("ASSISTANT_FAILURE_SENTINEL upstream 503");
  });

  it("renders both the content blocks and the abort notice when stopReason is aborted", () => {
    const rows = transcriptMessagesFromEntries([assistantEntry("aborted")]);
    expect(rows).toHaveLength(1);
    const view = render(<MessageRow message={rows[0]!} />);

    expect(view.container.textContent).toContain("CONTENT_BLOCK_SENTINEL");
    expect(view.container.textContent).toContain("Assistant response aborted");
  });

  it("states a generic failure rather than showing nothing when the host sent no message", () => {
    const rows = transcriptMessagesFromEntries([assistantEntry("error")]);
    const view = render(<MessageRow message={rows[0]!} />);

    expect(view.container.textContent).toContain("CONTENT_BLOCK_SENTINEL");
    expect(view.container.textContent).toContain("Assistant response failed");
  });

  it("adds no failure text to a successful assistant row", () => {
    const rows = transcriptMessagesFromEntries([{
      type: "message",
      id: "ok",
      parentId: null,
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "CONTENT_BLOCK_SENTINEL" }],
        model: "provider/model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
    } as SessionEntry]);
    const view = render(<MessageRow message={rows[0]!} />);

    expect(view.container.textContent).toContain("CONTENT_BLOCK_SENTINEL");
    expect(view.container.textContent).not.toContain("Assistant response failed");
  });
});
