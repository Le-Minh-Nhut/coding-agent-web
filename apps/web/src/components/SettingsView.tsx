import { useState, useEffect } from "react";
import { api } from "../api.js";
import type { RuntimeSnapshot } from "@caw/contracts";

interface SettingsViewProps {
  onBack: () => void;
  onLogout: () => void;
}

export function SettingsView({ onBack, onLogout }: SettingsViewProps) {
  const [runtime, setRuntime] = useState<RuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

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

  useEffect(() => {
    api.getRuntime().then((res) => {
      setLoading(false);
      if (res.ok) setRuntime(res.data);
    });
  }, []);

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
          <form className="card" onSubmit={changePassword} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <h3 style={{ fontSize: "1rem" }}>Change password</h3>
            <label htmlFor="current-password">Current password</label>
            <input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required maxLength={1024} />
            <label htmlFor="new-password">New password (12 characters minimum)</label>
            <input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} maxLength={1024} />
            {passwordMessage && <p role={passwordMessage.startsWith("Password changed") ? "status" : "alert"}>{passwordMessage}</p>}
            <button type="submit" className="primary" disabled={passwordBusy || !currentPassword || newPassword.length < 12}>{passwordBusy ? "Changing…" : "Change password"}</button>
          </form>
          {/* Active Conversations Capacity */}
          <div className="card">
            <h3 style={{ marginBottom: "8px", fontSize: "1rem" }}>Capacity</h3>
            <p style={{ fontSize: "0.95rem" }}>
              {/* `null` means we could not enumerate running agents. Rendering that
                  as 0 would claim the machine is idle and invite another launch. */}
              Active conversations:{" "}
              <strong>{runtime?.activeCount === null || runtime?.activeCount === undefined ? "unknown" : runtime.activeCount}</strong>{" "}
              / {runtime?.maxActive ?? 3}
            </p>
            {runtime?.activeCountReason && (
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "4px" }}>{runtime.activeCountReason}</p>
            )}
          </div>

          {/* Capabilities Report */}
          <div className="card">
            <h3 style={{ marginBottom: "12px", fontSize: "1rem" }}>Capabilities</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "0.9rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>OMP Engine:</span>
                <span>
                  {runtime?.capabilities.omp.available ? (
                    <span style={{ color: "var(--success)" }}>Available ({runtime.capabilities.omp.version ?? "installed"})</span>
                  ) : (
                    <span style={{ color: "var(--danger)" }}>Missing</span>
                  )}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>tmux Runner:</span>
                <span>
                  {runtime?.capabilities.tmux.available ? (
                    <span style={{ color: "var(--success)" }}>Available ({runtime.capabilities.tmux.version ?? "installed"})</span>
                  ) : (
                    <span style={{ color: "var(--danger)" }}>Missing</span>
                  )}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Relay Service:</span>
                <span>
                  {runtime?.capabilities.relay.configured ? (
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
              <p role="alert" style={{ color: "var(--danger)", marginBottom: "8px" }}>{signOutError}</p>
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
