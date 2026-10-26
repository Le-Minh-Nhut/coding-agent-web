import { useEffect, useRef, useState } from "react";
import type { AgentSnapshot } from "@caw/collab-protocol";
import type { TranscriptReply } from "../transcript.js";

interface SubagentPanelProps {
  agents: AgentSnapshot[];
  onFetchTranscript: (agentId: string, fromByte: number) => void;
  onWatchAgent: (agentId: string | null) => void;
  transcripts: Record<string, TranscriptReply>;
  transcriptErrors: Record<string, string>;
  loadingAgentIds: string[];
  onClose: () => void;
}

const TRANSCRIPT_POLL_MS = 1200;

export function SubagentPanel({
  agents,
  onFetchTranscript,
  onWatchAgent,
  transcripts,
  transcriptErrors,
  loadingAgentIds,
  onClose,
}: SubagentPanelProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const fetchRef = useRef(onFetchTranscript);
  fetchRef.current = onFetchTranscript;
  const selectedTranscript = selectedAgentId ? transcripts[selectedAgentId] : undefined;
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;
  const errorsRef = useRef(transcriptErrors);
  errorsRef.current = transcriptErrors;
  const loadingRef = useRef(loadingAgentIds);
  loadingRef.current = loadingAgentIds;
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const selectedAgentStatus = selectedAgent?.status;
  const transcriptError = (selectedAgentId && transcriptErrors[selectedAgentId]) || selectedTranscript?.error;

  useEffect(() => {
    if (!selectedAgentId || !selectedAgentStatus) return;
    onWatchAgent(selectedAgentId);
    let unchangedPolls = 0;
    let previousCursor = transcriptsRef.current[selectedAgentId]?.newSize ?? 0;
    const poll = () => {
      if (errorsRef.current[selectedAgentId] || transcriptsRef.current[selectedAgentId]?.error) {
        clearInterval(timer);
        return;
      }
      if (loadingRef.current.includes(selectedAgentId)) return;
      const cursor = transcriptsRef.current[selectedAgentId]?.newSize ?? 0;
      unchangedPolls = cursor === previousCursor ? unchangedPolls + 1 : 0;
      previousCursor = cursor;
      if (selectedAgentStatus !== "running" && unchangedPolls >= 4) {
        clearInterval(timer);
        return;
      }
      fetchRef.current(selectedAgentId, cursor);
    };
    const timer = setInterval(poll, TRANSCRIPT_POLL_MS);
    poll();
    return () => {
      clearInterval(timer);
      onWatchAgent(null);
    };
  }, [selectedAgentId, selectedAgentStatus, onWatchAgent]);


  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: "600px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <h3>Subagents ({agents.length})</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close subagents">✕</button>
        </div>

        {selectedAgent ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
              <button type="button" className="ghost" style={{ padding: "4px 8px" }} onClick={() => setSelectedAgentId(null)}>← Back</button>
              <h4>{selectedAgent.displayName}</h4>
              <span className={`badge ${selectedAgent.status}`}>{selectedAgent.status}</span>
            </div>

            <div style={{ marginTop: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h5 style={{ marginBottom: "6px" }}>Transcript</h5>
                <button type="button" className="ghost" disabled={loadingAgentIds.includes(selectedAgent.id)} onClick={() => fetchRef.current(selectedAgent.id, selectedTranscript?.newSize ?? 0)}>
                  {loadingAgentIds.includes(selectedAgent.id) ? "Loading…" : "Refresh"}
                </button>
              </div>
              {transcriptError && <p role="alert" style={{ color: "var(--danger)", marginBottom: "8px" }}>{transcriptError}</p>}
              {selectedTranscript ? (
                <pre style={{ maxHeight: "300px", overflowY: "auto" }}><code>{selectedTranscript.text}{selectedTranscript.carry}</code></pre>
              ) : (
                <p role="status" style={{ color: "var(--text-muted)" }}>{loadingAgentIds.includes(selectedAgent.id) ? "Loading transcript…" : "Waiting for transcript…"}</p>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "350px", overflowY: "auto" }}>
            {agents.length === 0 ? (
              <p style={{ color: "var(--text-muted)", textAlign: "center", padding: "20px" }}>No active subagents.</p>
            ) : agents.map((agent) => (
              <button key={agent.id} type="button" className="card" style={{ cursor: "pointer", padding: "12px", marginBottom: "4px", textAlign: "left" }} onClick={() => setSelectedAgentId(agent.id)}>
                <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{agent.displayName}</span>
                  <span className={`badge ${agent.status}`}>{agent.status}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
