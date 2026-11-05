/**
 * Vibe mode panel — the native director/worker mode, driven through the control
 * bridge.
 *
 * Vibe is a real session mode, not a writing style: entering it reduces the
 * director's own toolset to `read` (+ optional parent `todo`) plus the five
 * worker tools, and the workers are persistent subagent sessions
 * (`docs/vibe-mode.md`). So the panel's job is to show real mode state and the
 * real worker roster, and to make the four different "stop"s impossible to
 * confuse:
 *
 *   - exit vibe mode      → cancels in-flight worker turns, keeps their transcripts
 *   - stop generating     → ends the director's current turn only
 *   - kill one worker     → ends that worker, keeps its transcript at history://
 *   - stop OMP session    → ends the process (the existing, separate action)
 *
 * Every state shown comes from the bridge (`ctx.sessionModes.getState()` in the
 * live process). When the bridge cannot be asked the panel says so and offers no
 * switch — an unavailable bridge is not "off".
 */
import { useMemo, useState } from "react";
import type { AgentView } from "../agent-model.js";
import type { NativeModeResult, NativeModeState, VibeStateResponse } from "@caw/contracts";
import { ModalOverlay } from "./ModalOverlay.js";

interface VibePanelProps {
  state: VibeStateResponse | null;
  /** Set while a transition is in flight, so controls cannot double-fire. */
  busy: boolean;
  /** The last refusal or failure from the server, verbatim. */
  error: string | null;
  /** True when the conversation's own record forbids controlling it. */
  readOnly: boolean;
  /**
   * Classified agent views, **not** the raw roster.
   *
   * This is the B01 gate: a row is only killable when `canKillWorker` is true,
   * which only `agent-model.ts` sets from journal evidence. The panel never
   * decides classification itself, so a main agent or an ordinary subagent can
   * never reach the Kill control.
   */
  workers: AgentView[];
  /**
   * Enter vibe mode, with the optional first directive.
   *
   * The directive is NOT a separate call: it is handed to the same transition so
   * it can only be delivered once OMP has confirmed the mode is on. A separate
   * "send directive" callback would fire even when the enter was refused.
   */
  onEnter: (directive?: string) => void;
  onExit: () => void;
  onKillWorker: (workerId: string) => void;
  onOpenWorkers: () => void;
  onClose: () => void;
}

/** A human label for the native refusal codes, without inventing a cause. */
export function vibeVerdictLabel(result: NativeModeResult): string {
  switch (result.code) {
    case "busy":
      return result.message ?? "The session is busy; try again once it settles.";
    case "conflict":
      return result.message ?? "Another mode blocks vibe mode. Exit plan or goal mode first.";
    case "disabled":
      return result.message ?? "Vibe mode is disabled by configuration.";
    case "invalid_request":
      return result.message ?? "OMP rejected the request as not applicable now.";
    default:
      return result.message ?? "OMP refused the transition.";
  }
}

function vibeStatus(state: VibeStateResponse | null): "on" | "off" | "unknown" {
  if (state === null || !state.available || state.modes === null) return "unknown";
  return state.modes.vibe.status === "active" ? "on" : "off";
}

/** Modes that block entering vibe, from OMP's own state — the reason, not a guess. */
function blockingModes(state: NativeModeState | null): string[] {
  if (state === null) return [];
  const blocking: string[] = [];
  if (state.plan.status !== "inactive") blocking.push("plan");
  if (state.goal.status !== "inactive") blocking.push("goal");
  return blocking;
}

