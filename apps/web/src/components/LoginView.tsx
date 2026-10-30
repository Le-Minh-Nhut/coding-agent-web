import React, { useState } from "react";
import { api } from "../api.js";

interface LoginViewProps {
  onSuccess: () => void;
  setupRequired?: boolean;
  setupUnavailable?: boolean;
}

export function LoginView({ onSuccess, setupRequired = false, setupUnavailable = false }: LoginViewProps) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [setup, setSetup] = useState(setupRequired);
  const [unavailable, setUnavailable] = useState(setupUnavailable);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || loading) return;
    setLoading(true);
    setError(null);
    const result = await api.login(password);
    setLoading(false);
    if (result.ok) {
      if (result.data.status === "password_setup_required") setSetup(true);
      else onSuccess();
    } else setError(result.error.message || "Sign in failed");
  };

  const handleSetPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading || password.length < 12) return;
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    setError(null);
    const result = await api.setPassword(password);
    setLoading(false);
    if (result.ok) {
      setPassword("");
      setConfirmation("");
      onSuccess();
      return;
    }
    setError(result.error.message || "Password setup failed");
    if (result.error.code === "csrf" || result.error.code === "unauthorized") {
      const refreshed = await api.getMe();
      if (!refreshed.ok && refreshed.httpStatus === 403) setUnavailable(true);
    }
  };

  const handleRetrySession = async () => {
    setLoading(true);
    setError(null);
    const result = await api.getMe();
    setLoading(false);
    if (result.ok) {
      setSetup(true);
      setUnavailable(false);
    } else setError(result.error.message || "Unable to restore password setup session");
  };

  return (
    <div className="view-container" style={{ justifyContent: "center", alignItems: "center" }}>
      <div className="card" style={{ width: "100%", maxWidth: "360px" }}>
        <h2 style={{ marginBottom: "16px", textAlign: "center" }}>Coding Agent Web</h2>
        <p style={{ color: "var(--text-muted)", marginBottom: "20px", textAlign: "center", fontSize: "0.9rem" }}>Single-owner control plane for OMP</p>
        {unavailable ? (
          <div role="alert">
            <p>Password setup session cannot be restored by this server. Reopen the setup link or CLI on the host, then sign in again.</p>
            <button type="button" className="primary" onClick={handleRetrySession} disabled={loading}>Retry setup session</button>
          </div>
        ) : (
          <form onSubmit={setup ? handleSetPassword : handleLogin} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            <div>
              <label htmlFor="password-input" style={{ display: "block", marginBottom: "6px", fontSize: "0.85rem", color: "var(--text-muted)" }}>{setup ? "Choose a password (12 characters minimum)" : "Password"}</label>
              <input id="password-input" type="password" placeholder={setup ? "Choose owner password" : "Enter workspace password"} value={password} onChange={(event) => setPassword(event.target.value)} disabled={loading} autoFocus required minLength={setup ? 12 : undefined} />
            </div>
            {setup && (
              <div>
                <label htmlFor="password-confirmation" style={{ display: "block", marginBottom: "6px", fontSize: "0.85rem", color: "var(--text-muted)" }}>Confirm password</label>
                <input id="password-confirmation" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={loading} required minLength={12} />
              </div>
            )}
            {error && <div role="alert" style={{ color: "var(--danger-text)", fontSize: "0.9rem", padding: "8px", backgroundColor: "rgba(218,54,51,0.1)", borderRadius: "var(--radius)" }}>{error}</div>}
            <button type="submit" className="primary" disabled={loading || (setup && password !== confirmation)} style={{ marginTop: "8px" }}>{loading ? "Please wait…" : setup ? "Set password" : "Sign in"}</button>
          </form>
        )}
      </div>
    </div>
  );
}
