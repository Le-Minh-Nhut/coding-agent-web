/**
 * What one recorded conversation event means, in operator terms.
 *
 * Pure and total: any string type describes something, because the store's
 * `ConversationEvent.type` is an open string with no union
 * (`packages/contracts/src/index.ts:501-506`), so a kind this build has never
 * seen must still render.
 *
 * The honesty rule this module exists to keep: an event proves only that a
 * lifecycle step was RECORDED. None of the recorded payloads carries a duration,
 * an exit status, a diff, a file count or a test result — so nothing here may
 * claim success, completion, elapsed time or a count. The labels name the step
 * that was written (`Agent started`, `Handoff started`), never its outcome.
 *
 * The kinds below are every kind the codebase actually writes (verified by
 * grepping `recordEvent` across `packages/runtime` and `apps/server`); an
 * unrecognised kind falls back to `humanizeEventType` with no detail, because
 * inventing detail for an unknown payload is exactly the overstatement this
 * module forbids.
 */

/** The one-line meaning of an event, plus how loud it should read. */
export interface ActivityEventDescription {
  /** The prominent line: what was recorded. Never an outcome claim. */
  label: string;
  /** Muted supporting text, or `null` when the payload supports none. */
  detail: string | null;
  tone: "neutral" | "success" | "warning" | "error";
  /**
   * True when the row is internal bookkeeping with nothing the user can act on.
   * The panel renders it quieter; it is not hidden, because it is still the only
   * record that the step happened.
   */
  debugOnly: boolean;
}

/**
 * Refusal codes this UI can restate in prose.
 *
 * Only the two a launch can actually be refused with are mapped
 * (`launchVerdict` returns `conflict_owner`/`conflict_limit`); any other code is
 * shown with the host's own message instead of a guess at what it means.
 */
const REFUSAL_PROSE: Record<string, string> = {
  conflict_owner: "Another writer already owns this native session.",
  conflict_limit: "The concurrent agent limit is reached.",
};

/** A string field of the payload, or `null`. Never stringifies an object. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A finite number field of the payload, or `null`. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** "60000 ms" reads as "60 s"; anything not a whole second stays in ms. */
function formatTimeout(ms: number): string {
  return ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

const KINDS: Record<string, (payload: Record<string, unknown> | null) => ActivityEventDescription> = {
  "launch.refused": (payload) => {
    const code = str(payload?.code);
    const prose = code === null ? null : REFUSAL_PROSE[code] ?? null;
    const detail =
      prose ??
      str(payload?.message) ??
      str(payload?.reason) ??
      (code === null ? null : `Refusal code: ${code}`);
    return { label: "Launch refused", detail, tone: "warning", debugOnly: false };
  },
  // The two halves of a recording failure, and the only difference between them
  // is the half that matters: `discarded` means the started process was confirmed
  // gone, `unrecorded` means it was not. The type is that fact's only carrier.
  "agent.launch_discarded": (payload) => {
    const error = str(payload?.error);
    return {
      label: "Launch discarded",
      detail: `The started process was stopped.${error === null ? "" : ` Recording failed: ${error}`}`,
      tone: "error",
      debugOnly: false,
    };
  },
  "agent.launch_unrecorded": (payload) => {
    const error = str(payload?.error);
    return {
      label: "Launch unrecorded",
      detail: `The started process could not be stopped.${error === null ? "" : ` Recording failed: ${error}`}`,
      tone: "error",
      debugOnly: false,
    };
  },
  "agent.launched": (payload) => {
    const name = str(payload?.tmuxSessionName);
    return { label: "Agent started", detail: name === null ? null : `Terminal session ${name}`, tone: "success", debugOnly: false };
  },
  "agent.hosted": (payload) => {
    const sessionId = str(payload?.sessionId);
    return { label: "Agent connected", detail: sessionId === null ? null : `Native session ${sessionId}`, tone: "success", debugOnly: false };
  },
  "agent.exited": (payload) => ({
    label: "Agent process exited",
    detail: payload?.duringStartup === true ? "It exited during startup." : null,
    tone: "warning",
    debugOnly: false,
  }),
  "agent.stopped": (payload) => ({
    label: "Agent stopped",
    detail: payload?.alreadyGone === true ? "The process was already gone." : null,
    tone: "neutral",
    debugOnly: false,
  }),
  "agent.publish_timeout": (payload) => {
    const timeoutMs = num(payload?.timeoutMs);
    return {
      label: "Agent did not publish in time",
      detail: timeoutMs === null ? null : `Waited ${formatTimeout(timeoutMs)}.`,
      tone: "warning",
      debugOnly: false,
    };
  },
  "agent.stop_timeout": (payload) => {
    const timeoutMs = num(payload?.timeoutMs);
    return {
      label: "Agent did not stop in time",
      detail: timeoutMs === null ? null : `Waited ${formatTimeout(timeoutMs)}.`,
      tone: "warning",
      debugOnly: false,
    };
  },
  // A start proves a paste was made; it never proves the compaction landed, which
  // is why the label stops at "started".
  "handoff-start": (payload) => {
    const sessionId = str(payload?.sessionId);
    return { label: "Handoff started", detail: sessionId === null ? null : `Native session ${sessionId}`, tone: "neutral", debugOnly: false };
  },
  // The operation is over and the journal says so: this is the only handoff
  // outcome that may read as success, and it names the entry that proves it.
  "handoff-committed": (payload) => {
    const entryId = str(payload?.entryId);
    return {
      label: "Handoff completed",
      detail: entryId === null ? "Context compacted." : `Context compacted (journal entry ${entryId}).`,
      tone: "success",
      debugOnly: false,
    };
  },
  // The marker was retired: internal bookkeeping with no user-visible step behind
  // it, so it reads quieter than the rest.
  "handoff-cancelled": () => ({ label: "Handoff cancelled", detail: null, tone: "neutral", debugOnly: true }),
};

/**
 * `launch.refused` → "Launch Refused", and any unknown kind's words title-cased.
 *
 * Kept verbatim from where it lived in `ActivityPanel` (minus `agent.stop_requested`,
 * which had no producer anywhere in the codebase), because the labels are part of
 * the panel's rendered output and tests pin them.
 */
export function humanizeEventType(type: string): string {
  switch (type) {
    case "launch.refused":
      return "Launch Refused";
    case "agent.launched":
      return "Agent Launched";
    case "agent.hosted":
      return "Agent Collab Hosted";
    case "agent.exited":
      return "Agent Exited";
    case "agent.stopped":
      return "Agent Stopped";
    case "agent.stop_timeout":
      return "Stop Timed Out";
    case "agent.publish_timeout":
      return "Publish Timed Out";
    default:
      return (
        type
          .split(/[._-]/)
          .filter((word) => word.length > 0)
          .map((word) => word[0]!.toUpperCase() + word.slice(1))
          .join(" ") || type
      );
  }
}

export function describeActivityEvent(event: { type: string; payload?: unknown; ts?: string }): ActivityEventDescription {
  const payload = typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : null;
  const known = KINDS[event.type];
  if (known === undefined) {
    // No detail from an unknown payload: this build cannot tell what its keys mean.
    return { label: humanizeEventType(event.type), detail: null, tone: "neutral", debugOnly: false };
  }
  return known(payload);
}
