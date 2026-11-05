/**
 * The one agent model every agent-facing surface reads.
 *
 * Why this module exists
 * ---------------------
 * Before this, three components each decided for themselves what an "agent" was,
 * and each decided wrong in a different way:
 *
 *  - the Vibe panel was handed the **entire** Collab roster and offered `Kill`
 *    for anything with `status === "running"` — which includes the main agent and
 *    any unrelated subagent mid-turn (B01, P1);
 *  - the header chip counted that same whole roster as "workers" (B11);
 *  - the advisor chip painted a live-looking alarm from notes recorded an hour
 *    ago (B09).
 *
 * All three share one root cause: the UI inferred identity from a list it
 * happened to hold. So classification happens here, once, from authoritative
 * sources — and every consumer reads the result.
 *
 * What counts as evidence
 * -----------------------
 * The wire snapshot (`collab-protocol/src/types.ts:208-217`) carries only
 * `kind: "main" | "sub"` and a `parentId`; it has **no** notion of a Vibe worker.
 * Inferring "worker" from `kind === "sub"` would be a guess, and inferring it from
 * a display name would be worse. A Vibe worker is therefore recognised only by
 * the journal record OMP itself writes for it
 * (`vibe/lifecycle.ts:14-16`, `vibe-session-lifecycle`, whose `id` is the worker's
 * agent id). When that evidence is absent the agent is `subagent` — never
 * silently promoted to `worker`.
 *
 * The same rule governs destructive controls: `canKillWorker` is only true for an
 * agent this module positively classified as a Vibe worker. "We could not tell" is
 * read-only, never a licence to kill.
 */
import type { AgentSnapshot } from "@caw/collab-protocol";

/**
 * What an agent actually is, as far as evidence allows.
 *
 * - `main`      — the session's own top-level agent (`kind: "main"`).
 * - `worker`    — a Vibe worker, proven by a journal lifecycle record for its id.
 * - `subagent`  — any other sub agent (task tool, eval `agent()`, `/tan` clone).
 * - `unknown`   — the snapshot contradicts itself or lacks the fields needed.
 */
export type AgentClass = "main" | "worker" | "subagent" | "unknown";

/** One row of the Agents Center: display data plus the safety decision. */
export interface AgentView {
  id: string;
  displayName: string;
  kind: AgentSnapshot["kind"];
  status: AgentSnapshot["status"];
  class: AgentClass;
  /** The spawning agent's id, when the host reported one. */
  parentId: string | null;
  hasSessionFile: boolean;
  createdAt: number;
  lastActivity: number;
  /**
   * True only for a proven Vibe worker. This is the flag destructive controls
   * gate on — never `status`, never `kind`, never a name.
   */
  canKillWorker: boolean;
  /** Why the row is read-only, when it is; shown to the user rather than hidden. */
  readOnlyReason: string | null;
}

/**
 * Turn worker evidence into the id set the classifier consumes.
 *
 * Accepts **either** shape, because both are real in this codebase and mixing
 * them silently is exactly how this gate became dead once already:
 *
 *  - `string[]` — what `GET /vibe` returns. The server has already replayed the
 *    journal (spawn/tombstone/tombstone-revoked) and hands over final ids, so the
 *    owner/parent checks have happened there;
 *  - raw `vibe-session-lifecycle` records — the shape a caller reads itself, where
 *    a record without an owner/parent pair cannot be attributed and is skipped.
 *
 * A string is kept verbatim; anything else must carry an id AND the owner/parent
 * pair. An unreadable entry is dropped in both cases: "I cannot read this" is not
 * evidence that a worker exists, and certainly not that one may be killed.
 */
export function vibeWorkerIds(evidence: readonly unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of evidence) {
    if (typeof entry === "string") {
      if (entry !== "") ids.add(entry);
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; ownerId?: unknown; parentSessionId?: unknown };
    if (typeof record.id !== "string" || record.id === "") continue;
    // A record with no owner or parent cannot tie the worker to this director,
    // so it is not proof of ownership and is ignored.
    if (typeof record.ownerId !== "string" || typeof record.parentSessionId !== "string") continue;
    ids.add(record.id);
  }
  return ids;
}

function classify(agent: AgentSnapshot, workerIds: ReadonlySet<string>): AgentClass {
  if (agent.kind === "main") return "main";
  if (agent.kind !== "sub") return "unknown";
  return workerIds.has(agent.id) ? "worker" : "subagent";
}

/** The read-only explanation for a row that offers no worker control. */
function readOnlyReasonFor(cls: AgentClass): string | null {
  switch (cls) {
    case "main":
      return "This is the session's own agent, not a Vibe worker.";
    case "subagent":
      return "No Vibe lifecycle record for this agent, so it is not treated as a worker.";
    case "unknown":
      return "This agent's classification could not be established from the host data.";
    case "worker":
      return null;
  }
}

/**
 * Normalize a roster into the view model, in host order.
 *
 * Order is the host's: it is the order the registry reported, and re-sorting
 * would hide that a worker list is empty because none exist rather than because
 * a filter dropped them.
 */
export function agentViews(agents: readonly AgentSnapshot[], workerIds: ReadonlySet<string>): AgentView[] {
  return agents.map((agent) => {
    const cls = classify(agent, workerIds);
    return {
      id: agent.id,
      displayName: agent.displayName,
      kind: agent.kind,
      status: agent.status,
      class: cls,
      parentId: agent.parentId ?? null,
      hasSessionFile: agent.hasSessionFile,
      createdAt: agent.createdAt,
      lastActivity: agent.lastActivity,
      canKillWorker: cls === "worker",
      readOnlyReason: readOnlyReasonFor(cls),
    };
  });
}

/** Counts for the header chip. Never counts a non-worker as a worker. */
export function agentCounts(views: readonly AgentView[]): {
  total: number;
  workers: number;
  runningWorkers: number;
  runningSubagents: number;
} {
  let workers = 0;
  let runningWorkers = 0;
  let runningSubagents = 0;
  for (const view of views) {
    if (view.class === "worker") {
      workers += 1;
      if (view.status === "running") runningWorkers += 1;
    } else if (view.class === "subagent" && view.status === "running") {
      runningSubagents += 1;
    }
  }
  return { total: views.length, workers, runningWorkers, runningSubagents };
}

/**
 * A two-line-bounded task preview.
 *
 * The full task always lives in Agent Detail; this exists so a long brief cannot
 * become a multi-screen row in the list. Bounded by characters *and* by newlines,
 * because a task of 300 short lines is as tall as 300 lines even though it is
 * short in characters.
 */
export function taskPreview(text: string, maxChars = 140, maxLines = 2): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "").slice(0, maxLines);
  const joined = lines.join(" ").trim();
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars).trimEnd()}…`;
}
