import type { RuntimeState } from "@caw/contracts";
import type { Observations, RuntimeHost, RuntimeTmuxSession, StateVerdict, Tri } from "./types";

export type { Observations };
/**
 * Pure lifecycle reasoning: no I/O, no clock, no process handles.
 *
 * Every rule here exists because of an observed fact about OMP:
 *
 * - `busy` is a turn-in-flight flag. OMP reports it false during scheduling
 *   pauses (queued follow-ups, async-job waits, compaction), so `busy === false`
 *   means "no turn right now", never "the work is finished". It is also `null`
 *   for hosts older than the field, and unknown must not be read as idle.
 * - A registry row is the only proof a room exists. No row means no viewer can
 *   attach, even if the process is alive.
 * - A missing registry directory means "no hosts"; an unreadable one is an
 *   error. Conflating them would let us report a live agent as stopped.
 * - Every observation that can fail is tri-state. "I could not look" is not
 *   "there is nothing there", so a failed journal probe, a failed tmux
 *   enumeration and a failed lease probe all keep the verdict `unknown` instead
 *   of being written to the store as `stopped` or `error`.
 */

/** Decide what a conversation's state actually is.
 *
 * Ordered by certainty: an unreachable registry outranks everything (we cannot
 * know), then the process, then the room, then the lease.
 */
export function hostState(host: RuntimeHost): RuntimeState {
  // Relay reachability and turn activity are independent observations. A dropped
  // relay proves only that live *viewing* is unavailable; the turn flag still
  // decides whether a turn is in flight, and an unobserved flag stays unknown
  // rather than becoming the idle a reachable relay would have produced.
  if (host.relayConnected === null || (host.busy !== true && host.busy !== false)) return "unknown";
  if (host.inputRequired === true) return "awaiting_input";
  return host.busy ? "running" : "idle";
}

/** True only for a confirmed-live journal; used where "unknown" must not pass. */
const exists = (value: Tri): boolean => value === true;

export function evaluateState(observations: Observations): StateVerdict {
  const { tmux, host, leaseLive, sessionPathExists, hasNativeSession, everLaunched, stopRequested, registryUnreadable } =
    observations;

  if (observations.tmuxOwnershipUnknown) {
    return {
      state: "unknown",
      ownership: "managed",
      detail: "The recorded tmux server identity is missing or changed, so process ownership cannot be verified.",
    };
  }
  if (observations.tmuxEnumerationFailed) {
    return {
      state: "unknown",
      ownership: "managed",
      detail: observations.tmuxEnumerationReason ?? "The tmux session list could not be read, so the process state is unknown.",
    };
  }
  if ((!tmux || !tmux.alive) && !host && leaseLive === true) {
    return {
      state: "unknown",
      ownership: "external",
      detail: "Another process is writing this session, but it is not managed here.",
    };
  }
  // We could not read the journal we recorded. That is not "the history is gone":
  // reporting `error` here would claim a data loss we have not observed.
  if (sessionPathExists === "unknown" && hasNativeSession) {
    return {
      state: "unknown",
      ownership: "managed",
      detail: observations.sessionPathReason ?? "The recorded session journal could not be read, so the conversation history is unverified.",
    };
  }
  if (registryUnreadable) {
    return {
      state: "unknown",
      ownership: "managed",
      detail: "The OMP Collab registry could not be read, so the live state is unknown.",
    };
  }

  if (host && !tmux) {
    const state = hostState(host);
    // Same three facts the managed branch composes, in the same order and with the
    // same wording: ownership framing, then the turn fact, then relay reachability.
    // A single ternary keyed on the relay flag made the explanation report a relay
    // problem for a turn-flag problem and vice versa.
    if (host.relayConnected === null) {
      // Matches the managed path: an unreported relay leaves the turn flag unable
      // to produce a verdict either, so nothing about a turn may be claimed.
      return {
        state,
        ownership: "external",
        detail: "The host does not report relay connectivity, so live viewing is unconfirmed.",
      };
    }
    const relayNote = host.relayConnected ? "" : " Live viewing is unavailable: the relay is disconnected.";
    const ownershipNote = host.relayConnected
      ? "Started outside this app; it can be watched, and its lifecycle is not managed here."
      : "Started outside this app; its lifecycle is not managed here.";
    const turnNote =
      state === "unknown"
        ? "The host does not report turn state (older OMP); activity here is unconfirmed."
        : state === "running"
          ? "A turn is in flight."
          : state === "awaiting_input"
            ? "The agent is waiting for an answer."
            : "No turn in flight.";
    return {
      state,
      ownership: "external",
      detail: `${ownershipNote} ${turnNote}${relayNote}`,
    };
  }

  if (tmux && !tmux.alive) {
    if (leaseLive !== false) {
      return {
        state: "unknown",
        ownership: "managed",
        detail: leaseLive === true
          ? "Another process is still writing this session after the managed process exited."
          : "The session writer lease could not be checked, so the live state is unknown.",
      };
    }
    if (stopRequested) {
      return { state: "stopped", ownership: "managed", detail: "Stopped." };
    }
    // "History is missing" is only claimable when we recorded a session identity
    // to lose, and only when we actually looked and found it absent.
    if (hasNativeSession && !exists(sessionPathExists)) {
      return {
        state: "error",
        ownership: "managed",
        detail: "The agent process is gone and its recorded session file could not be found.",
      };
    }
    return {
      state: "stopped",
      ownership: "managed",
      detail: hasNativeSession
        ? "The agent process is no longer running; its conversation history is intact."
        : "The agent process is no longer running.",
    };
  }

  if (tmux && tmux.alive) {
    if (stopRequested) {
      return { state: "stopping", ownership: "managed", detail: "Stopping the agent…" };
    }
    if (!host) {
      return {
        state: "unknown",
        ownership: "managed",
        detail: observations.hostMatchReason ?? "The agent process is live but has not published a Collab host; activity is unknown.",
      };
    }
    if (host.relayConnected === null) {
      return { state: "unknown", ownership: "managed", detail: "The host does not report relay connectivity, so live viewing is unconfirmed." };
    }
    // Same rule as `hostState`: a disconnected relay removes live viewing, not
    // turn activity. The busy flag keeps deciding, and an unreported one stays
    // unknown instead of collapsing into the idle the old shortcut produced.
    if (host.busy !== false && host.busy !== true) {
      return {
        state: "unknown",
        ownership: "managed",
        detail: "The agent does not report turn state (older OMP); activity here is unconfirmed.",
      };
    }
    const relayDown = host.relayConnected ? "" : " Live viewing is unavailable: the relay is disconnected.";
    if (host.inputRequired === true) {
      return { state: "awaiting_input", ownership: "managed", detail: `The agent is waiting for an answer.${relayDown}` };
    }
    if (host.busy === true) {
      return { state: "running", ownership: "managed", detail: relayDown ? `A turn is in flight.${relayDown}` : null };
    }
    return { state: "idle", ownership: "managed", detail: `No turn in flight.${relayDown}` };
  }


  if (leaseLive === "unknown") {
    return {
      state: "unknown",
      ownership: "managed",
      detail: "The session writer lease could not be checked, so the live state is unknown.",
    };
  }
  // We launched a process before and it is gone now. That is a stop or a crash,
  // never a launch in progress — reporting "starting" here would hide a dead agent.
  if (everLaunched) {
    if (hasNativeSession && !exists(sessionPathExists)) {
      return {
        state: "error",
        ownership: "managed",
        detail: "The agent process is gone and its recorded session file could not be found.",
      };
    }
    return {
      state: "stopped",
      ownership: "managed",
      detail: hasNativeSession
        ? "The agent process is no longer running; its conversation history is intact."
        : "The agent process is no longer running.",
    };
  }

  // Nothing has ever run for this conversation, so it is genuinely waiting to start.
  if (sessionPathExists === "unknown") {
    return {
      state: "starting",
      ownership: "managed",
      detail: "Starting…",
    };
  }
  return {
    state: exists(sessionPathExists) ? "stopped" : "starting",
    ownership: "managed",
    detail: exists(sessionPathExists) ? null : "Starting…",
  };
}

