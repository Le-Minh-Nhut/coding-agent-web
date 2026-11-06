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
import { useEffect, useMemo, useRef } from "react";
import type { AgentView } from "../agent-model.js";
import { advanceAgentTranscript, type AgentTranscriptCursor } from "../agent-transcript.js";
import type { AgentActivity, TranscriptReply } from "../transcript.js";
import { AgentChat } from "./AgentChat.js";
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
  /**
   * What has been decoded for this agent so far.
   *
   * A ref, not state: it is a cache of work already done, and putting it in state
   * would rebuild the journal's rows on every poll instead of only on new bytes.
   * Reset when the view switches agents, so one agent's bytes are never extended
   * into another's.
   */
  const cursorRef = useRef<AgentTranscriptCursor | null>(null);
  const cursorAgentRef = useRef(view.id);
  if (cursorAgentRef.current !== view.id) {
    cursorAgentRef.current = view.id;
    cursorRef.current = null;
  }

  /**
   * The fetched bytes, decoded once per reply and only once per byte.
   *
   * Keyed on the two strings the parser actually reads, NOT on the `transcript`
   * object. The reducer rebuilds that object on every poll — including a poll that
   * carried no new bytes — so an identity key re-parsed the whole journal on every
   * 1200 ms tick (measured: +1945 `JSON.parse` calls per unchanged poll on a 4.4 MB
   * journal). Keying on the text makes "same bytes, same rows" literal: a poll that
   * changed nothing is not re-parsed.
   *
   * A poll that DID carry new bytes used to re-decode the whole journal anyway
   * (measured: 34 ms for a 3.9 MB journal, and servable subagent journals reach
   * 52 MB). `advanceAgentTranscript` decodes only the appended suffix against the
   * previous cursor; the cursor is re-armed when the text no longer starts with the
   * old one, which is the truncation/rewind case the reducer signals by replacing
   * `text` from `""`.
   */
  const transcriptText = transcript?.text;
  const transcriptCarry = transcript?.carry;
  const parsed = useMemo(
    // `transcript` is read for the current bytes; the deps below are the only two
    // fields the parser consumes, so a re-run always sees the matching object.
    () => (transcript === undefined ? { cursor: cursorRef.current, transcript: null } : advanceAgentTranscript(cursorRef.current, transcript)),
    [transcriptText, transcriptCarry],
  );
  cursorRef.current = parsed.cursor;
  const agentTranscript = parsed.transcript;

  /**
   * The task text, preferring the journal's own durable copy.
   *
   * `activity` arrives on the live bus and is the only source while the session is
   * running; `session_init.task` is the same text as OMP persisted it. The durable
   * copy wins when both exist because it survives a reconnect, and the live-only
   * caveat below is then no longer true and must not be shown.
   */
  const durableTask = agentTranscript?.task ?? null;
  const task = durableTask ?? activity?.task ?? "";
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

      {/* Status line. Tier is not in the wire snapshot and stays unstated; the
          model is read from the journal's own `model_change`/`session_init`
          records when they exist, and named as missing when they do not —
          never guessed (AGENTS.md rule 6). */}
      <p className="agent-status-line">
        <span className={`badge ${view.status}`}>{view.status}</span>
        <span>·</span>
        <span>{view.class}</span>
        <span>·</span>
        <span>{agentTranscript?.model === null || agentTranscript?.model === undefined ? "model: not reported" : `model: ${agentTranscript.model}`}</span>
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
        {/* The caveat is a claim about THIS text. Once the durable copy is the one
            being shown, the text provably survives a reconnect, so the warning
            would be false. */}
        {activity?.liveOnly && durableTask === null ? (
          <p className="agent-note" role="note">
            This task text is live-only: OMP does not persist it, so it may not survive a reconnect.
          </p>
        ) : null}
      </section>

      <section className="agent-section agent-section--transcript" aria-labelledby="agent-transcript-heading">
        <h3 id="agent-transcript-heading">Transcript</h3>
        {/* Rigorously ordered: every branch that states an absence keeps its exact
            sentence, because an empty transcript panel reads as "this agent said
            nothing", which may be false. A reply that carried no bytes at all
            keeps its own sentence too, through `emptyReason` — the chat surface
            must never rephrase it as the agent having been silent. */}
        {!view.hasSessionFile ? (
          <p className="agent-absent" role="status">
            No session file was reported for this agent, so there is no transcript to read.
          </p>
        ) : transcriptError ? (
          <p role="alert" className="agent-absent">{transcriptError}</p>
        ) : transcript?.error ? (
          <p role="alert" className="agent-absent">{transcript.error}</p>
        ) : agentTranscript !== null && transcript !== undefined ? (
          <AgentChat
            rows={agentTranscript.rows}
            carry={transcript?.carry ?? ""}
            unreadableRecords={agentTranscript.unreadableRecords}
            hasRawText={transcript.text !== ""}
            rawText={transcript.text}
            emptyReason={transcript.text === "" ? "No transcript bytes received yet." : null}
          />
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
