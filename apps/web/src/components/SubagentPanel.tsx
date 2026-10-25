import { useState } from "react";
import type { AgentSnapshot } from "@caw/collab-protocol";

interface SubagentPanelProps {
  agents: AgentSnapshot[];
  onFetchTranscript: (agentId: string) => void;
  transcripts: Record<string, string>;
  transcriptErrors: Record<string, string>;
  loadingAgentIds: string[];
  onClose: () => void;
}
export function SubagentPanel({
  agents,
  onFetchTranscript,
  transcripts,
  transcriptErrors,
  loadingAgentIds,
  onClose,
}: SubagentPanelProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  const currentTranscript = selectedAgentId ? transcripts[selectedAgentId] : undefined;

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: "600px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <h3>Subagents ({agents.length})</h3>
          <button type="button" className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        {selectedAgent ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <button
                type="button"
                className="ghost"
                style={{ padding: "4px 8px" }}
                onClick={() => setSelectedAgentId(null)}
              >
                ← Back
              </button>
              <h4>{selectedAgent.displayName}</h4>
              <span className={`badge ${selectedAgent.status}`}>{selectedAgent.status}</span>
            </div>

            <div style={{ marginTop: "12px" }}>
              <h5 style={{ marginBottom: "6px" }}>Transcript</h5>
              {transcriptErrors[selectedAgent.id] ? (
                <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)" }}>
                  <p role="alert">{transcriptErrors[selectedAgent.id]}</p>
                  <button type="button" className="primary" disabled={loadingAgentIds.includes(selectedAgent.id)} onClick={() => onFetchTranscript(selectedAgent.id)}>
                    {loadingAgentIds.includes(selectedAgent.id) ? "Loading transcript…" : "Retry transcript"}
                  </button>
                </div>
              ) : currentTranscript !== undefined ? (
                <pre style={{ maxHeight: "300px", overflowY: "auto" }}>
                  <code>{currentTranscript}</code>
                </pre>
              ) : (
                <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)" }}>
                  <button type="button" className="primary" disabled={loadingAgentIds.includes(selectedAgent.id)} onClick={() => onFetchTranscript(selectedAgent.id)}>
                    {loadingAgentIds.includes(selectedAgent.id) ? "Loading transcript…" : "Load Transcript"}
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "350px", overflowY: "auto" }}>
            {agents.length === 0 ? (
              <p style={{ color: "var(--text-muted)", textAlign: "center", padding: "20px" }}>
                No active subagents.
              </p>
            ) : (
              agents.map((agent) => (
                <div
                  key={agent.id}
                  className="card"
                  style={{ cursor: "pointer", padding: "12px", marginBottom: "4px" }}
                  onClick={() => {
                    setSelectedAgentId(agent.id);
                    if (!transcripts[agent.id]) {
                      onFetchTranscript(agent.id);
                    }
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 600 }}>{agent.displayName}</span>
                    <span className={`badge ${agent.status}`}>{agent.status}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
