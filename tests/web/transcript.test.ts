import { describe, expect, it } from "vitest";
import type { AgentSnapshot, AssistantMessage, HostFrame, SessionEntry, SessionState } from "@caw/collab-protocol";
import {
  createTranscriptState,
  reduceHostFrame,
  trackTranscriptRequest,
  clearTranscriptRequests,
  forgetTranscriptRequest,
  type TranscriptState,
} from "../../apps/web/src/transcript.js";

function message(timestamp: number, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "provider/model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
    stopReason: "stop",
    timestamp,
  };
}

function entry(id: string, timestamp: number, text: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: message(timestamp, text),
  };
}

function sessionState(isStreaming = false): SessionState {
  return { isStreaming, queuedMessageCount: 0, cwd: "/workspace", participants: [] };
}

function welcome(entryCount: number, isStreaming = false): HostFrame {
  return {
    t: "welcome",
    proto: 3,
    header: { type: "session", id: "native-session", cwd: "/workspace", timestamp: "2026-10-25T00:00:00Z" },
    state: sessionState(isStreaming),
    agents: [] as AgentSnapshot[],
    entryCount,
  };
}

function apply(state: TranscriptState, frame: HostFrame): TranscriptState {
  return reduceHostFrame(state, frame);
}

describe("Collab transcript reducer", () => {
  it("restores full history across multiple snapshot chunks in order", () => {
    let state = apply(createTranscriptState(), welcome(3));
    state = apply(state, { t: "snapshot-chunk", entries: [entry("one", 1, "first")], final: false });
    expect(state.messages).toEqual([]);
    state = apply(state, { t: "snapshot-chunk", entries: [entry("two", 2, "second"), entry("three", 3, "third")], final: true });

    expect(state.entries.map((item) => item.id)).toEqual(["one", "two", "three"]);
    expect(state.messages.map((item) => item.text)).toEqual(["first", "second", "third"]);
  });

  it("keeps live entries and events queued during snapshot and deduplicates overlapping history", () => {
    const matching = message(30, "live event");
    let state = apply(createTranscriptState(), welcome(3));
    state = apply(state, { t: "entry", entry: entry("live", 20, "live row") });
    state = apply(state, { t: "event", event: { type: "message_end", message: matching } });
    state = apply(state, {
      t: "snapshot-chunk",
      entries: [
        entry("history", 10, "history"),
        entry("live", 20, "live row"),
        { type: "message", id: "event-twin", parentId: null, timestamp: "2026-10-25T00:00:00.030Z", message: matching },
      ],
      final: true,
    });

    expect(state.entries.map((item) => item.id)).toEqual(["history", "live", "event-twin"]);
    expect(state.messages.map((item) => item.id)).toEqual(["history", "live", "event-twin"]);
    expect(state.messages.map((item) => item.text)).toEqual(["history", "live row", "live event"]);
  });

  it("renders assistant message_end and its durable entry as one stable row", () => {
    const finalMessage = message(42, "one response");
    let state = apply(createTranscriptState(), {
      t: "event",
      event: { type: "message_end", message: finalMessage },
    });
    state = apply(state, {
      t: "entry",
      entry: { type: "message", id: "entry-42", parentId: null, timestamp: "2026-10-25T00:00:00.042Z", message: finalMessage },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ id: "entry-42", identity: "entry-42", text: "one response", source: "entry" });
  });

  it("keeps distinct durable messages with colliding role and millisecond timestamp", () => {
    let state = createTranscriptState();
    state = apply(state, { t: "entry", entry: entry("first", 42, "first message") });
    state = apply(state, { t: "entry", entry: entry("second", 42, "second message") });

    expect(state.messages.map((item) => item.id)).toEqual(["first", "second"]);
    expect(state.messages.map((item) => item.text)).toEqual(["first message", "second message"]);
    expect(state.messages.map((item) => item.identity)).toEqual(["first", "second"]);
  });

  it("keeps timestamp-colliding live events distinct and replaces them by matching entries", () => {
    let state = apply(createTranscriptState(), { t: "event", event: { type: "message_end", message: message(42, "first") } });
    state = apply(state, { t: "event", event: { type: "message_end", message: message(42, "second") } });
    expect(state.messages).toHaveLength(2);
    state = apply(state, { t: "entry", entry: entry("first-id", 42, "first") });
    state = apply(state, { t: "entry", entry: entry("second-id", 42, "second") });
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((item) => item.id)).toEqual(["first-id", "second-id"]);
  });

  it("pairs repeated identical events with durable rows one-to-one", () => {
    const same = message(42, "same response");
    let state = apply(createTranscriptState(), {
      t: "entry",
      entry: { type: "message", id: "existing-1", parentId: null, timestamp: "2026-10-25T00:00:00.042Z", message: same },
    });
    state = apply(state, {
      t: "entry",
      entry: { type: "message", id: "existing-2", parentId: "existing-1", timestamp: "2026-10-25T00:00:00.042Z", message: same },
    });
    state = apply(state, { t: "event", event: { type: "message_end", message: same } });
    state = apply(state, { t: "event", event: { type: "message_end", message: same } });
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((item) => item.id)).toEqual(["existing-1", "existing-2"]);
  });

  it("reconnect snapshot replaces visible history without duplicating rows", () => {
    let state = apply(createTranscriptState(), welcome(1));
    state = apply(state, { t: "snapshot-chunk", entries: [entry("old", 1, "old")], final: true });
    state = apply(state, { t: "entry", entry: entry("new", 2, "new") });
    state = apply(state, welcome(2));
    state = apply(state, { t: "snapshot-chunk", entries: [entry("old", 1, "old"), entry("new", 2, "new")], final: true });

    expect(state.messages.map((item) => item.id)).toEqual(["old", "new"]);
    expect(state.messages.map((item) => item.text)).toEqual(["old", "new"]);
  });

  it("derives running status from the upstream isStreaming field", () => {
    const state = apply(createTranscriptState(), welcome(0, true));
    expect(state.turnStatus).toBe("running");
  });

  it("correlates transcript response to request agent and preserves errors", () => {
    const state = trackTranscriptRequest(createTranscriptState(), 9, "agent-a");
    const result = apply(state, { t: "transcript", reqId: 9, text: "partial transcript", newSize: 18, error: "read failed" });

    expect(result.transcripts["agent-a"]).toEqual({ text: "", newSize: 0, carry: "", error: "read failed" });
    expect(result.transcriptRequests).toEqual({});
  });

  it("cleans expired and panel-closed transcript request correlations", () => {
    let state = trackTranscriptRequest(createTranscriptState(), 10, "agent-a");
    state = trackTranscriptRequest(state, 11, "agent-b");
    state = forgetTranscriptRequest(state, 10);
    expect(state.transcriptRequests).toEqual({ 11: { agentId: "agent-b", fromByte: 0 } });
    expect(forgetTranscriptRequest(state, 99)).toBe(state);
    expect(clearTranscriptRequests(state).transcriptRequests).toEqual({});
  });

  it("preserves real approval choices and settles without inventing a timeout", () => {
    let state = apply(createTranscriptState(), {
      t: "ui-request",
      request: { reqId: 12, kind: "select", title: "Allow command?", options: ["Approve Once", "Deny"] },
    });
    expect(state.uiRequests.current).toEqual({ reqId: 12, kind: "select", title: "Allow command?", options: ["Approve Once", "Deny"] });
    state = apply(state, { t: "ui-request-end", reqId: 12 });

    expect(state.uiRequests.current).toBeNull();
    expect(state.lastUiRequestSettlement).toBe(12);
    expect(state).not.toHaveProperty("timedOut");
  });

  it("keeps protocol notices, subagent bus updates, and lifecycle events visible", () => {
    let state = createTranscriptState();
    const frames: Array<[HostFrame, string, "info" | "warning" | "error"]> = [
      [{ t: "event", event: { type: "notice", level: "warning", message: "rate limited" } }, "rate limited", "warning"],
      [{ t: "event", event: { type: "auto_compaction_start", reason: "context full", action: "compact" } }, "Compacting context (context full)", "info"],
      [{ t: "event", event: { type: "auto_compaction_end", aborted: false, willRetry: false } }, "Context compacted", "info"],
      [{ t: "event", event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "temporary" } }, "Retry 1/3: temporary", "info"],
      [{ t: "event", event: { type: "auto_retry_end", success: false, attempt: 1, finalError: "retry failed" } }, "retry failed", "error"],
      [{ t: "event", event: { type: "thinking_level_changed", thinkingLevel: "high" } }, "Thinking level: high", "info"],
      [{ t: "bus", channel: "task:subagent:progress", data: { agent: "Scout", task: "inspect", progress: { status: "running" } } }, "Scout: inspect (running)", "info"],
      [{ t: "bus", channel: "task:subagent:lifecycle", data: { id: "sub-1", agent: "Scout", status: "completed", index: 0 } }, "Scout completed", "info"],
    ];
    for (const [frame, message, level] of frames) {
      state = apply(state, frame);
      expect(state.notice).toEqual({ message, level });
    }

    state = apply(state, { t: "event", event: { type: "tool_execution_start", toolCallId: "tc1", toolName: "bash", args: { cmd: "pwd" } } });
    expect(state.messages[0]).toMatchObject({ identity: "tool:tc1", isRunning: true, toolName: "bash" });
    state = apply(state, { t: "event", event: { type: "tool_execution_update", toolCallId: "tc1", toolName: "bash", args: {}, partialResult: "working" } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ isRunning: true, text: '"working"' });
    state = apply(state, { t: "event", event: { type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "done" } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ isRunning: false, text: "done" });
  });
  it("maps failed and aborted subagent bus updates to alert and warning notices without disconnecting", () => {
    let state = apply(createTranscriptState(), {
      t: "welcome", proto: 3,
      header: { type: "session", id: "native-session", cwd: "/workspace", timestamp: "2026-10-25T00:00:00Z" },
      state: sessionState(), agents: [], entryCount: 0,
    });
    state = apply(state, { t: "bus", channel: "task:subagent:progress", data: {
      index: 0, agent: "Scout", task: "inspect", progress: { id: "sub-1", status: "failed", currentTool: "bash" },
    } });
    expect(state.notice).toEqual({ level: "error", message: "Scout: inspect (failed) · bash" });
    expect(state.connectionStatus).toBe("live");

    state = apply(state, { t: "bus", channel: "task:subagent:lifecycle", data: {
      id: "sub-1", agent: "Scout", status: "aborted", index: 0,
    } });
    expect(state.notice).toEqual({ level: "warning", message: "Scout aborted" });
    expect(state.connectionStatus).toBe("live");
  });

  it("preserves visible custom entries and explicitly represents non-text content blocks", () => {
    const frames: HostFrame[] = [
      { t: "entry", entry: {
        type: "custom_message", id: "omitted", parentId: null, timestamp: "2026-10-25T00:00:00Z",
        customType: "collab-entry-too-large", content: "[tool result omitted by host]", display: true,
      } },
      { t: "entry", entry: {
        type: "message", id: "mixed", parentId: null, timestamp: "2026-10-25T00:00:01Z",
        message: {
          role: "assistant", content: [
            { type: "text", text: "Result" },
            { type: "thinking", thinking: "reasoning" },
            { type: "toolCall", id: "tc", name: "bash", arguments: { command: "pwd" } },
            { type: "futureBlock" } as never,
            { type: "text", text: "done" },
          ], model: "provider/model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
          stopReason: "stop", timestamp: 2,
        },
      } },
      { t: "entry", entry: {
        type: "message", id: "image", parentId: "mixed", timestamp: "2026-10-25T00:00:02Z",
        message: { role: "user", content: [
          { type: "text", text: "Inspect this" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ], timestamp: 3 },
      } },
    ];
    const state = frames.reduce(apply, createTranscriptState());
    expect(state.messages).toEqual([
      expect.objectContaining({ id: "omitted", role: "notice", text: "collab-entry-too-large: [tool result omitted by host]" }),
      expect.objectContaining({ id: "mixed", role: "assistant", text: "Result\n[Reasoning]\nreasoning\n[Tool call: bash] {\n  \"command\": \"pwd\"\n}\n[Unsupported content: futureBlock]\ndone" }),
      expect.objectContaining({ id: "image", role: "user", text: "Inspect this\n![Attachment](data:image/png;base64,aGVsbG8=)" }),
    ]);
  });


  it("preserves approval selection metadata through the reducer", () => {
    const request = {
      reqId: 14,
      kind: "select" as const,
      title: "Choose files",
      options: [{ label: "one", description: "first" }, "two"],
      initialIndex: 1,
      selectionMarker: "checkbox" as const,
      checkedIndices: [0],
      markableCount: 2,
      helpText: "Select permitted files",
    };
    const state = apply(createTranscriptState(), { t: "ui-request", request });
    expect(state.uiRequests.current).toEqual(request);
  });
});
