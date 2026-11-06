/**
 * The transcript synchronization state machine.
 *
 * The reported defect: an existing conversation with a large native history sat
 * on "No prompts yet" forever. Two independent causes, both pinned here.
 *
 * 1. The empty state was authorised by `messages.length === 0`, which an
 *    in-flight snapshot also satisfies — so history that was still arriving (or
 *    had been truncated in transit) rendered as a brand-new session.
 * 2. Nothing ever declared a snapshot dead. A snapshot that stopped arriving left
 *    the view waiting forever, with no retry and no explanation.
 *
 * Every case here fails on the pre-fix reducer, where `welcome` never produced
 * `sync` at all.
 */
import { describe, expect, it } from "vitest";
import type { AgentSnapshot, AssistantMessage, HostFrame, SessionEntry, SessionState } from "@caw/collab-protocol";
import {
  createTranscriptState,
  markSnapshotStalled,
  reduceHostFrame,
  SNAPSHOT_PROGRESS_TIMEOUT_MS,
  snapshotProgress,
  snapshotStalled,
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

/** Apply a frame at a chosen clock value so stalls are deterministic. */
function apply(state: TranscriptState, frame: HostFrame, now = 0): TranscriptState {
  return reduceHostFrame(state, frame, now);
}

describe("sync state machine", () => {
  it("a fresh state is loading, never empty", () => {
    // A mounted view knows nothing. Saying "empty" here is the original bug.
    expect(createTranscriptState().sync).toBe("loading");
  });

  it("a welcome promising entries is loading, not empty", () => {
    const state = apply(createTranscriptState(), welcome(50));
    expect(state.sync).toBe("loading");
    expect(state.messages).toEqual([]);
  });

  it("a welcome promising zero entries is authoritatively empty", () => {
    // The host positively said there is nothing; that is the only licence to
    // render the empty state.
    expect(apply(createTranscriptState(), welcome(0)).sync).toBe("empty");
  });

  it("stays loading while chunks arrive and becomes ready when the snapshot completes", () => {
    let state = apply(createTranscriptState(), welcome(3));
    state = apply(state, { t: "snapshot-chunk", entries: [entry("a", 1, "one")], final: false }, 100);
    expect(state.sync).toBe("loading");
    state = apply(state, { t: "snapshot-chunk", entries: [entry("b", 2, "two"), entry("c", 3, "three")], final: true }, 200);
    expect(state.sync).toBe("ready");
    expect(state.messages.map((row) => row.text)).toEqual(["one", "two", "three"]);
  });

  it("never calls a transcript with missing promised entries empty", () => {
    let state = apply(createTranscriptState(), welcome(2));
    state = apply(state, { t: "snapshot-chunk", entries: [], final: true }, 10);
    // The host promised two entries and delivered nothing. The snapshot is over,
    // but the transcript is unexplained, not empty: "this session has no prompts"
    // would be a claim about the native journal this evidence cannot support.
    expect(state.sync).toBe("stalled");
    expect(state.pendingSnapshot).toBeNull();
  });

  it("calls a snapshot empty when it honoured a promise of nothing", () => {
    // The host said zero in its welcome, then sent the terminating empty chunk.
    let state = apply(createTranscriptState(), welcome(0));
    expect(state.sync).toBe("empty");
    // The reducer treats it as an empty conversation, not as a stalled one, even
    // if the terminator arrives afterwards.
    state = apply(state, { t: "snapshot-chunk", entries: [], final: true }, 10);
    expect(state.sync).toBe("empty");
  });

  it("reports progress from the host's own counts, never a fabricated percentage", () => {
    let state = apply(createTranscriptState(), welcome(3238));
    expect(snapshotProgress(state)).toEqual({ received: 0, total: 3238 });
    state = apply(state, { t: "snapshot-chunk", entries: [entry("a", 1, "one"), entry("b", 2, "two")], final: false }, 10);
    expect(snapshotProgress(state)).toEqual({ received: 2, total: 3238 });
    state = apply(state, { t: "snapshot-chunk", entries: [], final: true }, 20);
    expect(snapshotProgress(state)).toBeNull();
  });

  it("does not call a snapshot stalled while it keeps making progress", () => {
    let state = apply(createTranscriptState(), welcome(3238));
    // A long download that progresses every 20s must never be declared stalled,
    // however long it runs in total (here 30 chunks = 10 minutes).
    for (let i = 0; i < 30; i += 1) {
      const at = i * 20_000;
      state = apply(state, { t: "snapshot-chunk", entries: [entry(`e${i}`, i, `row ${i}`)], final: false }, at);
      // A chunk just landed, so the deadline is a full window from *now* — not
      // from when the snapshot started, which is ~10 minutes ago.
      expect(snapshotStalled(state, at + SNAPSHOT_PROGRESS_TIMEOUT_MS - 1)).toBe(false);
      expect(snapshotStalled(state, at + SNAPSHOT_PROGRESS_TIMEOUT_MS)).toBe(true);
    }
    expect(state.sync).toBe("loading");
  });

  it("declares a snapshot stalled only after the progress window passes with no chunk", () => {
    const state = apply(createTranscriptState(), welcome(10));
    expect(snapshotStalled(state, SNAPSHOT_PROGRESS_TIMEOUT_MS - 1)).toBe(false);
    expect(snapshotStalled(state, SNAPSHOT_PROGRESS_TIMEOUT_MS)).toBe(true);
    expect(markSnapshotStalled(state, SNAPSHOT_PROGRESS_TIMEOUT_MS).sync).toBe("stalled");
  });

  it("a stalled snapshot that resumes is loading again", () => {
    let state = apply(createTranscriptState(), welcome(10));
    state = markSnapshotStalled(state, SNAPSHOT_PROGRESS_TIMEOUT_MS);
    expect(state.sync).toBe("stalled");
    state = apply(state, { t: "snapshot-chunk", entries: [entry("late", 1, "late row")], final: false }, SNAPSHOT_PROGRESS_TIMEOUT_MS + 1);
    expect(state.sync).toBe("loading");
  });

  it("never rewrites a completed transcript into stalled", () => {
    let state = apply(createTranscriptState(), welcome(1));
    state = apply(state, { t: "snapshot-chunk", entries: [entry("a", 1, "done")], final: true }, 0);
    const after = markSnapshotStalled(state, SNAPSHOT_PROGRESS_TIMEOUT_MS * 10);
    expect(after).toBe(state);
    expect(after.sync).toBe("ready");
  });

  it("drops a truncated snapshot on bye instead of publishing an arbitrary prefix", () => {
    let state = apply(createTranscriptState(), welcome(100));
    state = apply(state, { t: "snapshot-chunk", entries: [entry("a", 1, "first of many")], final: false }, 10);
    // The relay dropped the socket mid-snapshot: one entry of a promised hundred
    // is not a transcript, and showing it as one would be a worse lie than
    // showing nothing.
    state = apply(state, { t: "bye", reason: "reconnect" }, 20);
    expect(state.messages).toEqual([]);
    expect(state.pendingSnapshot).toBeNull();
    expect(state.sync).toBe("stalled");
    expect(state.connectionStatus).toBe("disconnected");
  });

  it("keeps an established transcript when the connection drops", () => {
    let state = apply(createTranscriptState(), welcome(1));
    state = apply(state, { t: "snapshot-chunk", entries: [entry("a", 1, "kept")], final: true }, 0);
    state = apply(state, { t: "bye", reason: "network" }, 10);
    expect(state.messages.map((row) => row.text)).toEqual(["kept"]);
    expect(state.sync).toBe("ready");
  });

  it("a live entry during a snapshot does not become history before the snapshot publishes", () => {
    let state = apply(createTranscriptState(), welcome(2));
    state = apply(state, { t: "entry", entry: entry("live", 5, "live row") }, 10);
    expect(state.messages).toEqual([]);
    state = apply(state, { t: "snapshot-chunk", entries: [entry("a", 1, "one"), entry("b", 2, "two")], final: true }, 20);
    expect(state.messages.map((row) => row.text)).toEqual(["one", "two", "live row"]);
  });
});
