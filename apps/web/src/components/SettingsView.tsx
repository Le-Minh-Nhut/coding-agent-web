import { useState, useEffect, useRef } from "react";
import { api } from "../api.js";
import type { AgentLimitResponse, RuntimeSnapshot } from "@caw/contracts";

interface SettingsViewProps {
  onBack: () => void;
  onLogout: () => void;
}

export function SettingsView({ onBack, onLogout }: SettingsViewProps) {
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * V25-06: a failed runtime read must not be rendered as an absence of engines.
   * `runtime === null` after the read says only that the read failed — the engine
   * cards must not turn that into "Missing", which claims the host has no OMP/tmux.
   * The error is surfaced instead, with a Retry that re-runs the same read.
   */
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  /** V25-06: newest-wins ordering for `loadRuntime` reads (see the guard there). */
  const runtimeReadSeqRef = useRef(0);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  /**
   * The agent concurrency limit.
   *
   * `saved` is the server's effective value and `draft` is what the stepper is
   * showing. They are separate on purpose: a pending change must be visibly
   * pending, and a failed save must leave the draft alone so the owner can retry
   * without losing what they typed.
   */
  const [limit, setLimitState] = useState<AgentLimitResponse | null>(null);
  const [limitDraft, setLimitDraft] = useState<number | null>(null);
  const [limitBusy, setLimitBusy] = useState(false);
  const [limitNotice, setLimitNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  /**
   * Confirms sign-out only when the session is actually gone. `api.logout` failing
   * says nothing about whether the server revoked it first — the network can die
   * after the revoke lands. So the deciding signal is an auth probe: a 401 proves
   * the session is finished even if the logout response never arrived, while any
   * answer (or no answer at all) means it may still be live and must not be
   * presented as signed out.
   */
  const signOut = async (): Promise<void> => {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError(null);
    const res = await api.logout();
    if (res.ok || res.httpStatus === 401) {
      // Confirmed revoke, or the session was already gone. Both are honest sign-outs.
      onLogout();
      return;
    }
    const probe = await api.getMe();
    setSigningOut(false);
    if (!probe.ok && probe.httpStatus === 401) {
      onLogout();
      return;
    }
    setSignOutError(res.error.message || "Sign out failed");
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (passwordBusy || newPassword.length < 12) return;
    setPasswordBusy(true);
    setPasswordMessage(null);
    const result = await api.changePassword(currentPassword, newPassword);
    setPasswordBusy(false);
    setPasswordMessage(result.ok ? "Password changed. Other sessions were signed out." : result.error.message);
    if (result.ok) {
      setCurrentPassword("");
      setNewPassword("");
    }
  };

  const loadRuntime = async (): Promise<void> => {
    // Only the newest read may publish. Retry is disabled while loading so a
    // human cannot overlap runs, but a programmatic overlap (mount + retry) could
    // otherwise let a slower earlier run land its stale error on top of a newer
    // snapshot, or vice versa.
    const readSeq = ++runtimeReadSeqRef.current;
    setLoading(true);
    setRuntimeError(null);
    const res = await api.getRuntime();
    if (runtimeReadSeqRef.current !== readSeq) return;
    setLoading(false);
    if (res.ok) setRuntime(res.data);
    else setRuntimeError(res.error.message || "Could not read runtime status.");
  };

  const loadAgentLimit = async (): Promise<void> => {
    // A rejected call must not escape as an unhandled rejection, and it must not
    // leave the card claiming a value nobody read. `limit === null` renders
    // "could not read the current limit", which is what a failure here means.
    try {
      const res = await api.getAgentLimit();
      if (!res?.ok) {
        setLimitNotice({ kind: "error", text: res?.error?.message || "Could not read the current limit." });
        return;
      }
      setLimitState(res.data);
      // Adopt the server value as the draft only when the owner has no pending edit.
      setLimitDraft((current) => (current === null ? res.data.limit : current));
    } catch (error) {
      setLimitNotice({ kind: "error", text: error instanceof Error ? error.message : "Could not read the current limit." });
    }
  };

  useEffect(() => {
    void loadRuntime();
    void loadAgentLimit();
  }, []);

  /** Clamp to the bounds the server reports, so the stepper cannot offer a value it will refuse. */
  const clampLimit = (value: number): number => {
    if (!limit) return value;
    return Math.min(limit.max, Math.max(limit.min, value));
  };

  const saveAgentLimit = async (): Promise<void> => {
    if (!limit || limitDraft === null || limitBusy) return;
    setLimitBusy(true);
    setLimitNotice(null);
    const res = await api.setAgentLimit(limitDraft);
    setLimitBusy(false);
    if (!res.ok) {
      // The draft is deliberately left as the owner set it: a failed save must not
      // silently discard their choice, and the effective value is unchanged.
      setLimitNotice({ kind: "error", text: res.error.message || "Could not save the limit." });
      return;
    }
    setLimitState(res.data);
    setLimitDraft(res.data.limit);
    setLimitNotice({ kind: "ok", text: `Limit saved. Effective now: ${res.data.limit}.` });
  };

  return (
    <div className="view-container">
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
        <button type="button" className="ghost" onClick={onBack}>
          ← Back
        </button>
        <h2>Runtime & Settings</h2>
      </div>

      {loading ? (
        <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          {runtimeError && (
            /* Not role="alert": this banner is not an error the user must act on
               before anything else; the message and the Retry button carry the
               failure. Failed-password and sign-out errors keep their own alert
               regions. */
            <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", borderColor: "var(--danger)" }}>
              <span>Runtime status unavailable: {runtimeError}</span>
              <button type="button" onClick={() => void loadRuntime()} disabled={loading}>Retry</button>
            </div>
          )}
          <form className="card" onSubmit={changePassword} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <h3 style={{ fontSize: "1rem" }}>Change password</h3>
            <label htmlFor="current-password">Current password</label>
            <input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required maxLength={1024} disabled={passwordBusy} />
            <label htmlFor="new-password">New password (12 characters minimum)</label>
            {/* V25-03: both inputs lock while the change is pending. The response
                clears them on success, so leaving them editable would let a user
                type a draft here that the success then silently wipes. Disabled
                (matching the button) keeps that draft from ever being typed. */}
            <input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} maxLength={1024} disabled={passwordBusy} />
            {passwordMessage && <p role={passwordMessage.startsWith("Password changed") ? "status" : "alert"}>{passwordMessage}</p>}
            <button type="submit" className="primary" disabled={passwordBusy || !currentPassword || newPassword.length < 12}>{passwordBusy ? "Changing…" : "Change password"}</button>
          </form>
          {/* Agent limits — a real server-enforced setting, not a display preference. */}
          <div className="card">
            <h3 style={{ marginBottom: "4px", fontSize: "1rem" }}>Agent limits</h3>
            <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginBottom: "12px" }}>
              How many CAW-managed main agents may run at once. Subagents and Vibe workers inside a
              session are not counted here.
            </p>

            {limit === null ? (
              <p style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>Could not read the current limit.</p>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
                  <span style={{ fontSize: "0.95rem" }}>
                    {/* `null` occupancy is "could not count", never "the machine is idle". */}
                    Active: <strong>{limit.activeCount === null ? "unknown" : limit.activeCount}</strong> / {limit.limit}
                  </span>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      type="button" className="ghost" aria-label="Decrease limit"
                      disabled={limitBusy || limitDraft === null || limitDraft <= limit.min}
                      onClick={() => setLimitDraft((value) => clampLimit((value ?? limit.limit) - 1))}
                    >
                      −
                    </button>
                    <input
                      aria-label="Maximum concurrent agents" type="number" inputMode="numeric"
                      min={limit.min} max={limit.max} value={limitDraft ?? limit.limit}
                      disabled={limitBusy}
                      style={{ width: "4.5rem", textAlign: "center" }}
                      onChange={(event) => {
                        // An empty field is a pending edit, not a zero: hold the value
                        // until it parses so clearing the box cannot save `0`.
                        const raw = Number.parseInt(event.target.value, 10);
                        setLimitDraft(Number.isFinite(raw) ? clampLimit(raw) : 0);
                      }}
                    />
                    <button
                      type="button" className="ghost" aria-label="Increase limit"
                      disabled={limitBusy || limitDraft === null || limitDraft >= limit.max}
                      onClick={() => setLimitDraft((value) => clampLimit((value ?? limit.limit) + 1))}
                    >
                      +
                    </button>
                  </div>
                </div>

                <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "8px" }}>
                  {limit.source === "setting" ? "Persisted setting" : `Server default (${limit.fallback})`}
                  {" · "}allowed range {limit.min}–{limit.max}
                </p>

                {/* Occupancy above the limit is normal after lowering it: running agents
                    are preserved, and only new launches wait. */}
                {limit.overLimit && (
                  <p role="status" style={{ fontSize: "0.8rem", color: "var(--warning-text, #d29922)", marginTop: "6px" }}>
                    {limit.activeCount} agents are running, above this limit. They are left alone; no new agent
                    can start until the count drops below {limit.limit}.
                  </p>
                )}
                {limit.activeCountReason && (
                  <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", marginTop: "6px" }}>{limit.activeCountReason}</p>
                )}

                {limitDraft !== null && limitDraft !== limit.limit && (
                  <p role="status" style={{ fontSize: "0.82rem", marginTop: "8px" }}>
                    Pending change: {limit.limit} → <strong>{limitDraft}</strong>
                  </p>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "12px" }}>
                  <button
                    type="button" className="primary"
                    disabled={limitBusy || limitDraft === null || limitDraft === limit.limit}
                    onClick={() => void saveAgentLimit()}
                  >
                    {limitBusy ? "Saving…" : "Save changes"}
                  </button>
                  {limitDraft !== null && limitDraft !== limit.limit && (
                    <button type="button" className="ghost" disabled={limitBusy} onClick={() => { setLimitDraft(limit.limit); setLimitNotice(null); }}>
                      Reset
                    </button>
                  )}
                </div>
                {limitNotice && (
                  <p role={limitNotice.kind === "ok" ? "status" : "alert"} style={{ fontSize: "0.85rem", marginTop: "8px" }}>
                    {limitNotice.text}
                  </p>
                )}
              </>
            )}
          </div>

          {/* Capabilities Report */}
          <div className="card">
            <h3 style={{ marginBottom: "12px", fontSize: "1rem" }}>Capabilities</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "0.9rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>OMP Engine:</span>
                <span>
                  {/* V25-06: no snapshot at all (still loading, or the read failed —
                      the alert above says which) is not evidence that the engine is
                      absent. "Unknown" keeps the failed read from becoming a claim. */}
                  {runtime === null ? (
                    <span style={{ color: "var(--text-muted)" }}>Unknown</span>
                  ) : runtime.capabilities.omp.available ? (
                    <span style={{ color: "var(--success)" }}>Available ({runtime.capabilities.omp.version ?? "installed"})</span>
                  ) : (
                    <span style={{ color: "var(--danger-text)" }}>Missing</span>
                  )}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>tmux Runner:</span>
                <span>
                  {runtime === null ? (
                    <span style={{ color: "var(--text-muted)" }}>Unknown</span>
                  ) : runtime.capabilities.tmux.available ? (
                    <span style={{ color: "var(--success)" }}>Available ({runtime.capabilities.tmux.version ?? "installed"})</span>
                  ) : (
                    <span style={{ color: "var(--danger-text)" }}>Missing</span>
                  )}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Relay Service:</span>
                <span>
                  {runtime === null ? (
                    <span style={{ color: "var(--text-muted)" }}>Unknown</span>
                  ) : runtime.capabilities.relay.configured ? (
                    <span style={{ color: "var(--success)" }}>Configured</span>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>Loopback default</span>
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Link-Secrecy Explainer */}
          <div className="card" style={{ borderColor: "#2a3b5c", backgroundColor: "#111827" }}>
            <h3 style={{ marginBottom: "8px", fontSize: "1rem", color: "#58a6ff" }}>
              🔒 Bearer Link Secrecy
            </h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
              Collab session links contain raw 256-bit encryption keys and write tokens. To guarantee zero leakage:
            </p>
            <ul style={{ fontSize: "0.85rem", color: "var(--text-muted)", margin: "8px 0 8px 20px", lineHeight: 1.6 }}>
              <li>Links are held in ephemeral tab memory only.</li>
              <li>Never saved to localStorage, sessionStorage, IndexedDB, or cookies.</li>
              <li>Never rendered into the DOM, URLs, or browser history.</li>
              <li>All API state mutations require valid CSRF headers.</li>
            </ul>
          </div>

          {/* Logout */}
          <div style={{ marginTop: "16px" }}>
            {signOutError && (
              <p role="alert" style={{ color: "var(--danger-text)", marginBottom: "8px" }}>{signOutError}</p>
            )}
            <button
              type="button"
              className="danger"
              style={{ width: "100%" }}
              disabled={signingOut}
              onClick={() => void signOut()}
            >
              {signingOut ? "Signing out…" : signOutError ? "Retry sign out" : "Sign out"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
