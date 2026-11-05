/**
 * The honesty gate for the Activity timeline.
 *
 * Every row states what was RECORDED, never what it achieved. None of the 14
 * kinds the server and runtime actually write carries a duration, an exit
 * status, a diff, a file count or a test result, so no label or detail may claim
 * success, completion or elapsed time — a claim like "Tests completed" would be
 * invented from a payload that cannot support it.
 *
 * The table is the vocabulary itself: if a kind is added to the codebase, adding
 * it here is what forces a decision about what it means. The last test is the
 * inverse guard — an unrecognised kind must fall back with NO detail, because a
 * detail invented for an unknown payload is exactly the overstatement this file
 * exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { describeActivityEvent } from "../../apps/web/src/components/activity-event.js";

/** The 14 kinds written by `packages/runtime/src/supervisor.ts` and `apps/server/src/app.ts`. */
const KINDS: ReadonlyArray<{ type: string; payload: Record<string, unknown>; label: string; tone: string; detail?: string | RegExp }> = [
  { type: "launch.refused", payload: { code: "conflict_owner" }, label: "Launch refused", tone: "warning", detail: "Another writer already owns this native session." },
  { type: "launch.refused", payload: { code: "conflict_limit" }, label: "Launch refused", tone: "warning", detail: "The concurrent agent limit is reached." },
  { type: "launch.refused", payload: { code: "some_new_code", message: "host text" }, label: "Launch refused", tone: "warning", detail: "host text" },
  { type: "agent.launch_discarded", payload: { tmuxSessionId: "$1", tmuxSessionName: "s", tmuxServerIdentity: "x", error: "boom" }, label: "Launch discarded", tone: "error", detail: /stopped/ },
  { type: "agent.launch_unrecorded", payload: { tmuxSessionId: "$1", tmuxSessionName: "s", tmuxServerIdentity: "x", error: "boom" }, label: "Launch unrecorded", tone: "error", detail: /could not be stopped/ },
  { type: "agent.launched", payload: { tmuxSessionId: "$1", tmuxSessionName: "caw-1" }, label: "Agent started", tone: "success", detail: "Terminal session caw-1" },
  { type: "agent.hosted", payload: { instanceId: "i", generation: 1, sessionId: "s-1" }, label: "Agent connected", tone: "success", detail: "Native session s-1" },
  { type: "agent.exited", payload: { duringStartup: true, tmuxSessionId: "$1" }, label: "Agent process exited", tone: "warning", detail: "It exited during startup." },
  { type: "agent.exited", payload: { duringStartup: false, tmuxSessionId: "$1" }, label: "Agent process exited", tone: "warning" },
  { type: "agent.stopped", payload: { tmuxSessionId: "$1" }, label: "Agent stopped", tone: "neutral" },
  { type: "agent.stopped", payload: { tmuxSessionId: "$1", alreadyGone: true }, label: "Agent stopped", tone: "neutral", detail: "The process was already gone." },
  { type: "agent.publish_timeout", payload: { timeoutMs: 30000 }, label: "Agent did not publish in time", tone: "warning", detail: "Waited 30 s." },
  { type: "agent.stop_timeout", payload: { timeoutMs: 1500 }, label: "Agent did not stop in time", tone: "warning", detail: "Waited 1500 ms." },
  { type: "handoff-start", payload: { sessionId: "s-1", startedAt: 1, refusalBaseline: 0 }, label: "Handoff started", tone: "neutral", detail: "Native session s-1" },
  { type: "handoff-cancelled", payload: {}, label: "Handoff cancelled", tone: "neutral" },
];

describe("describeActivityEvent", () => {
  it.each(KINDS)("describes $type with its operator meaning", ({ type, payload, label, tone, detail }) => {
    const described = describeActivityEvent({ type, payload });
    expect(described.label).toBe(label);
    expect(described.tone).toBe(tone);
    if (detail === undefined) expect(described.detail).toBeNull();
    else if (typeof detail === "string") expect(described.detail).toBe(detail);
    else expect(described.detail).toMatch(detail);
  });

  it("never renders `undefined` in a label or detail", () => {
    const payloads: Array<unknown> = [undefined, null, {}, { code: undefined }, { timeoutMs: undefined }, { error: undefined }, "a string", 42, []];
    for (const { type } of KINDS) {
      for (const payload of payloads) {
        const { label, detail } = describeActivityEvent({ type, payload });
        expect(label).not.toContain("undefined");
        expect(detail ?? "").not.toContain("undefined");
      }
    }
  });

  it("never claims success, completion, or elapsed time", () => {
    // Word-bounded so "completed" cannot hide inside a longer word, and covering
    // the past-tense forms a careless label would reach for.
    const forbidden = /\b(succeeded|success|completed|complete|finished|passed|failed to publish|elapsed|took|seconds ago|in \d+)/i;
    for (const { type, payload } of KINDS) {
      const { label, detail } = describeActivityEvent({ type, payload });
      expect(label).not.toMatch(forbidden);
      // "It exited during startup." is a fact the payload carries; the guard is
      // about outcome claims, so allow the two words that name a recorded state.
      expect(detail ?? "").not.toMatch(forbidden);
    }
  });

  it("falls back for an unknown kind with no detail", () => {
    const described = describeActivityEvent({ type: "future.experimental.probe", payload: { secret: "x", count: 7 } });
    expect(described.label).toBe("Future Experimental Probe");
    expect(described.detail).toBeNull();
    expect(described.debugOnly).toBe(false);
    expect(described.tone).toBe("neutral");
  });

  it("does not read detail out of a non-object payload", () => {
    expect(describeActivityEvent({ type: "agent.launched", payload: "not-an-object" }).detail).toBeNull();
    expect(describeActivityEvent({ type: "agent.publish_timeout", payload: null }).detail).toBeNull();
  });

  it("spells out a whole-second timeout in seconds and leaves the rest in ms", () => {
    expect(describeActivityEvent({ type: "agent.publish_timeout", payload: { timeoutMs: 60000 } }).detail).toBe("Waited 60 s.");
    expect(describeActivityEvent({ type: "agent.stop_timeout", payload: { timeoutMs: 250 } }).detail).toBe("Waited 250 ms.");
  });
});
