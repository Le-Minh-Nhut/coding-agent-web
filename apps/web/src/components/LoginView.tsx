import React, { useState } from "react";
import { api } from "../api.js";

interface LoginViewProps {
  onSuccess: () => void;
}

export function LoginView({ onSuccess }: LoginViewProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || loading) return;
    setLoading(true);
    setError(null);

    const res = await api.login(password);
    setLoading(false);

    if (res.ok) {
      onSuccess();
      return;
    }

    if (res.error.code === "conflict_limit" || res.error.message.toLowerCase().includes("rate limit") || res.error.message.toLowerCase().includes("too many")) {
      setError("Rate limit exceeded. Please wait before retrying.");
    } else {
      setError(res.error.message || "Invalid password");
    }
  };

  return (
    <div className="view-container" style={{ justifyContent: "center", alignItems: "center" }}>
      <div className="card" style={{ width: "100%", maxWidth: "360px" }}>
        <h2 style={{ marginBottom: "16px", textAlign: "center" }}>Coding Agent Web</h2>
        <p style={{ color: "var(--text-muted)", marginBottom: "20px", textAlign: "center", fontSize: "0.9rem" }}>
          Single-owner control plane for OMP
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label htmlFor="password-input" style={{ display: "block", marginBottom: "6px", fontSize: "0.85rem", color: "var(--text-muted)" }}>
              Password
            </label>
            <input
              id="password-input"
              type="password"
              placeholder="Enter workspace password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              autoFocus
              required
            />
          </div>

          {error && (
            <div role="alert" style={{ color: "var(--danger)", fontSize: "0.9rem", padding: "8px", backgroundColor: "rgba(218,54,51,0.1)", borderRadius: "var(--radius)" }}>
              {error}
            </div>
          )}

          <button type="submit" className="primary" disabled={loading} style={{ marginTop: "8px" }}>
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
