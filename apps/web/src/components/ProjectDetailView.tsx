import { useState, useEffect } from "react";
import { api } from "../api.js";
import type { Conversation, NativeSessionSummary, ProjectWithStats } from "@caw/contracts";

interface ProjectDetailViewProps {
  projectId: string;
  onBack: () => void;
  onSelectConversation: (conversationId: string) => void;
}

export function ProjectDetailView({
  projectId,
  onBack,
  onSelectConversation,
}: ProjectDetailViewProps) {
  const [project, setProject] = useState<ProjectWithStats | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nativeSessions, setNativeSessions] = useState<NativeSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    const [projRes, convRes, sessRes] = await Promise.all([
      api.listProjects(),
      api.listConversations(projectId),
      api.listNativeSessions(projectId),
    ]);
    setLoading(false);

    if (projRes.ok) {
      const found = projRes.data.find((p) => p.id === projectId);
      if (found) setProject(found);
    }
    if (convRes.ok) {
      setConversations(convRes.data);
    }
    if (sessRes.ok) {
      setNativeSessions(sessRes.data);
    }
  };

  useEffect(() => {
    loadData();
  }, [projectId]);

  const handleNewChat = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);

    const res = await api.createConversation(projectId, "New chat");
    setCreating(false);
    if (res.ok) onSelectConversation(res.data.id);
    else setError(res.error.message || "Failed to create conversation");
  };

  const handleResume = async (session: NativeSessionSummary) => {
    if (resumingSessionId || session.tracked) return;
    setResumingSessionId(session.sessionId);
    setError(null);
    const result = await api.createConversation(projectId, session.title ?? "Resumed session", session.sessionId);
    setResumingSessionId(null);
    if (result.ok) onSelectConversation(result.data.id);
    else if (result.error.code === "conflict_owner") {
      setError("This session already has a writer or its lease cannot be verified. Attach in the terminal instead; no second agent was started.");
    } else setError(result.error.message);
  };

  return (
    <div className="view-container">
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
        <button type="button" className="ghost" onClick={onBack} title="Back to projects">
          ← Back
        </button>
        <div>
          <h2>{project ? project.label : "Project"}</h2>
          {project && (
            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", wordBreak: "break-all" }}>
              {project.path}
            </p>
          )}
        </div>
      </div>

      {error && (
        <div role="alert" style={{ color: "var(--danger)", padding: "10px", backgroundColor: "rgba(218,54,51,0.1)", borderRadius: "var(--radius)", marginBottom: "12px" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <h3>Conversations</h3>
        <button type="button" className="primary" onClick={handleNewChat} disabled={creating}>
          {creating ? "Starting…" : "+ New chat"}
        </button>
      </div>

      {loading ? (
        <div style={{ padding: "24px", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>
      ) : conversations.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "30px 16px" }}>
          <p style={{ color: "var(--text-muted)", marginBottom: "12px" }}>No conversations yet.</p>
          <button type="button" className="primary" onClick={handleNewChat} disabled={creating}>
            Start first chat
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "24px" }}>
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className="card"
              style={{ cursor: "pointer", transition: "border-color 0.15s" }}
              onClick={() => onSelectConversation(conv.id)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                <h4 style={{ fontSize: "0.95rem" }}>{conv.title}</h4>
                <span className={`badge ${conv.state}`}>{conv.state}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                <span>{conv.model ?? "Default model"}</span>
                {conv.lastActivityAt && <span>{new Date(conv.lastActivityAt).toLocaleDateString()}</span>}
              </div>
              {conv.statusDetail && (
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "6px" }}>
                  {conv.statusDetail}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Native OMP Sessions */}
      {nativeSessions.length > 0 && (
        <div style={{ marginTop: "12px" }}>
          <h3 style={{ marginBottom: "10px", fontSize: "1rem" }}>Native OMP Sessions</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {nativeSessions.map((sess) => (
              <div key={sess.sessionId} className="card" style={{ padding: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                  <span style={{ fontSize: "0.9rem", fontWeight: 500 }}>
                    {sess.title || sess.sessionId.slice(0, 8)}
                  </span>
                  <div style={{ display: "flex", gap: "4px" }}>
                    {/* `"unknown"` is a truthy string, so a naive check would label an
                        unverifiable session as live. Each case gets its own badge:
                        live means a writer exists, unknown means we could not tell. */}
                    {sess.live === true && <span className="badge live">live</span>}
                    {sess.live === "unknown" && <span className="badge unknown">unknown</span>}
                    {sess.tracked && <span className="badge tracked">tracked</span>}
                  </div>
                </div>
                <p style={{ fontSize: "0.75rem", color: "var(--text-muted)", wordBreak: "break-all" }}>
                  {sess.path}
                </p>
                {!sess.tracked && sess.live !== false && (
                  <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                    {sess.live === true
                      ? "This session already has a writer. Attach in the terminal instead."
                      : "Writer lease could not be verified. Resume is disabled to prevent a second writer."}
                  </p>
                )}
                {!sess.tracked && sess.live === false && (
                  <button
                    type="button"
                    className="primary"
                    disabled={resumingSessionId !== null}
                    onClick={() => handleResume(sess)}
                  >
                    {resumingSessionId === sess.sessionId ? "Resuming…" : "Resume in app"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