/**
 * Can we start an agent for this conversation right now?
 *
 * The duplicate-writer guard. OMP does not reject a second writer: it silently
 * forks the journal, which splits a conversation's history. So the refusal has
 * to happen here, before any process is created.
 */
export function launchVerdict(input: {
  /** A tmux session already recorded and alive. */
  liveTmux: RuntimeTmuxSession | null;
  /** A host row already serving this native session. */
  host: RuntimeHost | null;
  /** Writer lease for the native session, if it has one yet. */
  leaseLive: Tri;
  /**
   * Running agents we can actually name. `activeCountUnknown` means we could not
   * enumerate them at all, which is not the same as zero.
   */
  activeCount: number;
  activeCountUnknown?: boolean;
  activeCountReason?: string | null;
  maxActive: number;
}): { allowed: true } | { allowed: false; code: "conflict_owner" | "conflict_limit"; message: string } {
  if (input.liveTmux) {
    return {
      allowed: false,
      code: "conflict_owner",
      message: "This conversation is already running under a managed agent process.",
    };
  }
  if (input.host) {
    return {
      allowed: false,
      code: "conflict_owner",
      message: "Another agent process is serving this session right now.",
    };
  }
  if (input.leaseLive === true) {
    return {
      allowed: false,
      code: "conflict_owner",
      message:
        "Another process is writing this session (for example an OMP terminal). Starting a second writer would fork the conversation's history.",
    };
  }
  if (input.leaseLive === "unknown") {
    return {
      allowed: false,
      code: "conflict_owner",
      message:
        "This session's writer lease could not be checked, so starting an agent could fork its history. Refusing until it can be verified.",
    };
  }
  // Fail closed when the machine could not be enumerated: we cannot show we are
  // under the cap, so starting another agent is how the cap gets exceeded.
  if (input.activeCountUnknown) {
    return {
      allowed: false,
      code: "conflict_limit",
      message:
        input.activeCountReason ??
        "The running agents could not be enumerated, so the concurrency limit cannot be enforced. Refusing until that can be read.",
    };
  }
  if (input.activeCount >= input.maxActive) {
    return {
      allowed: false,
      code: "conflict_limit",
      message: `The limit of ${input.maxActive} running agents is reached. Stop one before starting another.`,
    };
  }
  return { allowed: true };
}

/** States from which a restart is meaningful: nothing is running in any of them. */
export const canRestart = (state: RuntimeState): boolean => state === "stopped" || state === "error";
