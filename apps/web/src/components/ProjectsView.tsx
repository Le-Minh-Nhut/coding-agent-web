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
   * Star bookkeeping, all keyed per project so one project's flight never clears
   * another's:
   * - `seq`/`appliedSeq`: order clicks and their responses; a superseded response
   *   never writes the UI.
   * - `intent`: the desired value of the latest unsettled click. A click while a
   *   request is open re-asserts that intent (double-tap) instead of toggling a
   *   `favorite` prop that may have drifted; released once its response settles.
   */
  const favoriteSeqRef = useRef<Map<string, number>>(new Map());
  const favoriteAppliedSeqRef = useRef<Map<string, number>>(new Map());
  const favoriteIntentRef = useRef<Map<string, { desired: boolean; base: boolean }>>(new Map());
  /** Bumped whenever a favorite response is applied; a list request started before that carries a stale star column. */
  const favoriteEpochRef = useRef(0);
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
    // Drop a superseded snapshot, and a snapshot taken before a favorite settled
    // (its star column is stale and must not revert what the PATCH applied).
    if (seq !== listSeqRef.current || epoch !== favoriteEpochRef.current) return;
    if (res.ok) {
      setProjects(res.data);
    } else {
      setError(res.error.message);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  const handleToggleFavorite = async (e: React.MouseEvent, project: ProjectWithStats) => {
    e.stopPropagation();
    // A click while this project's request is still open re-asserts the same
    // intent (double-tap) instead of toggling a prop a stale list response may
    // have rewound. When nothing is pending the user decides against what they
    // see right now.
    const recorded = favoriteIntentRef.current.get(project.id);
    const desired = recorded && recorded.base === project.favorite ? recorded.desired : !project.favorite;
    const seq = (favoriteSeqRef.current.get(project.id) ?? 0) + 1;
    favoriteSeqRef.current.set(project.id, seq);
    favoriteIntentRef.current.set(project.id, { desired, base: project.favorite });
    const res = await api.updateProject(project.id, { favorite: desired });
    // Only release the intent if no newer click replaced it meanwhile.
    if (favoriteIntentRef.current.get(project.id)?.desired === desired) favoriteIntentRef.current.delete(project.id);
    if (seq <= (favoriteAppliedSeqRef.current.get(project.id) ?? 0)) return;
    favoriteAppliedSeqRef.current.set(project.id, seq);
    if (res.ok) {
      favoriteEpochRef.current++;
      setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, favorite: res.data.favorite } : p)));
    } else setError(res.error.message);
  };

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPath || !newLabel.trim() || creating) return;
    setCreating(true);
    setError(null);

    const token = createOperationRef.current;
    const res = await api.createProject(selectedPath, newLabel.trim());
    // A stale response must not clear the spinner of a newer create form.
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
            <button type="button" onClick={() => setSelectedPath(null)}>
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
            createOperationRef.current = {};
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
