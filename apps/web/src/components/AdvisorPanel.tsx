/**
 * Advisor panel — what the pinned OMP actually lets a remote host see and do.
 *
 * The honest split, established by reading the installed binary (18.15.0) and
 * probing it with a real extension, and kept visible in this UI rather than
 * smoothed over:
 *
 *  - **Notes are readable.** Every advisor turn is persisted into the session
 *    journal as a `custom_message` with `customType: "advisor"` whose `details`
 *    carry the structured `{ severity, advisor, note, turns_ago }` list
 *    (`session/session-advisors.ts`, emitted at :1712 and :1895). The Collab wire
 *    replicates `custom_message` entries, so these arrive without any new
 *    transport — the row for a note is rendered from real journal data.
 *  - **The toggle is a terminal/config operation.** `/advisor on|off` calls
 *    `session.setAdvisorEnabled`, which exists only on the in-process
 *    `AgentSession` (`session/agent-session.ts:15143`). No extension surface
 *    exposes it (probed: `ctx.session` is `undefined`; no advisor key on `pi` or
 *    `pi.runtime`), and the Collab wire has no advisor frame
 *    (`packages/wire/src/index.ts:340-344`). So this panel does NOT offer a
 *    button that pretends to toggle it. It says where the toggle lives and shows
 *    what can be observed.
 *
 * Showing a switch that cannot move would be worse than showing none: the user
 * would believe a safety review was running when it was not.
 */
import { useMemo, useState } from "react";
import { ModalOverlay } from "./ModalOverlay.js";
import type { AdvisorNote, AdvisorSummary } from "../advisor.js";

interface AdvisorPanelProps {
  summary: AdvisorSummary;
  onClose: () => void;
}

const SEVERITY_ORDER: Record<string, number> = { blocker: 0, concern: 1, nit: 2 };

/** The badge class for a severity; unknown severities read as a nit, never as worse. */
function severityClass(severity: AdvisorNote["severity"]): string {
  return severity === "blocker" ? "error" : severity === "concern" ? "warning" : "idle";
}

export function AdvisorPanel({ summary, onClose }: AdvisorPanelProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const notes = useMemo(
    () => [...summary.notes].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3)),
    [summary.notes],
  );

  return (
    <ModalOverlay onClose={onClose} aria-labelledby="advisor-title" overlayProps={{ className: "modal-overlay" }}>
      <div className="modal-content" style={{ maxWidth: "600px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <h3 id="advisor-title">Advisor</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close advisor">✕</button>
        </div>

        {/* Activity, not enablement. `notes` proves an advisor ran and produced
            output for this session; it cannot prove one is running right now,
            because nothing on this transport reports the enable flag. The copy
            says exactly that instead of implying a live switch. */}
        <div className="advisor-status">
          <span className={`badge ${summary.notes.length > 0 ? "idle" : "unknown"}`}>
            {summary.notes.length > 0 ? "Notes recorded" : "No notes recorded"}
          </span>
          <span className="advisor-status-detail">
            {summary.notes.length > 0
              ? `${summary.notes.length} advisor note${summary.notes.length === 1 ? "" : "s"} in this session's history.`
              : "This session's history contains no advisor notes."}
          </span>
        </div>

        {summary.advisors.length > 0 && (
          <section className="advisor-section" aria-label="Advisors that produced notes">
            <h4>Advisors seen in this session</h4>
            <ul className="advisor-list">
              {summary.advisors.map((name) => <li key={name}>{name}</li>)}
            </ul>
          </section>
        )}

        <section className="advisor-section" aria-label="Recent advisor notes">
          <h4>Recent notes</h4>
          {notes.length === 0 ? (
            <p className="advisor-empty">
              No advisor notes in this session. An advisor only writes here when the
              subsystem is enabled and it has something to say.
            </p>
          ) : (
            <ul className="advisor-notes">
              {notes.map((note, index) => (
                <li key={`${note.advisor ?? "advisor"}:${index}`}>
                  <button
                    type="button"
                    className="advisor-note-head"
                    aria-expanded={expanded === index}
                    onClick={() => setExpanded(expanded === index ? null : index)}
                  >
                    <span className={`badge ${severityClass(note.severity)}`}>{note.severity}</span>
                    {note.advisor !== null && <span className="advisor-note-owner">{note.advisor}</span>}
                    <span className="advisor-note-text">{note.note.split("\n", 1)[0]}</span>
                    <span className="advisor-note-chevron" aria-hidden="true">{expanded === index ? "▾" : "›"}</span>
                  </button>
                  {expanded === index && (
                    <div className="advisor-note-body">
                      <p>{note.note}</p>
                      {note.turnsAgo !== null && <p className="advisor-note-meta">from {note.turnsAgo} turn{note.turnsAgo === 1 ? "" : "s"} ago</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Where the controls that are NOT reachable from here actually live. Said
            plainly, with the reason, so the absence reads as a known limit rather
            than a missing button. */}
        <section className="advisor-section" aria-label="Where advisor controls live">
          <h4>Controlling the advisor</h4>
          <p>
            The advisor's on/off switch and its configuration editor belong to the OMP
            terminal session; they are not exposed to a remote host, so they cannot be
            driven from here. Run <code>/advisor on</code>, <code>/advisor off</code>,{" "}
            <code>/advisor status</code>, <code>/advisor dump</code> or{" "}
            <code>/advisor configure</code> in the session's own terminal.
          </p>
          <p className="advisor-status-detail">
            Why: <code>/advisor</code> calls into the running agent process, and the
            control link this app holds (OMP Collab) carries conversation frames only —
            no advisor frame exists. Typing it here would send the text to the model as
            a prompt instead, so this app does not offer that.
          </p>
        </section>
      </div>
    </ModalOverlay>
  );
}
