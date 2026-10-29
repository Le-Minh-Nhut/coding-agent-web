import { useState, useEffect, useRef } from "react";
import { api } from "../api.js";
import { FolderBrowser } from "./FolderBrowser.js";
import type { ProjectWithStats } from "@caw/contracts";

interface ProjectsViewProps {
  onSelectProject: (projectId: string) => void;
  onOpenSettings: () => void;
}

export function ProjectsView({ onSelectProject, onOpenSettings }: ProjectsViewProps) {
  const [projects, setProjects] = useState<ProjectWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showBrowser, setShowBrowser] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  /**
   * Star bookkeeping, keyed per project so one project's write never blocks
   * another's: at most one favorite PATCH is in flight per project. Ordering
   * responses on the client cannot order the writes the server applies, so a
   * click while a write is open only records the newest desired value (`pending`)
   * instead of racing a second PATCH that could arrive late and win. When the
   * write settles, a recorded value that still differs from what the server
   * applied is sent once — last intent wins regardless of arrival order.
   */
  const favoriteFlightRef = useRef<Map<string, { desired: boolean; base: boolean; pending: boolean | null }>>(new Map());
  /** Bumped whenever a favorite response is applied; a list request started before that carries a stale star column. */
  const favoriteEpochRef = useRef(0);
  /** Star values actually applied per project, so a stale list snapshot keeps the fresh star column. */
  const favoriteValueRef = useRef<Map<string, boolean>>(new Map());
  /** Orders list requests so an older snapshot cannot replace a newer one. */
  const listSeqRef = useRef(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit / Delete dialogs. Each dialog records the operation token that opened it;
  // a late response may refresh the list, but only closes the dialog it belongs to.
  const [editingProject, setEditingProject] = useState<ProjectWithStats | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const renameOperationRef = useRef<object | null>(null);
  const createOperationRef = useRef<object | null>(null);
  const [deletingProject, setDeletingProject] = useState<ProjectWithStats | null>(null);
  const deleteOperationRef = useRef<object | null>(null);

  const loadProjects = async () => {
    setLoading(true);
    const seq = ++listSeqRef.current;
    const epoch = favoriteEpochRef.current;
    const res = await api.listProjects();
    setLoading(false);
    // Drop a superseded snapshot. A snapshot taken before a favorite settled still
    // carries the rest of the list (create/rename/delete results), so keep it and
    // overlay the star column with the values the favorite path last applied.
    if (seq !== listSeqRef.current) return;
    if (res.ok) {
      setProjects(epoch === favoriteEpochRef.current
        ? res.data
        : res.data.map((p) => ({ ...p, favorite: favoriteValueRef.current.get(p.id) ?? p.favorite })));
    } else {
      setError(res.error.message);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  /**
   * Sends one favorite write, applies its result, then chains the newest intent
   * recorded while it was open. The chain is what makes the last click win on the
   * server: a value the user asked for after this write started cannot be left
   * unsent just because this one settled first.
   */
  const writeFavorite = async (projectId: string, record: { desired: boolean; base: boolean; pending: boolean | null }): Promise<void> => {
    const res = await api.updateProject(projectId, { favorite: record.desired });
    if (res.ok) {
      favoriteEpochRef.current++;
      favoriteValueRef.current.set(projectId, res.data.favorite);
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, favorite: res.data.favorite } : p)));
    } else {
      setError(res.error.message);
    }
    // The newest intent differs from what this write asked for: send exactly one
    // follow-up so the server converges on the user's last click. A double-tap
    // records the value already requested, so it coalesces instead of re-sending.
    // The follow-up is chained even after a failure, so a rejected write never
    // swallows the intent the user expressed while it was open.
    if (record.pending !== null && record.pending !== record.desired) {
      const next = { desired: record.pending, base: record.desired, pending: null as boolean | null };
      favoriteFlightRef.current.set(projectId, next);
      await writeFavorite(projectId, next);
      return;
    }
    favoriteFlightRef.current.delete(projectId);
  };

  const handleToggleFavorite = (e: React.MouseEvent, project: ProjectWithStats) => {
    e.stopPropagation();
    const flight = favoriteFlightRef.current.get(project.id);
    if (flight) {
      // One write per project: never race a second PATCH whose arrival order the
      // server decides. A click while a write is open records the newest intent,
      // re-asserting the intent already in flight for a double-tap on the same
      // displayed value instead of toggling a prop a stale snapshot may have rewound.
      flight.pending = flight.base === project.favorite ? flight.desired : !project.favorite;
      return;
    }
    const record = { desired: !project.favorite, base: project.favorite, pending: null as boolean | null };
    favoriteFlightRef.current.set(project.id, record);
    void writeFavorite(project.id, record);
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPath || !newLabel.trim() || creating) return;
    setCreating(true);
    setError(null);

    // Pending belongs to this form: a fresh token is minted by every way a form
    // opens (Cancel, folder pick), so a response from an abandoned form cannot
    // clear — or fail to clear — the pending of the form on screen now.
    const token = createOperationRef.current;
    const res = await api.createProject(selectedPath, newLabel.trim());
    if (createOperationRef.current === token) setCreating(false);
    if (res.ok) {
      if (createOperationRef.current === token) {
        setSelectedPath(null);
        setNewLabel("");
      }
      loadProjects();
    } else if (createOperationRef.current === token) {
      setError(res.error.message);
    }
  };

  const handleRenameProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProject || !editLabel.trim()) return;
    // The dialog belongs to one operation. A late response may refresh the list,
    // but must not close a dialog opened by a different (newer) rename.
    const token = renameOperationRef.current;
    const res = await api.updateProject(editingProject.id, { label: editLabel.trim() });
    if (res.ok) {
      if (renameOperationRef.current === token) setEditingProject(null);
      loadProjects();
    } else if (renameOperationRef.current === token) {
      setError(res.error.message);
    }
  };

  const handleDeleteProject = async () => {
    if (!deletingProject) return;
    const token = deleteOperationRef.current;
    const res = await api.deleteProject(deletingProject.id);
    if (res.ok) {
      if (deleteOperationRef.current === token) setDeletingProject(null);
      loadProjects();
    } else if (deleteOperationRef.current === token) {
      setError(res.error.message);
    }
  };

  return (
    <div className="view-container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <h2>Projects</h2>
        <div style={{ display: "flex", gap: "8px" }}>
          <button type="button" onClick={() => setShowBrowser(true)} className="primary">
            + New Project
          </button>
          <button type="button" onClick={onOpenSettings} title="Settings">
            ⚙️
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{ color: "var(--danger)", padding: "10px", backgroundColor: "rgba(218,54,51,0.1)", borderRadius: "var(--radius)", marginBottom: "12px" }}>
          {error}
        </div>
      )}

      {/* Selected path prompt to choose a label */}
      {selectedPath && (
        <div className="card" style={{ borderColor: "var(--primary)" }}>
          <h4 style={{ marginBottom: "8px" }}>Create Project</h4>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "10px", wordBreak: "break-all" }}>
            Folder: {selectedPath}
          </p>
          <form onSubmit={handleCreateProject} style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              placeholder="Display label (e.g. My Backend)"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              autoFocus
              required
            />
            <button type="submit" className="primary" disabled={creating}>
              Create
            </button>
            <button
              type="button"
              onClick={() => {
                // Closing the form ends its operation: the next form gets a fresh
                // token and a clean pending flag instead of inheriting this one's.
                createOperationRef.current = {};
                setCreating(false);
                setSelectedPath(null);
              }}
            >
              Cancel
            </button>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)" }}>Loading projects…</div>
      ) : projects.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <p style={{ color: "var(--text-muted)", marginBottom: "16px" }}>No projects added yet.</p>
          <button type="button" className="primary" onClick={() => setShowBrowser(true)}>
            Browse Folders
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {projects
            .sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0))
            .map((project) => (
              <div
                key={project.id}
                className="card"
                style={{ cursor: "pointer", transition: "border-color 0.15s" }}
                onClick={() => onSelectProject(project.id)}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "2px 4px", fontSize: "1.1rem" }}
                      onClick={(e) => handleToggleFavorite(e, project)}
                      title={project.favorite ? "Unstar" : "Star"}
                    >
                      {project.favorite ? "★" : "☆"}
                    </button>
                    <h3 style={{ fontSize: "1.05rem" }}>{project.label}</h3>
                  </div>
                  <div style={{ display: "flex", gap: "4px" }} onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "4px 8px", fontSize: "0.85rem" }}
                      onClick={() => {
                        renameOperationRef.current = {};
                        setEditingProject(project);
                        setEditLabel(project.label);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      style={{ padding: "4px 8px", fontSize: "0.85rem", color: "var(--danger)" }}
                      onClick={() => { deleteOperationRef.current = {}; setDeletingProject(project); }}
                    >
                      Delete
                    </button>
                  </div>
                </div>

                <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", wordBreak: "break-all", marginBottom: "8px" }}>
                  {project.path}
                </p>

                <div style={{ display: "flex", gap: "12px", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  <span>{project.conversationCount} conversation{project.conversationCount === 1 ? "" : "s"}</span>
                  {project.lastActivityAt && (
                    <span>Last active: {new Date(project.lastActivityAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Folder Browser Modal */}
      {showBrowser && (
        <FolderBrowser
          onCancel={() => setShowBrowser(false)}
          onSelect={(path) => {
            setShowBrowser(false);
            // Opening a form for a new folder starts its own operation: it must
            // not inherit the pending of a create form left in flight.
            createOperationRef.current = {};
            setCreating(false);
            setSelectedPath(path);
            const defaultName = path.split("/").filter(Boolean).pop() ?? "New Project";
            setNewLabel(defaultName);
          }}
        />
      )}

      {/* Rename Modal */}
      {editingProject && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginBottom: "12px" }}>Rename Project Label</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "12px" }}>
              Display label only. Renaming never touches the filesystem.
            </p>
            <form onSubmit={handleRenameProject}>
              <input
                type="text"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                autoFocus
                required
                style={{ marginBottom: "16px" }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
                <button type="button" onClick={() => setEditingProject(null)}>Cancel</button>
                <button type="submit" className="primary">Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deletingProject && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginBottom: "12px", color: "var(--danger)" }}>Delete Project</h3>
            <p style={{ marginBottom: "16px", fontSize: "0.95rem" }}>
              Are you sure you want to delete <strong>{deletingProject.label}</strong>?
            </p>
            <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "20px" }}>
              Metadata only, files are untouched.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" onClick={() => setDeletingProject(null)}>Cancel</button>
              <button type="button" className="danger" onClick={handleDeleteProject}>
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