export function VibePanel({
  state,
  busy,
  error,
  readOnly,
  workers,
  onEnter,
  onExit,
  onKillWorker,
  onOpenWorkers,
  onClose,
}: VibePanelProps) {
  const [directive, setDirective] = useState("");
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [confirmingKill, setConfirmingKill] = useState<string | null>(null);
  const status = vibeStatus(state);
  const blocked = useMemo(() => blockingModes(state?.modes ?? null), [state]);
  const running = workers.filter((worker) => worker.status === "running");

  return (
    <ModalOverlay onClose={onClose} aria-labelledby="vibe-title" overlayProps={{ className: "modal-overlay" }}>
      <div className="modal-content" style={{ maxWidth: "600px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <h3 id="vibe-title">Vibe mode</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close vibe mode">✕</button>
        </div>

        <div className="advisor-status">
          <span className={`badge ${status === "on" ? "running" : status === "off" ? "idle" : "unknown"}`}>
            {status === "on" ? "● On" : status === "off" ? "Off" : "Unknown"}
          </span>
          <span className="advisor-status-detail">
            {status === "unknown"
              ? state?.reason ?? "The control bridge did not answer, so the mode could not be read."
              : status === "on"
                ? "The director coordinates persistent fast/good workers; its own toolset is read-only plus the worker tools."
                : "Director coordinates persistent workers. Off: this session edits and runs commands itself."}
          </span>
        </div>

        {error !== null && <div className="banner error" role="alert">{error}</div>}

        {status === "unknown" && (
          <p className="advisor-status-detail">
            Nothing here is a switch until the bridge answers. A session launched before the
            control bridge existed, or one whose listener has stopped, reports unknown — never
            &ldquo;off&rdquo;, because a mode that was never read is not a mode that is off.
          </p>
        )}

        {status === "off" && (
          <section className="advisor-section" aria-label="Enable vibe mode">
            {blocked.length > 0 ? (
              // OMP refuses to enter vibe while plan/goal is active OR paused
              // (docs/vibe-mode.md). Say which one blocks, from the observed
              // state, instead of offering a button that will be refused.
              <p className="advisor-status-detail" role="status">
                Vibe mode cannot start while {blocked.join(" and ")} mode is active or paused.
                Exit {blocked.length === 1 ? "it" : "them"} first.
              </p>
            ) : (
              <>
                <h4>Enter vibe mode</h4>
                <label htmlFor="vibe-directive">First directive (optional)</label>
                <input
                  id="vibe-directive"
                  value={directive}
                  maxLength={2000}
                  onChange={(event) => setDirective(event.target.value)}
                  placeholder="e.g. fix the flaky test in packages/tui"
                />
                <button
                  type="button"
                  disabled={busy || readOnly}
                  onClick={() => {
                    // One call, two effects, in the order that matters: the mode is
                    // switched first and the directive is only delivered once OMP
                    // confirms it. Native `/vibe <prompt>` does both in one
                    // keystroke, but that handler is TUI-only, so this app reaches
                    // the same end state through the path it actually has.
                    const pending = directive.trim();
                    onEnter(pending === "" ? undefined : pending);
                  }}
                >
                  {busy ? "Entering…" : "Enable Vibe"}
                </button>
                <p className="advisor-status-detail">
                  The mode is switched first; a directive is sent as this session's next
                  prompt (the same path a typed message takes) and only after OMP confirms
                  the mode is on. If the switch is refused, nothing is sent.
                </p>
              </>
            )}
          </section>
        )}

        {status === "on" && (
          <>
            <section className="advisor-section" aria-label="Vibe workers">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h4>Workers ({workers.length})</h4>
                <button type="button" className="ghost" onClick={onOpenWorkers}>View workers</button>
              </div>
              {workers.length === 0 ? (
                <p className="advisor-status-detail">No workers spawned yet. The director spawns them as it splits the work.</p>
              ) : (
                <ul className="vibe-workers">
                  {workers.map((worker) => (
                    <li key={worker.id} className="vibe-worker">
                      <span className={`badge ${worker.status}`}>{worker.status}</span>
                      <span className="vibe-worker-name">{worker.displayName}</span>
                      {/* Two conditions, both required: the agent is a **proven**
                          Vibe worker (`canKillWorker`, from journal evidence) and it
                          is running a turn. Killing an idle one would imply it
                          stopped something; killing an unproven one could stop the
                          session's own agent. */}
                      {worker.canKillWorker && worker.status === "running" && (
                        <button
                          type="button"
                          className="ghost"
                          disabled={busy || readOnly}
                          onClick={() => setConfirmingKill(worker.id)}
                        >
                          Kill
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {confirmingExit ? (
              <section className="card handoff-confirm" role="group" aria-label="Confirm exit vibe mode">
                <strong>Exit vibe mode</strong>
                {/* The destructive half is worker cancellation, so it is named
                    before the action, and only when there is something to cancel. */}
                <p>
                  {running.length > 0
                    ? `Exiting Vibe mode will cancel ${running.length} active worker turn${running.length === 1 ? "" : "s"}. `
                    : "No worker turn is in flight. "}
                  Each worker's transcript is kept and stays readable afterwards.
                </p>
                <div className="history-actions">
                  <button type="button" className="danger" disabled={busy || readOnly} onClick={() => { setConfirmingExit(false); onExit(); }}>
                    {busy ? "Exiting…" : "Exit vibe mode"}
                  </button>
                  <button type="button" className="ghost" onClick={() => setConfirmingExit(false)}>Cancel</button>
                </div>
              </section>
            ) : (
              <button type="button" className="danger" disabled={busy || readOnly} onClick={() => setConfirmingExit(true)}>
                Exit Vibe
              </button>
            )}
          </>
        )}

        {confirmingKill !== null && (
          <section className="card handoff-confirm" role="group" aria-label="Confirm kill worker">
            <strong>Kill this worker</strong>
            <p>
              Ends this worker and cancels its turn. Its transcript is retained and stays
              readable; the director session and the other workers are unaffected.
            </p>
            <div className="history-actions">
              <button type="button" className="danger" disabled={busy || readOnly} onClick={() => { const id = confirmingKill; setConfirmingKill(null); onKillWorker(id); }}>
                Kill worker
              </button>
              <button type="button" className="ghost" onClick={() => setConfirmingKill(null)}>Cancel</button>
            </div>
          </section>
        )}

        {state?.tools != null && (
          <section className="advisor-section" aria-label="Director toolset">
            <h4>Director toolset</h4>
            {/* Observed, not asserted: this is what the process reports right now. */}
            <p className="advisor-status-detail">{state.tools.join(", ")}</p>
            {state.model !== null && <p className="advisor-status-detail">Director model: {state.model}{state.thinkingLevel !== null ? ` · ${state.thinkingLevel}` : ""}</p>}
          </section>
        )}
      </div>
    </ModalOverlay>
  );
}
