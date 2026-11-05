/**
 * Agent Detail — the level-3 full-screen single-agent view.
 *
 * Two honesty rules drive this file:
 *
 *  - the full task text is shown here and only here. The list bounds it to two
 *    lines; if this view also truncated, the only full copy on a live-only channel
 *    would be gone (round53 B10).
 *  - absence is stated, never dressed as success. No task, no transcript, a failed
 *    fetch, an agent the host never wrote a session file for — each says exactly
 *    which of those it is, because an empty transcript panel reads as "this agent
 *    said nothing", which may be false.
 *
 * The destructive control is gated on `view.canKillWorker` alone. That flag is
 * true only for an agent `agent-model.ts` positively classified as a Vibe worker
 * from journal evidence; a main agent or an ordinary subagent gets the reason
 * string instead of a button (round53 B01, P1).
 */
import { useEffect, useRef } from "react";
import type { AgentView } from "../agent-model.js";
import type { AgentActivity, TranscriptReply } from "../transcript.js";
import "../agents.css";

export interface AgentDetailProps {
  view: AgentView;
  activity: AgentActivity | undefined;
  transcript: TranscriptReply | undefined;
  transcriptError: string | null | undefined;
  loading: boolean;
  onFetchTranscript(agentId: string, fromByte: number): void;
  /**
   * Declare which agent's transcript is being watched, and release it on leave.
   *
   * The host-side fetch is gated on this: it forwards a reply only for the agent
   * currently being watched, so a detail view that never declares itself would
   * have every fetch silently dropped. This is the wiring the old modal panel did
   * via its own `onWatchAgent`, and it must follow the view that now reads.
   */
  onWatchAgent?(agentId: string | null): void;
  onBack(): void;
  onKillWorker?(agentId: string): void;
  /**
   * The link cannot write (read-only or view-only). Destructive controls are then
   * not offered at all, matching the Vibe panel: an action the host would refuse
   * must not be presented as available.
   */
  readOnly?: boolean;
}

const TRANSCRIPT_POLL_MS = 1200;

/** Long enough that a two-line brief never hides behind a disclosure. */
const TASK_DISCLOSURE_CHARS = 240;

export function AgentDetail({
  view,
  activity,
  transcript,
  transcriptError,
  loading,
  onFetchTranscript,
  onWatchAgent,
  onBack,
  onKillWorker,
  readOnly = false,
}: AgentDetailProps) {
  const fetchRef = useRef(onFetchTranscript);
  fetchRef.current = onFetchTranscript;
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const task = activity?.task ?? "";
  const running = view.status === "running";

  /* Same shape as SubagentPanel: fetch immediately, then keep asking. A finished
     agent stops after four unchanged polls so the last bytes are still collected but
     an idle agent is not polled forever. A failed fetch is *not* fatal here — unlike
     the panel there is no Refresh button, so polling continues and self-heals. */
  useEffect(() => {
    if (!view.hasSessionFile) return;
    // Claim the watch for this agent, and release it on unmount or a switch to
    // another agent: the host drops replies for an agent nobody is watching.
    onWatchAgent?.(view.id);
    let stopped = false;
    let unchangedPolls = 0;
    let previousCursor = transcriptRef.current?.newSize ?? 0;
    const poll = () => {
      if (stopped || loadingRef.current) return;
      const cursor = transcriptRef.current?.newSize ?? 0;
      unchangedPolls = cursor === previousCursor ? unchangedPolls + 1 : 0;
      previousCursor = cursor;
      if (!running && unchangedPolls >= 4) {
        clearInterval(timer);
        return;
      }
      fetchRef.current(view.id, cursor);
    };
    const timer = setInterval(poll, TRANSCRIPT_POLL_MS);
    poll();
    return () => {
      stopped = true;
      clearInterval(timer);
      onWatchAgent?.(null);
    };
  }, [view.id, view.hasSessionFile, running, onWatchAgent]);

  return (
    <div className="view-container agent-detail">
      <div className="agents-head">
        <button type="button" className="ghost header-icon-button" onClick={onBack} aria-label="Back to Agents">←</button>
        <h2 id="agent-detail-title">{view.displayName}</h2>
      </div>

      {/* Status line. Model/tier is not in the wire snapshot, so it is named as
          missing rather than invented (AGENTS.md rule 6). */}
      <p className="agent-status-line">
        <span className={`badge ${view.status}`}>{view.status}</span>
        <span>·</span>
        <span>{view.class}</span>
        <span>·</span>
        <span>model: not reported</span>
      </p>

      <section className="agent-section" aria-labelledby="agent-task-heading">
        <h3 id="agent-task-heading">Task</h3>
        {task.trim() === "" ? (
          <p className="agent-absent" role="status">The host reported no task for this agent.</p>
        ) : task.length > TASK_DISCLOSURE_CHARS ? (
          <details className="agent-task">
            <summary>Show full task</summary>
            <pre><code>{task}</code></pre>
          </details>
        ) : (
          <pre className="agent-task-full"><code>{task}</code></pre>
        )}
        {activity?.liveOnly ? (
          <p className="agent-note" role="note">
            This task text is live-only: OMP does not persist it, so it may not survive a reconnect.
          </p>
        ) : null}
      </section>

      <section className="agent-section" aria-labelledby="agent-transcript-heading">
        <h3 id="agent-transcript-heading">Transcript</h3>
        {!view.hasSessionFile ? (
          <p className="agent-absent" role="status">
            No session file was reported for this agent, so there is no transcript to read.
          </p>
        ) : transcriptError ? (
          <p role="alert" className="agent-absent">{transcriptError}</p>
        ) : transcript?.error ? (
          <p role="alert" className="agent-absent">{transcript.error}</p>
        ) : transcript ? (
          <pre className="agent-transcript"><code>{transcript.text}{transcript.carry}</code></pre>
        ) : (
          <p className="agent-absent" role="status">
            {loading ? "Loading transcript…" : "No transcript bytes received yet."}
          </p>
        )}
      </section>

      <section className="agent-section" aria-labelledby="agent-actions-heading">
        <h3 id="agent-actions-heading">Actions</h3>
        {view.canKillWorker && !readOnly ? (
          <button type="button" className="danger" onClick={() => onKillWorker?.(view.id)}>
            Kill worker
          </button>
        ) : view.canKillWorker && readOnly ? (
          <p className="agent-readonly" role="note">
            This link is read-only, so the worker cannot be cancelled from here.
          </p>
        ) : (
          <p className="agent-readonly" role="note">
            {view.readOnlyReason ?? "No worker control is offered for this agent."}
          </p>
        )}
      </section>
    </div>
  );
}
